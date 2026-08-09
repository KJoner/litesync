/**
 * 分享功能（Phase 17）。
 *
 * 模型：每个分享生成独立随机 Share Key，只加密该分享内容（LSS1）；
 * 服务器只保存密文；Share Key 放在链接 fragment（# 后内容不会发给服务器）。
 * 绝不使用 / 泄露 Vault Master Key。撤销只作用于分享对象，不影响原始 Vault。
 */
import { Modal, Notice } from "obsidian";
import { ShareEntry } from "../api/client";
import { b64urlEncode, encryptShare, randomBytes } from "../crypto/crypto";
import { SyncContext } from "../sync/context";

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
		const select = contentEl.createEl("select");
		for (const [label, days] of [
			["7 天", 7],
			["30 天", 30],
			["90 天", 90],
			["永久（可随时撤销）", 0],
		] as Array<[string, number]>) {
			const opt = select.createEl("option", { text: label });
			opt.value = String(days);
		}
		select.style.margin = "6px 0 12px";

		const resultEl = contentEl.createDiv();
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		const btn = footer.createEl("button", { text: "创建分享链接", cls: "mod-cta" });

		btn.onclick = async () => {
			btn.disabled = true;
			btn.setText("创建中…");
			try {
				const adapter = this.ctx.app.vault.adapter;
				if (!(await adapter.stat(this.path))) throw new Error("文件不存在");
				const plain = await adapter.readBinary(this.path);

				const keyRaw = randomBytes(32);
				const payload = await encryptShare(keyRaw, plain);
				const days = parseInt(select.value, 10);
				const expiresAt = days > 0 ? Math.floor(Date.now() / 1000) + days * 86400 : 0;
				const { id } = await this.ctx.client.createShare(this.path, expiresAt, payload);
				const keyB64url = b64urlEncode(keyRaw);
				keyRaw.fill(0);

				this.ctx.store.state.shares[id] = {
					path: this.path,
					keyB64url,
					createdAt: Date.now(),
					expiresAt,
				};
				await this.ctx.store.save();

				const url = shareUrl(this.serverUrl, id, keyB64url);
				resultEl.empty();
				resultEl.createDiv({ text: "分享链接（含解密密钥，请通过安全渠道发送）：", cls: "litesync-history-meta" });
				const input = resultEl.createEl("input", { type: "text", value: url });
				input.style.width = "100%";
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
			title.createSpan({ cls: "litesync-rev", text: s.name || s.id.slice(0, 8) });
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
