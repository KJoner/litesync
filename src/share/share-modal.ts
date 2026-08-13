/**
 * 分享功能（Phase 17）。
 *
 * 模型：每个分享生成独立随机 Share Key，只加密该分享内容（LSS1）；
 * 服务器只保存密文；Share Key 放在链接 fragment（# 后内容不会发给服务器）。
 * 绝不使用 / 泄露 Vault Master Key。撤销只作用于分享对象，不影响原始 Vault。
 */
import { Modal, Notice, TFile } from "obsidian";
import { ShareEntry } from "../api/client";
import { b64urlEncode, encryptShare, frameShareBundle, randomBytes, ShareAttachment } from "../crypto/crypto";
import { SyncContext } from "../sync/context";
import { requireSyncSafe } from "../sync/gate";

/** 随分享打包的内嵌附件类型（与 Web 端 IMAGE_EXT 一致：只有图片会被内联渲染）。 */
const SHARE_IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
/** 附件总量上限：分享是「一篇笔记」不是「备份通道」，也别撞服务器单对象上限。 */
const SHARE_ATTACHMENT_BUDGET = 64 << 20;

/**
 * 收集笔记内嵌的图片附件（`![[img.png]]` 与 `![](img.png)` 都在 metadataCache
 * 的 embeds 里）。拿不到缓存、目标不存在、超出预算的条目一律跳过——
 * 分享绝不因为一张图挂掉，最多退回「只有文字」的旧行为。
 */
async function collectImageEmbeds(
	ctx: SyncContext,
	notePath: string,
	warn: (msg: string) => void,
): Promise<ShareAttachment[]> {
	const file = ctx.app.vault.getAbstractFileByPath(notePath);
	if (!(file instanceof TFile)) return [];
	const embeds = ctx.app.metadataCache.getFileCache(file)?.embeds ?? [];
	const out: ShareAttachment[] = [];
	const seen = new Set<string>();
	let budget = SHARE_ATTACHMENT_BUDGET;
	for (const emb of embeds) {
		const linkpath = emb.link.split("#")[0].split("|")[0].trim();
		if (linkpath === "") continue;
		const target = ctx.app.metadataCache.getFirstLinkpathDest(linkpath, notePath);
		if (!target || seen.has(target.path) || !SHARE_IMAGE_EXT.test(target.path)) continue;
		seen.add(target.path);
		let data: ArrayBuffer;
		try {
			data = await ctx.app.vault.adapter.readBinary(target.path);
		} catch {
			continue;
		}
		if (data.byteLength > budget) {
			warn(`图片超出分享附件预算，已跳过：${target.path}`);
			continue;
		}
		budget -= data.byteLength;
		out.push({ path: target.path, data });
	}
	return out;
}

function shareUrl(serverUrl: string, id: string, keyB64url: string): string {
	return `${serverUrl.replace(/\/+$/, "")}/share.html#${id}.${keyB64url}`;
}

async function copyText(text: string): Promise<void> {
	await navigator.clipboard.writeText(text);
	new Notice("链接已复制");
}

/** 创建分享。 */
export class ShareModal extends Modal {
	constructor(
		private ctx: SyncContext,
		private serverUrl: string,
		private path: string,
	) {
		super(ctx.app);
	}

	onOpen(): void {
		this.titleEl.setText(`分享 — ${this.path}`);
		const { contentEl } = this;
		contentEl.createEl("p", {
			text: "内容将用独立分享密钥加密后存到服务器；密钥只在链接的 # 片段中，服务器无法解密。",
			cls: "litesync-history-meta",
		});

		contentEl.createDiv({ text: "有效期：" });
		const select = contentEl.createEl("select", { cls: "litesync-share-select" });
		for (const [label, days] of [
			["7 天", 7],
			["30 天", 30],
			["90 天", 90],
			["永久（可随时撤销）", 0],
		] as Array<[string, number]>) {
			const opt = select.createEl("option", { text: label });
			opt.value = String(days);
		}
		select.createEl("option", { text: "自定义…" }).value = "custom";

		// 自定义时长行：数值 + 单位，只在选中「自定义…」时出现。
		// 最小单位是分钟且数值必须 ≥ 1，即天然满足「下限 1 分钟」
		const customRow = contentEl.createDiv({ cls: "litesync-share-custom" });
		const amountInput = customRow.createEl("input", { type: "number", cls: "litesync-share-custom-amount" });
		amountInput.min = "1";
		amountInput.step = "1";
		amountInput.value = "1";
		const unitSelect = customRow.createEl("select", { cls: "litesync-share-select" });
		for (const [label, seconds] of [
			["分钟", 60],
			["小时", 3600],
			["天", 86400],
		] as Array<[string, number]>) {
			const opt = unitSelect.createEl("option", { text: label });
			opt.value = String(seconds);
		}
		customRow.createDiv({
			cls: "litesync-history-meta",
			text: "提醒：到期后密文很快会被服务器回收，回收后无法恢复，只能重新分享。",
		});
		customRow.hide();
		select.onchange = () => customRow.toggle(select.value === "custom");

		const resultEl = contentEl.createDiv();
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		const btn = footer.createEl("button", { text: "创建分享链接", cls: "mod-cta" });

		btn.onclick = async () => {
			btn.disabled = true;
			btn.setText("创建中…");
			try {
				// 统一安全 gate（LS-121-C07）：状态损坏 / 未绑定 / 迁移中 / 未解锁一律拒绝
				requireSyncSafe(this.ctx, "创建分享");
				const adapter = this.ctx.app.vault.adapter;
				if (!(await adapter.stat(this.path))) throw new Error("文件不存在");
				const plain = await adapter.readBinary(this.path);

				const keyRaw = randomBytes(32);
				// §7.4：显示名与内容一起加密。只放文件名（不含目录）——
				// 分享对象本来就不需要知道发送者的目录结构
				const displayName = this.path.slice(this.path.lastIndexOf("/") + 1);
				// T2.4：内嵌图片随分享一起加密打包（LSN2），查看端才有字节可渲染；
				// 服务器仍只见一个密文 blob，附件的数量与名字都在密文里
				const attachments = await collectImageEmbeds(this.ctx, this.path, (m) => new Notice(m));
				const payload = await encryptShare(keyRaw, frameShareBundle(displayName, plain, attachments));
				let expiresAt: number;
				if (select.value === "custom") {
					// 自定义时长：n 必须是正整数（服务器只要求未来时间，校验在这里做）
					const n = Number(amountInput.value);
					if (!Number.isInteger(n) || n <= 0) throw new Error("自定义时长必须是正整数");
					expiresAt = Math.floor(Date.now() / 1000) + n * Number(unitSelect.value);
				} else {
					const days = parseInt(select.value, 10);
					expiresAt = days > 0 ? Math.floor(Date.now() / 1000) + days * 86400 : 0;
				}
				const { id } = await this.ctx.client.createShare(expiresAt, payload);
				const keyB64url = b64urlEncode(keyRaw);
				keyRaw.fill(0);

				this.ctx.store.state.shares[id] = {
					path: this.path,
					keyB64url,
					createdAt: Date.now(),
					expiresAt,
					// 标记显示名已在密文里（§7.4）：没有这个标记的旧分享，
					// 真实路径还留在服务器上，管理界面会提示重建
					nameEncrypted: true,
				};
				await this.ctx.store.save();

				const url = shareUrl(this.serverUrl, id, keyB64url);
				resultEl.empty();
				resultEl.createDiv({ text: "分享链接（含解密密钥，请通过安全渠道发送）：", cls: "litesync-history-meta" });
				const input = resultEl.createEl("input", { type: "text", value: url, cls: "litesync-modal-input" });
				input.readOnly = true;
				input.onclick = () => input.select();
				const row = resultEl.createDiv({ cls: "litesync-resolver-footer" });
				row.createEl("button", { text: "复制链接", cls: "mod-cta" }).onclick = () => void copyText(url);
				btn.setText("已创建 ✓");
			} catch (e) {
				new Notice(`创建分享失败：${e instanceof Error ? e.message : String(e)}`);
				btn.disabled = false;
				btn.setText("创建分享链接");
			}
		};
	}
}

/** 管理分享：列表 / 复制链接 / 撤销。 */
export class ShareManageModal extends Modal {
	constructor(
		private ctx: SyncContext,
		private serverUrl: string,
	) {
		super(ctx.app);
	}

	onOpen(): void {
		this.titleEl.setText("管理分享");
		void this.render();
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.setText("加载中…");
		let shares: ShareEntry[];
		try {
			shares = await this.ctx.client.listShares();
		} catch (e) {
			contentEl.setText(`加载失败：${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		contentEl.empty();
		if (shares.length === 0) {
			contentEl.setText("还没有创建过分享。");
			return;
		}
		const list = contentEl.createDiv({ cls: "litesync-history-list" });
		for (const s of shares) {
			const row = list.createDiv({ cls: "litesync-history-row" });
			const info = row.createDiv({ cls: "litesync-history-info" });
			const title = info.createDiv();
			const local0 = this.ctx.store.state.shares[s.id];
			// 显示名优先取本地记录（真实路径只存在本机）；服务器上的名字
			// 现在只是个随机标签，没有展示价值
			title.createSpan({ cls: "litesync-rev", text: local0?.path ?? s.name ?? s.id.slice(0, 8) });
			if (local0 && local0.nameEncrypted !== true) {
				// §7.4 的旧分享迁移方案：名字改不了（内容已加密且密钥只在链接里），
				// 唯一干净的做法是撤销后重建
				title.createSpan({ cls: "litesync-badge litesync-badge-delete", text: "文件名未加密" });
			}
			if (s.revoked) title.createSpan({ cls: "litesync-badge litesync-badge-delete", text: "已撤销" });
			else if (s.expired) title.createSpan({ cls: "litesync-badge litesync-badge-delete", text: "已过期" });
			else title.createSpan({ cls: "litesync-badge litesync-badge-current", text: "有效" });
			info.createDiv({
				cls: "litesync-history-meta",
				text:
					`创建于 ${new Date(s.createdAt * 1000).toLocaleString()}` +
					(s.expiresAt > 0 ? ` · 到期 ${new Date(s.expiresAt * 1000).toLocaleString()}` : " · 永久"),
			});

			const btns = row.createDiv({ cls: "litesync-history-actions" });
			const local = this.ctx.store.state.shares[s.id];
			if (local && !s.revoked && !s.expired) {
				btns.createEl("button", { text: "复制链接" }).onclick = () =>
					void copyText(shareUrl(this.serverUrl, s.id, local.keyB64url));
			}
			if (!s.revoked) {
				btns.createEl("button", { text: "撤销" }).onclick = async () => {
					try {
						await this.ctx.client.revokeShare(s.id);
						delete this.ctx.store.state.shares[s.id];
						await this.ctx.store.save();
						new Notice("已撤销");
						await this.render();
					} catch (e) {
						new Notice(`撤销失败：${e instanceof Error ? e.message : String(e)}`);
					}
				};
			}
		}
	}
}
