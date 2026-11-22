import { App, Modal, Notice } from "obsidian";
import { EnableE2eeModal } from "../crypto/e2ee-modals";
import { TokenPromptModal } from "../token-prompt-modal";
import { enableE2eeOnEmptyRemote } from "../crypto/migration";
import { SyncContext } from "../sync/context";
import {
	bootstrapLocalInit,
	bootstrapMerge,
	bootstrapRemoteWins,
	completeBootstrap,
	discardInheritedTrust,
	preflight,
	PreflightResult,
} from "./bootstrap-manager";
import { ReplaceRemoteModal } from "./replace-remote-modal";
import { classifyBootstrap, emptyRemoteInit, linkedVaultToSkip, vaultPickerVisible } from "./bootstrap-types";

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
	/**
	 * 刚兑换的连接链接指定、并在兑换前核对过的仓库（UI 焕新 U5b，P02）：与当前选择、服务器的当前仓库
	 * 一致时跳过选库页（linkedVaultToSkip）。只有兑换后立即打开的这一次向导带它。
	 */
	linkVaultId?: string;
	/** 解锁/启用弹窗里的密钥策略提示（0.20：严格会话解锁 / 显式持久化 / 待迁移） */
	keyNote?: () => string;
	/** 「用本地完整替换远端」的正向执行入口是否开启（0.20.1 阶段保护，默认关闭） */
	replaceRemoteEnabled?: () => boolean;
	/** 继承的可信检查点核验不通过时「重新配对」：打开粘贴连接链接（0.20.1 / PL-06） */
	repairPairing?: () => void;
	/** 拿到密钥之后的回调（用户显式开启了可恢复密钥持久化时写入本设备材料） */
	afterKeyAvailable?: () => Promise<void>;
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
	/** 跳过了选库页时，目标仓库（来自连接链接）：向导顶部注明，并给出「选择其他仓库…」。 */
	private linkVault: { id: string; name: string } | null = null;

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
	private async runVaultPicker(force = false): Promise<void> {
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
		// 连接链接已经指定并核对过仓库：不再问一遍（「选择其他仓库…」回到这里时 force = true）
		const linked = force ? null : linkedVaultToSkip(vaults, this.hooks.linkVaultId, this.hooks.vaultChoice?.());
		if (linked) {
			this.linkVault = { id: linked.id, name: linked.name || linked.id };
			void this.runPreflight();
			return;
		}
		this.linkVault = null;
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
		nameInput.setAttribute("autocomplete", "off");
		nameInput.onfocus = () => {
			createRadio.checked = true;
			selected = "__new__";
		};

		const hint = contentEl.createDiv({ cls: "litesync-history-meta" });
		hint.setText("切换仓库会作废本设备的同步记录（本地笔记保留），随后按你选择的方式恢复/合并/初始化。");
		const errEl = contentEl.createDiv({ cls: "litesync-history-meta" });
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		// iOS：软键盘（尤其密码键盘）会盖住底部按钮且没有收起键——回车键是
		// 唯一出口，必须让它等价于「继续」并顺手收起键盘（0.19.0-rc.1 真机实测）
		const submitOnEnter = (input: HTMLInputElement): void => {
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					input.blur();
					proceed();
				}
			});
		};
		// 账户 Token 补填走**独立弹窗**（TokenPromptModal，叠加在向导上）：
		// 密码框绝不与仓库名文本框同弹窗——「文本框 + 密码框」触发 WebKit
		// 登录表单启发式，文本框被当用户名字段连坐进 iOS 凭据键盘限制，
		// 密码管理器自动填充还会把条目「用户名」塞进文本框（真机实测）。
		// 配对导入的设备持设备凭据，切换/新建是用户级操作（D4 最小权限，
		// 服务端硬拒）——弹窗补填并存入 SecretStorage（与设置页填写等效）。
		const proceed = (): void => {
			void (async () => {
				if (!selected) {
					errEl.setText("请选择一个仓库，或新建。");
					return;
				}
				const currentVault = vaults.find((v) => v.current);
				const changing = selected === "__new__" || (currentVault && selected !== currentVault.id);
				if (changing && tokenType === "device") {
					if (!this.hooks.setApiToken) {
						errEl.setText("切换/新建仓库需要账户的 API Token。请在设置中重新填入后再打开向导。");
						return;
					}
					errEl.setText("切换/新建仓库需要账户的 API Token（本设备持有的是仅绑定单一仓库的设备凭据）。");
					// iOS 密码管理器填充会把条目「用户名」塞进文档里任何可见文本框
					//（重命名弹窗真机实测）——Token 弹窗期间锁住新建仓库名并在
					// 关闭时恢复；proceed 重入时读到的即是恢复后的原值
					const pendingName = nameInput.value;
					nameInput.readOnly = true;
					new TokenPromptModal(
						this.app,
						"切换/新建仓库需要账户的 API Token（lsk_ 开头，可在网页端「账户」页查看指引）。" +
							"输入后将保存为本设备的凭据并继续。",
						(t) => {
							void (async () => {
								await this.hooks.setApiToken?.(t);
								try {
									tokenType = (await this.ctx.client.whoami()).tokenType ?? "root";
								} catch (e) {
									errEl.setText(`Token 验证失败：${e instanceof Error ? e.message : String(e)}`);
									return;
								}
								if (tokenType === "device") {
									errEl.setText("这个 Token 仍是设备凭据——请点「继续」重新粘贴账户的 API Token（lsk_ 开头）。");
									return;
								}
								errEl.setText("");
								proceed();
							})();
						},
						() => {
							nameInput.readOnly = false;
							nameInput.value = pendingName;
						},
					).open();
					return;
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
		footer.createEl("button", { text: "继续", cls: "mod-cta" }).onclick = proceed;
		submitOnEnter(nameInput);
		footer.createEl("button", { text: "稍后再说" }).onclick = () => this.close();
	}

	onClose(): void {
		this.hooks.onClosed();
	}

	/**
	 * 已加密的空远端（预发布实测缺陷，2026-11-22）：用本设备刚解锁的现有密钥接入，不调用 enableE2ee*、不要求新密码。
	 * 本地也空 → 完成接入，不上传任何东西；本地有文件 → 完成接入后由普通同步以 LSE3 密文上传，作为远端的初始内容。
	 * 和「设置仓库密码」那条路一样，完成接入前重跑 preflight：completeBootstrap 写进正式 binding 的 keyEpoch
	 * 必须是解锁之后服务器给的值（用旧值会产出 AAD 错绑的密文）。
	 */
	private renderJoinEncryptedEmpty(
		contentEl: HTMLElement,
		pre: PreflightResult,
		init: "join-encrypted" | "blocked",
		run: (btn: HTMLButtonElement, label: string, fn: () => Promise<void>) => Promise<void>,
	): void {
		const footer = (): HTMLElement => contentEl.createDiv({ cls: "litesync-resolver-footer" });
		if (init === "blocked") {
			contentEl.createEl("p", {
				text:
					"远端仓库的加密状态不完整：服务器报告的加密状态与密钥文档对不上（可能另一台设备启用加密时中断了）。" +
					"为了不写入无法解密的内容，接入已停止，本地和服务器上都没有做任何改动。" +
					"请在启用加密的那台设备上完成操作，或请服务器管理员检查后再打开接入向导。",
			});
			footer().createEl("button", { text: "稍后再说" }).onclick = () => this.close();
			return;
		}
		const n = pre.localPaths.length;
		contentEl.createEl("p", {
			text:
				n === 0
					? "远端是一个已加密的空仓库，本地也没有文件。已经用仓库密码解锁，可以直接完成接入；之后新建的笔记都以密文同步。"
					: `远端是一个已加密的空仓库。已经用仓库密码解锁：完成接入后，本设备的 ${n} 个文件将用这个仓库现有的密钥加密上传，作为远端的初始内容。`,
		});
		contentEl.createEl("p", {
			cls: "litesync-history-meta",
			text: "不需要再设置新密码：这个仓库的密码就是刚才解锁用的那一个。",
		});
		const f = footer();
		const label = n === 0 ? "完成接入" : "上传本机文件（加密）";
		const btn = f.createEl("button", { text: label, cls: "mod-cta" });
		btn.onclick = () =>
			void run(btn, label, async () => {
				const fresh = await preflight(this.ctx);
				const still = emptyRemoteInit({
					keyDocEnabled: fresh.e2eeEnabled,
					encryptionState: fresh.info.encryptionState,
					unlocked: this.ctx.e2ee.unlocked,
					keyEpoch: fresh.info.keyEpoch,
				});
				if (fresh.remoteFiles.length > 0 || still !== "join-encrypted") {
					throw new Error("远端在这期间有了变化（已有文件，或加密状态不同），没有做任何改动；请点「稍后再说」后重新打开接入向导");
				}
				await bootstrapLocalInit(this.ctx, fresh);
				new Notice(n === 0 ? "已接入这个加密仓库 ✓" : `已接入，正在以密文上传 ${n} 个文件 ✓`);
			});
		f.createEl("button", { text: "稍后再说" }).onclick = () => this.close();
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
		footer.createEl("button", { text: "用本地初始化空仓库（设置仓库密码）", cls: "mod-cta" }).onclick = () => {
			new EnableE2eeModal(
				this.app,
				this.hooks.keyNote?.() ?? "",
				async (password) => {
					await enableE2eeOnEmptyRemote(this.ctx, password);
					await this.hooks.afterKeyAvailable?.();
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

	/**
	 * 接入向导里的「用本地完整替换远端」（ADR-016）：作业完成后以 local-replace 模式完成接入。
	 *
	 * 完成接入时**不再**跑 preflight：那会因为账本归属尚未确立而把作业刚建立的跟踪状态
	 * 当成「别的仓库的旧账」整本作废。直接用 /info 与作业记录的计划水位完成接入——
	 * 水位之后的变更已核对全是本作业写入的，普通同步拉到它们时按 serverHash 直接对齐。
	 */
	private async openReplace(pre: PreflightResult): Promise<void> {
		let name = "";
		try {
			name = (await this.ctx.client.listVaults()).find((v) => v.current)?.name ?? "";
		} catch {
			/* 旧服务器：用默认短语确认 */
		}
		new ReplaceRemoteModal(this.app, this.ctx, {
			bootstrapContext: true,
			executionEnabled: this.hooks.replaceRemoteEnabled?.() ?? false,
			vaultName: name,
			vaultChoice: this.hooks.vaultChoice?.() ?? "",
			// 接入向导期间 bootstrap 仍是 pending，普通同步本来就被拦住
			holdSync: () => {},
			releaseSync: () => {},
			onCompleted: async (job) => {
				// 只有正向替换完成才算「以本地完整替换的方式接入」；向导里做完回滚，远端回到了原样、
				// 本地并没有跟上——此时不完成接入，关掉向导让用户重新选择接入方式
				if (job.kind !== "local-replace-remote") {
					this.close();
					return;
				}
				const info = await this.ctx.client.info();
				completeBootstrap(
					this.ctx,
					{
						info,
						snapshotSequence: job.plannedHeadSequence,
						repoEpoch: job.repoEpoch,
						remoteFiles: [],
						localPaths: [],
						commonCount: 0,
						e2eeEnabled: this.ctx.e2ee.enabled,
						// 继承锚在本向导的 preflight 里已核验过（PL-06）；接入完成时据此采纳
						inheritedTrust: pre.inheritedTrust,
					},
					"local-replace",
				);
				await this.ctx.store.save();
				this.close();
				this.hooks.onDone();
			},
		}).open();
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

	/**
	 * 配对继承的可信检查点核验不通过（0.20.1 / 复审 PL-06）：停在这里，一个文件都不写。
	 * 两条出路都要用户明确选择——重新配对（推荐），或读过风险说明后改为首次信任；绝不静默降级。
	 */
	private renderTrustRejected(message: string): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p").createEl("strong", { text: "无法确认服务器上的仓库状态是可信的，接入已停止" });
		contentEl.createEl("p", { text: message });
		contentEl.createEl("p", {
			cls: "litesync-history-meta",
			text:
				"这个连接链接宣称本设备继承发行设备已经验证过的检查点，但服务器现在给出的状态通不过核验。" +
				"为了不把可能被回退或调包的内容当成最新状态写进本设备，接入已停止：本地文件一个都没有动，服务器上也没有写入任何东西。",
		});
		contentEl.createEl("p", { text: "你可以：" });
		const opt1 = contentEl.createDiv({ cls: "litesync-hunk" });
		opt1.createDiv({ cls: "litesync-hunk-label", text: "重新配对（推荐）" });
		opt1.createDiv({
			cls: "litesync-history-meta",
			text: "先在发出链接的那台设备上同步一次、确认它一切正常，再生成新的连接链接导入。网页生成的链接不继承检查点，会如实标为首次信任。",
		});
		const opt2 = contentEl.createDiv({ cls: "litesync-hunk" });
		opt2.createDiv({ cls: "litesync-hunk-label", text: "改为首次信任（明确确认）" });
		opt2.createDiv({
			cls: "litesync-history-meta",
			text:
				"放弃继承的检查点：本设备将信任服务器当前给出的状态，之后的回退检测只从这里开始。" +
				"只在你确定服务器刚做过一次合法的恢复或迁移、而发出链接的设备还没跟上时才这样做。",
		});
		const confirmBox = contentEl.createDiv({ cls: "litesync-history-meta" });
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		if (this.hooks.repairPairing) {
			footer.createEl("button", { text: "粘贴新的连接链接…", cls: "mod-cta" }).onclick = () => {
				this.close();
				this.hooks.repairPairing?.();
			};
		}
		footer.createEl("button", { text: "改为首次信任…" }).onclick = () => {
			confirmBox.empty();
			confirmBox.createDiv({ text: "确认放弃继承的检查点、按首次信任接入吗？这一步不可撤销（之后可以重新配对）。" });
			const yes = confirmBox.createEl("button", { text: "我了解风险，改为首次信任", cls: "mod-warning" });
			yes.onclick = () => {
				void (async () => {
					await discardInheritedTrust(this.ctx);
					contentEl.empty();
					contentEl.createDiv({ text: "正在检测远端仓库…", cls: "litesync-history-meta" });
					await this.runPreflight();
				})();
			};
		};
		footer.createEl("button", { text: "稍后再说" }).onclick = () => this.close();
	}

	private renderChoices(pre: PreflightResult): void {
		const { contentEl } = this;
		contentEl.empty();
		// 配对继承的可信检查点（PL-06）：核验不通过就停在这里，什么都不渲染、什么都不执行
		if (pre.inheritedTrust?.kind === "rejected") {
			this.renderTrustRejected(pre.inheritedTrust.message);
			return;
		}
		if (this.linkVault) {
			// 选库页跳过了：说清楚目标仓库来自哪里，并留一条改选的路（含新建）
			const row = contentEl.createDiv({ cls: "litesync-history-meta litesync-wizard-target" });
			row.appendText(`目标仓库：「${this.linkVault.name}」（来自连接链接，连接前已核对）`);
			const other = row.createEl("button", { text: "选择其他仓库…" });
			other.onclick = () => {
				if (this.busy) return;
				contentEl.empty();
				contentEl.createDiv({ text: "正在读取仓库列表…", cls: "litesync-history-meta" });
				void this.runVaultPicker(true);
			};
		}
		if (pre.inheritedTrust?.kind === "verified") {
			contentEl.createDiv({
				cls: "litesync-history-meta",
				text:
					"已核对继承的检查点：服务器状态不早于发行设备确认过的那一个，检查点链能接上" +
					(pre.inheritedTrust.extended > 0
						? `（之后的 ${pre.inheritedTrust.extended} 份签名检查点也已逐一验证，已确认到位置 ${pre.inheritedTrust.verifiedHead}）。`
						: "。"),
			});
		}

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
			footer.createEl("button", { text: "解锁仓库…", cls: "mod-cta" }).onclick = () => {
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

		// 远端空仓库已经加密（网页「新建仓库 → 创建并加密」，或另一台设备先启用过）：本设备刚用这个仓库的密码解锁，
		// 直接用现有密钥接入——不能再走「设置仓库密码」（enableE2eeOnEmptyRemote 的前置检查必然拒绝，预发布实测的死路）
		if (scenario === "both-empty" || scenario === "local-only") {
			const init = emptyRemoteInit({
				keyDocEnabled: pre.e2eeEnabled,
				encryptionState: pre.info.encryptionState,
				unlocked: this.ctx.e2ee.unlocked,
				keyEpoch: pre.info.keyEpoch,
			});
			if (init !== "set-password") {
				this.renderJoinEncryptedEmpty(contentEl, pre, init, run);
				return;
			}
		}

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
				// 词表（01-UX-PLAN §7）：首次空库是「下载到本机」；灾难恢复的入口才叫恢复
				const btn = footer.createEl("button", { text: "下载到本机", cls: "mod-cta" });
				btn.onclick = () =>
					void run(btn, "下载", async () => {
						await bootstrapRemoteWins(this.ctx, pre, onProgress);
						new Notice(`已下载 ${pre.remoteFiles.length} 个文件到本机 ✓`);
					});
				break;
			}
			case "both": {
				contentEl.createEl("p", {
					text: `当前 Vault 已包含 ${pre.localPaths.length} 个文件，远端也已有 ${pre.remoteFiles.length} 个文件。请选择首次同步方式：`,
				});
				const remoteOnly = pre.remoteFiles.length - pre.commonCount;
				const localOnly = pre.localPaths.length - pre.commonCount;

				// ① 合并（推荐默认，UI 规格 D03）：两边都不丢
				const optB = contentEl.createDiv({ cls: "litesync-hunk" });
				optB.createDiv({ cls: "litesync-hunk-label", text: "合并本地与远端（推荐）" });
				optB.createDiv({
					cls: "litesync-history-meta",
					text:
						`两边数据都不丢：远端独有的 ${remoteOnly} 个下载到本地、本地独有的 ${localOnly} 个上传；` +
						`同路径的 ${pre.commonCount} 个内容相同即直接对齐，不同的 Markdown 进入冲突解决器（没有共同祖先时不强行合并），其他文件保留两个版本。`,
				});
				const btnB = optB.createEl("button", { text: "合并本地与远端", cls: "mod-cta" });
				btnB.onclick = () =>
					void run(btnB, "合并", async () => {
						const r = await bootstrapMerge(this.ctx, pre, onProgress);
						new Notice(
							`合并完成 ✓ 下载 ${r.downloaded}、上传 ${r.uploaded}` +
								(r.conflicts > 0 ? `、${r.conflicts} 个冲突待处理（见状态栏）` : ""),
							10000,
						);
					});

				// ② 远端替换本地
				const optA = contentEl.createDiv({ cls: "litesync-hunk" });
				optA.createDiv({ cls: "litesync-hunk-label", text: "从远端恢复本地（远端替换本地）" });
				optA.createDiv({
					cls: "litesync-history-meta",
					text:
						`本设备的同步范围以远端为准：下载远端独有的 ${remoteOnly} 个；同路径的 ${pre.commonCount} 个中内容不同的以远端覆盖；` +
						`本地独有的 ${localOnly} 个移除。被覆盖或移除的本地文件先进入回收站（Obsidian 的 .trash 或系统回收站），回收失败就保留并停止，不会永久删除。`,
				});
				const btnA = optA.createEl("button", { text: "从远端恢复此设备" });
				btnA.onclick = () =>
					void run(btnA, "恢复", async () => {
						await bootstrapRemoteWins(this.ctx, pre, onProgress);
						new Notice("已从远端恢复此设备 ✓（被替换的本地内容在回收站）");
					});

				// ③ 本地替换远端：高级恢复作业（ADR-016），与「初始化空仓库」分开命名。
				// 0.20.1 阶段保护：执行入口默认关闭——关闭时这里只给只读预览；
				// 本向导里留下的未完成作业照常可以诊断、放弃或回滚
				const optC = contentEl.createDiv({ cls: "litesync-hunk" });
				const unfinished = this.ctx.store.state.replaceJob;
				const pendingJob =
					unfinished !== null && unfinished.bootstrapContext && unfinished.state !== "completed" && unfinished.state !== "abandoned";
				const enabled = this.hooks.replaceRemoteEnabled?.() ?? false;
				optC.createDiv({
					cls: "litesync-hunk-label",
					text: enabled ? "用本地完整替换远端（高级恢复，高风险）" : "用本地完整替换远端（验收阶段，默认关闭）",
				});
				optC.createDiv({
					cls: "litesync-history-meta",
					text: enabled
						? "远端变成本设备的样子：不同的被本地覆盖、远端多出来的被删除（留有删除记录）。会先生成完整差异预览、" +
							"保存远端原始版本作为恢复点，并要求输入仓库名确认；其他设备下次同步会收到这些变化。"
						: "这个破坏性操作仍在验收中，执行入口默认关闭（设置 → 高级 → 高级恢复 可开启）。现在可以先看一份只读差异预览，" +
							"不保存、不写入任何东西。",
				});
				const btnC = optC.createEl("button", {
					text: pendingJob ? "查看未完成的替换作业…" : enabled ? "预览本地替换远端…" : "只读预览差异…",
				});
				btnC.onclick = () => void this.openReplace(pre);
				break;
			}
		}

		contentEl.createDiv({
			cls: "litesync-history-meta",
			text: "接入完成后将自动进入正常增量同步。",
		});
	}
}
