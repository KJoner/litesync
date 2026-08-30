import { App, Modal, Notice } from "obsidian";
import { EnableE2eeModal } from "../crypto/e2ee-modals";
import { enableE2eeOnEmptyRemote } from "../crypto/migration";
import { SyncContext } from "../sync/context";
import {
	bootstrapLocalInit,
	bootstrapMerge,
	bootstrapRemoteWins,
	preflight,
	PreflightResult,
} from "./bootstrap-manager";
import { classifyBootstrap, vaultPickerVisible } from "./bootstrap-types";

export interface BootstrapWizardHooks {
	/**
	 * 打开 E2EE 解锁弹窗。传了 onUnlocked 时：解锁弹窗**叠加**在向导上，
	 * 成功后调用 onUnlocked 原地继续（向导不关闭、不从选仓库步重来——
	 * 曾经的「关向导→解锁→重开向导」让用户把选仓库和接入方式各走两遍）；
	 * 不传时保持默认行为（解锁后按 bootstrapReady 重开向导或触发同步）。
	 */
	openUnlock: (onUnlocked?: () => void) => void;
	/** 接入完成：触发一次普通同步 */
	onDone: () => void;
	/** 向导关闭（无论是否完成）：复位单例标志 */
	onClosed: () => void;
	/** 设置目标仓库（v0.19 多仓库）；未提供时不显示仓库选择步 */
	setVaultChoice?: (vaultId: string) => Promise<void>;
	/** 当前的目标仓库选择（settings.vaultChoice；空 = 默认仓库） */
	vaultChoice?: () => string;
	/** 「信任此设备」的当前设置（空远端 E2EE 直通道的弹窗默认值） */
	trustDevice?: () => boolean;
	/** 持久化「信任此设备」（同上） */
	setTrustDevice?: (value: boolean) => Promise<void>;
	/**
	 * 保存账户 API Token（写 SecretStorage，与设置页填写等效）。
	 * 配对导入的设备持设备凭据，切换/新建仓库时在向导内直接补填，
	 * 不必绕去设置页再回来。
	 */
	setApiToken?: (token: string) => Promise<void>;
}

/**
 * 新设备接入向导（v8）。
 * 填完 URL + Token ≠ 可以开始同步：必须先在这里明确本地与远端的关系。
 */
export class BootstrapWizardModal extends Modal {
	private busy = false;

	constructor(
		app: App,
		private ctx: SyncContext,
		private hooks: BootstrapWizardHooks,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("LiteSync 新设备接入");
		this.contentEl.createDiv({ text: "正在检测远端仓库…", cls: "litesync-history-meta" });
		void this.runVaultPicker();
	}

	/**
	 * 选择仓库步（v0.19 单用户多仓库）。
	 *
	 * 服务器支持 vaults 端点时**始终显示**——哪怕名下只有一个仓库（预选它，
	 * 一键继续）：「新建仓库」的唯一入口在这一步，见 vaultPickerVisible 的注释。
	 * 列出名字/文件数/大小，可选任意一个或新建；选择非当前指向的仓库需要
	 * **用户级 Token**（设备凭据绑定单仓库、X-Vault-ID 对它无效——这是刻意的
	 * 最小权限设计），此时提示先在设置里重新填入 API Token。
	 */
	private async runVaultPicker(): Promise<void> {
		let vaults: Awaited<ReturnType<SyncContext["client"]["listVaults"]>> = [];
		let listOk = true;
		try {
			vaults = await this.ctx.client.listVaults();
		} catch {
			// 旧服务器没有该端点：按单仓库处理
			listOk = false;
		}
		if (!vaultPickerVisible(listOk, !!this.hooks.setVaultChoice)) {
			void this.runPreflight();
			return;
		}
		let tokenType = "root";
		try {
			tokenType = (await this.ctx.client.whoami()).tokenType ?? "root";
		} catch {
			/* whoami 失败不阻断：按用户级处理，后续操作自然报错 */
		}

		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", { text: "选择本 Obsidian 库要同步到哪个远端仓库（也可以新建一个）：" });
		let selected = "";
		const list = contentEl.createDiv();
		const fmtBytes = (n: number): string =>
			n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
		const radios: HTMLInputElement[] = [];
		for (const v of vaults) {
			const row = list.createDiv({ cls: "litesync-history-meta" });
			const label = row.createEl("label");
			const radio = label.createEl("input", { type: "radio" });
			radio.name = "litesync-vault-pick";
			radio.value = v.id;
			if (v.current) {
				radio.checked = true;
				selected = v.id;
			}
			radios.push(radio);
			radio.onchange = () => {
				if (radio.checked) selected = v.id;
			};
			label.appendText(
				` ${v.name || v.id}（${v.fileCount} 个文件 · ${fmtBytes(v.bytesUsed)}）` + (v.current ? " · 当前" : ""),
			);
		}
		// 新建仓库（需要用户级 Token）
		const createRow = contentEl.createDiv({ cls: "litesync-history-meta" });
		const createLabel = createRow.createEl("label");
		const createRadio = createLabel.createEl("input", { type: "radio" });
		createRadio.name = "litesync-vault-pick";
		createRadio.value = "__new__";
		radios.push(createRadio);
		createRadio.onchange = () => {
			if (createRadio.checked) selected = "__new__";
		};
		createLabel.appendText(" 新建仓库：");
		const nameInput = createRow.createEl("input", { type: "text", placeholder: "仓库名（1–64 字符）" });
		nameInput.onfocus = () => {
			createRadio.checked = true;
			selected = "__new__";
		};

		const hint = contentEl.createDiv({ cls: "litesync-history-meta" });
		hint.setText("切换仓库会作废本设备的同步记录（本地笔记保留），随后按你选择的方式恢复/合并/初始化。");
		// 账户 Token 补填行（默认隐藏）：配对导入的设备持设备凭据，而切换/新建
		// 仓库是用户级操作（D4 最小权限，服务端硬拒）——在向导内直接补填并
		// 存入 SecretStorage（与设置页填写等效），不逼用户绕去设置页再回来
		const tokenRow = contentEl.createDiv({ cls: "litesync-history-meta" });
		tokenRow.hidden = true;
		tokenRow.createDiv({ text: "账户 API Token（lsk_ 开头；输入后将保存为本设备的凭据）：" });
		const tokenInput = tokenRow.createEl("input", { type: "password", placeholder: "lsk_…" });
		const errEl = contentEl.createDiv({ cls: "litesync-history-meta" });
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		footer.createEl("button", { text: "继续", cls: "mod-cta" }).onclick = () => {
			void (async () => {
				if (!selected) {
					errEl.setText("请选择一个仓库，或新建。");
					return;
				}
				const currentVault = vaults.find((v) => v.current);
				const changing = selected === "__new__" || (currentVault && selected !== currentVault.id);
				if (changing && tokenType === "device") {
					const t = tokenInput.value.trim();
					if (t && this.hooks.setApiToken) {
						await this.hooks.setApiToken(t);
						try {
							tokenType = (await this.ctx.client.whoami()).tokenType ?? "root";
						} catch (e) {
							errEl.setText(`Token 验证失败：${e instanceof Error ? e.message : String(e)}`);
							return;
						}
					}
					if (tokenType === "device") {
						tokenRow.hidden = false;
						errEl.setText(
							t
								? "这个 Token 仍是设备凭据——请粘贴账户的 API Token（lsk_ 开头，可在网页端「账户」页查看指引）。"
								: "切换/新建仓库需要账户的 API Token（本设备持有的是仅绑定单一仓库的设备凭据）。" +
										"在上方输入后再点「继续」即可，无需去设置页。",
						);
						tokenInput.focus();
						return;
					}
					errEl.setText("");
				}
				try {
					let target = selected;
					if (selected === "__new__") {
						const name = nameInput.value.trim();
						if (!name) {
							errEl.setText("请输入新仓库的名字。");
							return;
						}
						target = await this.ctx.client.createVault(name);
					}
					await this.hooks.setVaultChoice?.(target);
					contentEl.empty();
					contentEl.createDiv({ text: "正在检测远端仓库…", cls: "litesync-history-meta" });
					await this.runPreflight();
				} catch (e) {
					errEl.setText(`失败：${e instanceof Error ? e.message : String(e)}`);
				}
			})();
		};
		footer.createEl("button", { text: "稍后再说" }).onclick = () => this.close();
	}

	onClose(): void {
		this.hooks.onClosed();
	}

	private renderE2eeNote(contentEl: HTMLElement): void {
		contentEl.createEl("p", {
			cls: "litesync-history-meta",
			text:
				"新仓库必须启用端到端加密：首次上传就是密文，服务器从头到尾见不到明文。" +
				"密码可以与你其他仓库相同（每个仓库独立加盐派生，互不波及）。",
		});
	}

	/**
	 * 空远端的 E2EE 初始化（唯一路径）。0.19.x 起新仓库**强制 E2EE**：
	 * 明文初始化按钮已移除——「先明文再事后迁移」意味着明文经过服务器
	 * WAL/备份，与新仓库的隐私预期不符；既有明文仓库（远端非空）不受影响。
	 */
	private renderE2eeButton(footer: HTMLElement): void {
		footer.createEl("button", { text: "设置 E2EE 密码并初始化", cls: "mod-cta" }).onclick = () => {
			new EnableE2eeModal(
				this.app,
				this.hooks.trustDevice?.() ?? false,
				async (password, trustDevice) => {
					await enableE2eeOnEmptyRemote(this.ctx, password);
					await this.hooks.setTrustDevice?.(trustDevice);
					// 必须在启用 E2EE 之后重跑 preflight：completeBootstrap 会把 pending
					// binding 里的 keyEpoch 写进正式 binding，用启用前的旧值（0）会产出
					// AAD 错绑的密文（与 main.ts 首次配置三选项同一条约束）
					const fresh = await preflight(this.ctx);
					await bootstrapLocalInit(this.ctx, fresh);
					this.close();
					this.hooks.onDone();
					return 0;
				},
				{
					note: "远端仓库还是空的：设好密码即刻生效，随后的首次上传就是密文——没有迁移过程，明文不会经过服务器。",
					success: () => "端到端加密已启用，正在进行首次同步（全部内容以密文上传）✓",
				},
			).open();
		};
	}

	private async runPreflight(): Promise<void> {
		try {
			const pre = await preflight(this.ctx);
			this.renderChoices(pre);
		} catch (e) {
			const { contentEl } = this;
			contentEl.empty();
			contentEl.createDiv({ text: `无法连接服务器：${e instanceof Error ? e.message : String(e)}` });
			const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
			footer.createEl("button", { text: "重试", cls: "mod-cta" }).onclick = () => {
				contentEl.empty();
				contentEl.createDiv({ text: "正在检测远端仓库…", cls: "litesync-history-meta" });
				void this.runPreflight();
			};
			footer.createEl("button", { text: "稍后再说" }).onclick = () => this.close();
		}
	}

	private renderChoices(pre: PreflightResult): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createDiv({
			cls: "litesync-history-meta",
			text: `远端 ${pre.remoteFiles.length} 个文件 · 本地 ${pre.localPaths.length} 个文件 · 同路径 ${pre.commonCount} 个`,
		});

		// E2EE：先解锁再谈接入（覆盖/合并都需要解密远端内容）。
		// 解锁弹窗叠加在向导上，成功后**原地**重跑 preflight 继续——
		// 仓库已选定，不回选仓库步，接入方式也只需要选一次
		if (pre.e2eeEnabled && this.ctx.e2ee.needsUnlock) {
			contentEl.createEl("p", { text: "此同步仓库已启用端到端加密，接入前需要先解锁。" });
			const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
			footer.createEl("button", { text: "解锁 E2EE…", cls: "mod-cta" }).onclick = () => {
				this.hooks.openUnlock(() => {
					contentEl.empty();
					contentEl.createDiv({ text: "正在检测远端仓库…", cls: "litesync-history-meta" });
					void this.runPreflight();
				});
			};
			footer.createEl("button", { text: "稍后再说" }).onclick = () => this.close();
			return;
		}

		const scenario = classifyBootstrap(pre.localPaths.length, pre.remoteFiles.length);
		const progressEl = contentEl.createDiv({ cls: "litesync-history-meta" });

		const run = async (
			btn: HTMLButtonElement,
			label: string,
			fn: () => Promise<void>,
		): Promise<void> => {
			if (this.busy) return;
			this.busy = true;
			for (const b of Array.from(contentEl.querySelectorAll("button"))) b.disabled = true;
			btn.setText(`${label}中…`);
			try {
				await fn();
				this.close();
				this.hooks.onDone();
			} catch (e) {
				this.busy = false;
				for (const b of Array.from(contentEl.querySelectorAll("button"))) b.disabled = false;
				btn.setText(label);
				progressEl.setText(`失败：${e instanceof Error ? e.message : String(e)}（可重试，已完成部分不会重复处理）`);
			}
		};
		const onProgress = (p: { done: number; total: number; current: string }): void => {
			progressEl.setText(`处理中 ${p.done}/${p.total}：${p.current}`);
		};

		switch (scenario) {
			case "both-empty": {
				contentEl.createEl("p", { text: "本地与远端都是空仓库。设置端到端加密密码后完成初始化。" });
				this.renderE2eeNote(contentEl);
				const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
				this.renderE2eeButton(footer);
				break;
			}
			case "local-only": {
				contentEl.createEl("p", {
					text: `远端是空仓库。设置端到端加密密码后，本设备的 ${pre.localPaths.length} 个文件将以密文上传，作为远端的初始内容。`,
				});
				this.renderE2eeNote(contentEl);
				const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
				this.renderE2eeButton(footer);
				break;
			}
			case "remote-only": {
				contentEl.createEl("p", {
					text: `本地是空仓库。将从远端下载全部 ${pre.remoteFiles.length} 个文件。`,
				});
				const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
				const btn = footer.createEl("button", { text: "从远端恢复此设备", cls: "mod-cta" });
				btn.onclick = () =>
					void run(btn, "恢复", async () => {
						await bootstrapRemoteWins(this.ctx, pre, onProgress);
						new Notice(`已从远端恢复 ${pre.remoteFiles.length} 个文件 ✓`);
					});
				break;
			}
			case "both": {
				contentEl.createEl("p", {
					text: `当前 Vault 已包含 ${pre.localPaths.length} 个文件，远端也已有 ${pre.remoteFiles.length} 个文件。请选择接入方式：`,
				});

				const optA = contentEl.createDiv({ cls: "litesync-hunk" });
				optA.createDiv({ cls: "litesync-hunk-label", text: "从远端恢复，替换本地内容（推荐用于新设备）" });
				optA.createDiv({
					cls: "litesync-history-meta",
					text: "本设备上的同步文件将以远端版本为准；本地不同的内容会先进入回收站，不会永久删除。",
				});
				const btnA = optA.createEl("button", { text: "从远端恢复此设备", cls: "mod-cta" });
				btnA.onclick = () =>
					void run(btnA, "恢复", async () => {
						await bootstrapRemoteWins(this.ctx, pre, onProgress);
						new Notice("已从远端恢复此设备 ✓（被替换的本地内容在回收站）");
					});

				const optB = contentEl.createDiv({ cls: "litesync-hunk" });
				optB.createDiv({ cls: "litesync-hunk-label", text: "保留本地内容，与远端合并" });
				optB.createDiv({
					cls: "litesync-history-meta",
					text: "两边数据都不丢：互补文件互相同步；同路径不同内容的 Markdown 进入冲突解决器，其他文件保留两个版本。",
				});
				const btnB = optB.createEl("button", { text: "与远端合并" });
				btnB.onclick = () =>
					void run(btnB, "合并", async () => {
						const r = await bootstrapMerge(this.ctx, pre, onProgress);
						new Notice(
							`合并完成 ✓ 下载 ${r.downloaded}、上传 ${r.uploaded}` +
								(r.conflicts > 0 ? `、${r.conflicts} 个冲突待处理（见状态栏）` : ""),
							10000,
						);
					});
				break;
			}
		}

		contentEl.createDiv({
			cls: "litesync-history-meta",
			text: "接入完成后将自动进入正常增量同步。",
		});
	}
}
