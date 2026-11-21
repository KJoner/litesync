import { App, Modal, Notice } from "obsidian";
import { MigrationProgress } from "./migration";

/**
 * 解锁弹窗：输入仓库密码。onSubmit 返回错误信息或 null（成功）。
 *
 * 0.20（ADR-013）起不再有「信任此设备」勾选框：新安装默认严格会话解锁，
 * 「可恢复密钥持久化」只能在高级设置里**显式**开启。keyNote 由调用方按当前策略
 * 生成，告诉用户这次解锁会不会在本设备留下可自动还原密钥的材料。
 *
 * 0.20.1（复审 PL-01）：关闭弹窗 = 取消这次解锁。onSubmit 拿到 isCancelled，
 * 进行中的 PBKDF2 晚到时据此作废，钥匙不会在用户已经放弃之后被悄悄装上。
 */
export class UnlockModal extends Modal {
	private busy = false;
	private cancelled = false;

	constructor(
		app: App,
		private keyNote: string,
		private onSubmit: (password: string, isCancelled: () => boolean) => Promise<string | null>,
	) {
		super(app);
	}

	onClose(): void {
		this.cancelled = true;
		this.contentEl.empty();
	}

	onOpen(): void {
		this.titleEl.setText("解锁仓库");
		const { contentEl } = this;
		contentEl.createDiv({ text: "输入这个仓库的密码（端到端加密）以解锁同步。密码只在内存中使用，不会被保存。" });
		const input = contentEl.createEl("input", { type: "password", cls: "litesync-modal-input" });
		input.setAttribute("autocomplete", "current-password");
		contentEl.createDiv({ cls: "litesync-history-meta", text: this.keyNote });

		const errorEl = contentEl.createDiv({ cls: "litesync-history-meta" });
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		const btn = footer.createEl("button", { text: "解锁", cls: "mod-cta" });

		const submit = async () => {
			if (this.busy) return;
			this.busy = true;
			btn.setText("解锁中…");
			btn.disabled = true;
			try {
				const err = await this.onSubmit(input.value, () => this.cancelled);
				if (this.cancelled) return; // 窗口已关闭：结果已被作废，不再更新界面
				if (err === null) {
					this.close();
					return;
				}
				errorEl.setText(err);
			} finally {
				this.busy = false;
				btn.setText("解锁");
				btn.disabled = false;
			}
		};
		btn.onclick = () => void submit();
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				// iOS：回车提交并收起软键盘（底部按钮可能被键盘挡住）
				input.blur();
				void submit();
			}
		});
		window.setTimeout(() => input.focus(), 50);
	}
}

/** 启用 E2EE 弹窗：设置仓库密码 + 执行迁移（或空仓直接启用）。 */
export class EnableE2eeModal extends Modal {
	private busy = false;

	constructor(
		app: App,
		private keyNote: string,
		private onEnable: (password: string, onProgress: (p: MigrationProgress) => void) => Promise<number>,
		/** 场景化文案（如首次配置的空仓启用——那时没有迁移，默认文案会说谎） */
		private copy?: { note?: string; success?: (migrated: number) => string },
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("启用端到端加密 (E2EE)");
		const { contentEl } = this;
		const warn = contentEl.createDiv();
		warn.createEl("p", {
			text: "启用后所有笔记在上传前于本设备加密，服务器只保存密文。",
		});
		const strong = warn.createEl("p");
		strong.createEl("strong", {
			text: "⚠️ 仓库密码与账号登录密码无关，丢失后服务器上的数据将永远无法恢复——重置账号密码也找不回它。",
		});
		warn.createEl("p", {
			text:
				this.copy?.note ??
				"迁移过程会把当前所有文件重新加密上传，并在验证密文后清理服务器上的明文历史。请确保其他设备此刻不在同步。",
		});

		contentEl.createDiv({ text: "设置仓库密码（至少 8 个字符）：" });
		const pw1 = contentEl.createEl("input", { type: "password", cls: "litesync-modal-input" });
		pw1.setAttribute("autocomplete", "new-password");
		contentEl.createDiv({ text: "再次输入确认：" });
		const pw2 = contentEl.createEl("input", { type: "password", cls: "litesync-modal-input" });
		pw2.setAttribute("autocomplete", "new-password");
		contentEl.createDiv({ cls: "litesync-history-meta", text: this.keyNote });

		const progressEl = contentEl.createDiv({ cls: "litesync-history-meta" });
		const errorEl = contentEl.createDiv({ cls: "litesync-history-meta" });

		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		const btn = footer.createEl("button", { text: "开始加密迁移", cls: "mod-cta" });
		footer.createEl("button", { text: "取消" }).onclick = () => this.close();
		// 回车流转：pw1 → pw2 → 提交（iOS 软键盘会盖住底部按钮且密码键盘无法收起，
		// 回车是唯一出口；提交前先 blur 收起键盘）
		pw1.addEventListener("keydown", (e) => {
			if (e.key === "Enter") pw2.focus();
		});
		pw2.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				pw2.blur();
				btn.click();
			}
		});

		btn.onclick = async () => {
			if (this.busy) return;
			errorEl.setText("");
			if (pw1.value.length < 8) {
				errorEl.setText("密码至少 8 个字符");
				return;
			}
			if (pw1.value !== pw2.value) {
				errorEl.setText("两次输入的密码不一致");
				return;
			}
			this.busy = true;
			btn.disabled = true;
			btn.setText("迁移中…");
			try {
				const migrated = await this.onEnable(pw1.value, (p) => {
					progressEl.setText(`加密迁移中 ${p.done}/${p.total}：${p.current}`);
				});
				new Notice(this.copy?.success?.(migrated) ?? `端到端加密已启用，共迁移 ${migrated} 个文件 ✓`, 10000);
				this.close();
			} catch (e) {
				errorEl.setText(
					`迁移失败：${e instanceof Error ? e.message : String(e)}（可重新执行，已加密的文件会自动跳过）`,
				);
				this.busy = false;
				btn.disabled = false;
				btn.setText("重新开始加密迁移");
			}
		};
	}
}
