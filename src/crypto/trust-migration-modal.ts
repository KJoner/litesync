import { App, Modal, Notice } from "obsidian";
import {
	advanceAfterProof,
	keepLegacyTrust,
	proveByPassword,
	proveByRewrap,
	StepResult,
	TrustMigrationDeps,
	trustMigrationErrorText,
} from "./trust-migration";

/**
 * 旧「信任此设备」迁移向导（v0.20 / ADR-013）。
 *
 * 只负责交互；每一步的安全判定都在 trust-migration.ts。弹窗关闭（「稍后」）时
 * 什么都不删——状态停在原地，设置页继续显示「旧设备信任待迁移」。
 */
export class TrustMigrationModal extends Modal {
	private busy = false;

	constructor(
		app: App,
		private deps: TrustMigrationDeps,
		private onChanged: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
		this.onChanged();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText("迁移到严格会话解锁");
		const state = this.deps.settings.trustMigration?.state;

		if (state === "recovery_proven" || state === "pending_writes_handled" || state === "clearing") {
			contentEl.createEl("p", { text: "已经确认可以用密码恢复这个仓库。还差最后一步：清理本设备保存的自动解锁材料。" });
			const status = contentEl.createDiv({ cls: "litesync-history-meta" });
			const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
			const btn = footer.createEl("button", { text: "继续完成迁移", cls: "mod-cta" });
			btn.onclick = () => void this.finish(btn, status);
			footer.createEl("button", { text: "稍后" }).onclick = () => this.close();
			return;
		}

		contentEl.createEl("p", {
			text:
				"本设备仍在使用旧版的「信任此设备」：能自动解锁仓库的材料保存在本设备上，" +
				"拿到本设备文件与应用数据的人可能直接解开你的笔记。",
		});
		contentEl.createEl("p", {
			text:
				"新版默认改为严格会话解锁：仓库密码只在本次运行中使用，锁定、切换仓库或重启 Obsidian 后需要重新输入。" +
				"切换前先确认你还能用密码解开这个仓库——迁移不会删除任何笔记，也不会改动同步记录。",
		});
		contentEl.createEl("p", {
			cls: "litesync-history-meta",
			text: "提醒：Obsidian 里已经下载到本地的 Markdown 与附件始终是明文文件，锁定 LiteSync 不会加密它们。",
		});

		// ---- 分支 a：输入密码 ----
		contentEl.createEl("h4", { text: "用仓库密码验证" });
		const pw = contentEl.createEl("input", { type: "password", cls: "litesync-modal-input" });
		pw.setAttribute("autocomplete", "current-password");
		const statusA = contentEl.createDiv({ cls: "litesync-history-meta" });
		const rowA = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		const btnA = rowA.createEl("button", { text: "验证并切换到严格模式", cls: "mod-cta" });
		btnA.onclick = () =>
			void this.run(btnA, statusA, "验证中…", () => proveByPassword(this.deps, pw.value));
		pw.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				pw.blur();
				btnA.click();
			}
		});

		// ---- 分支 b：忘记密码 ----
		const details = contentEl.createEl("details");
		details.createEl("summary", { text: "忘记密码？在本设备上设置新密码" });
		details.createEl("p", {
			cls: "litesync-history-meta",
			text:
				"本设备还能自动解锁，所以可以用它为同一把仓库密钥设置一个新密码（不会生成新密钥，已有笔记照常可读）。" +
				"完成后其他设备需要用新密码解锁。注意：这只是重新包装密钥，不能撤销已经持有旧密码或旧密钥的人。",
		});
		const np1 = details.createEl("input", { type: "password", cls: "litesync-modal-input" });
		np1.setAttribute("autocomplete", "new-password");
		np1.placeholder = "新密码（至少 8 个字符）";
		const np2 = details.createEl("input", { type: "password", cls: "litesync-modal-input" });
		np2.setAttribute("autocomplete", "new-password");
		np2.placeholder = "再次输入";
		const statusB = details.createDiv({ cls: "litesync-history-meta" });
		const rowB = details.createDiv({ cls: "litesync-resolver-footer" });
		const btnB = rowB.createEl("button", { text: "设置新密码并切换" });
		btnB.onclick = () => {
			if (np1.value.length < 8) {
				statusB.setText("密码至少 8 个字符");
				return;
			}
			if (np1.value !== np2.value) {
				statusB.setText("两次输入的密码不一致");
				return;
			}
			void this.run(btnB, statusB, "重新包装中…", () => proveByRewrap(this.deps, np1.value), true);
		};

		// ---- 其他选择 ----
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		footer.createEl("button", { text: "保留本设备自动解锁" }).onclick = () => {
			void (async () => {
				const r = await keepLegacyTrust(this.deps);
				if (r.ok) {
					new Notice("已保留本设备自动解锁（可恢复密钥持久化）。可随时在 设置 → 高级 中关闭。");
					this.close();
				}
			})();
		};
		footer.createEl("button", { text: "稍后" }).onclick = () => this.close();
	}

	private async run(
		btn: HTMLButtonElement,
		status: HTMLElement,
		busyText: string,
		prove: () => Promise<StepResult>,
		rewrapped = false,
	): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const label = btn.getText();
		btn.disabled = true;
		btn.setText(busyText);
		try {
			const r = await prove();
			if (!r.ok) {
				status.setText(trustMigrationErrorText(r.error));
				return;
			}
			if (rewrapped) new Notice("新的仓库密码已生效。其他设备下次请用新密码解锁。", 10000);
			await this.finish(btn, status);
		} finally {
			this.busy = false;
			btn.disabled = false;
			btn.setText(label);
		}
	}

	private async finish(btn: HTMLButtonElement, status: HTMLElement): Promise<void> {
		btn.disabled = true;
		status.setText("正在确认待同步的修改已妥善保存…");
		const r = await advanceAfterProof(this.deps);
		if (!r.ok) {
			status.setText(trustMigrationErrorText(r.error));
			btn.disabled = false;
			return;
		}
		new Notice("已切换到严格会话解锁：本设备不再保存可自动解锁的材料。下次启动需要输入仓库密码。", 10000);
		this.close();
	}
}
