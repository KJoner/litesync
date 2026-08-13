import { App, Modal, Notice } from "obsidian";
import { MigrationProgress } from "./migration";

/** 解锁弹窗：输入 E2EE 密码 + 是否信任此设备。onSubmit 返回错误信息或 null（成功）。 */
export class UnlockModal extends Modal {
	private busy = false;

	constructor(
		app: App,
		private defaultTrust: boolean,
		private onSubmit: (password: string, trustDevice: boolean) => Promise<string | null>,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("解锁端到端加密");
		const { contentEl } = this;
		contentEl.createDiv({ text: "输入 E2EE 密码以解锁同步（密码只在内存中使用，不会被保存）。" });
		const input = contentEl.createEl("input", { type: "password", cls: "litesync-modal-input" });

		const trustLabel = contentEl.createEl("label", { cls: "litesync-trust-label" });
		const trustBox = trustLabel.createEl("input", { type: "checkbox" });
		trustBox.checked = this.defaultTrust;
		trustLabel.appendText(" 信任此设备（之后启动自动解锁）");

		const errorEl = contentEl.createDiv({ cls: "litesync-history-meta" });
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		const btn = footer.createEl("button", { text: "解锁", cls: "mod-cta" });

		const submit = async () => {
			if (this.busy) return;
			this.busy = true;
			btn.setText("解锁中…");
			btn.disabled = true;
			try {
				const err = await this.onSubmit(input.value, trustBox.checked);
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
			if (e.key === "Enter") void submit();
		});
		window.setTimeout(() => input.focus(), 50);
	}
}

/** 启用 E2EE 弹窗：设置密码 + 是否信任此设备 + 执行迁移。 */
export class EnableE2eeModal extends Modal {
	private busy = false;

	constructor(
		app: App,
		private defaultTrust: boolean,
		private onEnable: (
			password: string,
			trustDevice: boolean,
			onProgress: (p: MigrationProgress) => void,
		) => Promise<number>,
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
			text: "⚠️ 密码一旦丢失，服务器上的数据将永远无法恢复；本版本不支持关闭 E2EE 或修改密码。",
		});
		warn.createEl("p", {
			text:
				this.copy?.note ??
				"迁移过程会把当前所有文件重新加密上传，并在验证密文后清理服务器上的明文历史。请确保其他设备此刻不在同步。",
		});

		contentEl.createDiv({ text: "设置 E2EE 密码（至少 8 个字符）：" });
		const pw1 = contentEl.createEl("input", { type: "password", cls: "litesync-modal-input" });
		contentEl.createDiv({ text: "再次输入确认：" });
		const pw2 = contentEl.createEl("input", { type: "password", cls: "litesync-modal-input" });

		const trustLabel = contentEl.createEl("label", { cls: "litesync-trust-label" });
		const trustBox = trustLabel.createEl("input", { type: "checkbox" });
		trustBox.checked = this.defaultTrust;
		trustLabel.appendText(" 信任此设备（之后启动自动解锁）");

		const progressEl = contentEl.createDiv({ cls: "litesync-history-meta" });
		const errorEl = contentEl.createDiv({ cls: "litesync-history-meta" });

		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		const btn = footer.createEl("button", { text: "开始加密迁移", cls: "mod-cta" });
		footer.createEl("button", { text: "取消" }).onclick = () => this.close();

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
				const migrated = await this.onEnable(pw1.value, trustBox.checked, (p) => {
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
