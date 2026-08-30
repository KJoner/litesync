import { App, Modal, Platform } from "obsidian";

/**
 * 账户 API Token 独立弹窗（0.19.x iOS 第三方输入法连坐的根治）。
 *
 * Token 密码框**绝不与任何文本框同处一个弹窗**：「文本框 + 密码框」的组合
 * 会触发 WebKit 的登录表单启发式——文本框被当成用户名字段，连坐进 iOS 的
 * 凭据键盘限制（禁第三方输入法），密码管理器自动填充还会把条目的「用户名」
 * 塞进文本框（真机实测：重命名框被填成密码条目名，之后打不出中文）。
 * 单密码框弹窗没有可配对的用户名字段，两个问题一起消失，密码管理器
 * 填充 Token 的工作流保持可用。
 */
export class TokenPromptModal extends Modal {
	constructor(
		app: App,
		private message: string,
		private onSubmit: (token: string) => void,
		/**
		 * 弹窗关闭时回调（在 onSubmit **之前**触发）。调用方用它恢复下层界面：
		 * Obsidian 的弹窗叠在同一个网页文档里，iOS 密码管理器填充会把条目的
		 * 「用户名」塞进文档里**任何**可见文本框（真机实测：下层重命名框被
		 * 填成密码条目名）——打开本弹窗前锁住（readOnly）下层文本框、关闭时
		 * 在这里恢复其原值。
		 */
		private onClosed?: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("输入账户 API Token");
		const { contentEl } = this;
		contentEl.createEl("p", { cls: "litesync-history-meta", text: this.message });
		const input = contentEl.createEl("input", { type: "password", cls: "litesync-modal-input", placeholder: "lsk_…" });
		// iOS：回车 = 确定（软键盘会盖住底部按钮且密码键盘没有收起键）
		input.setAttribute("enterkeyhint", "go");
		const errEl = contentEl.createDiv({ cls: "litesync-history-meta" });
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		const submit = (): void => {
			const t = input.value.trim();
			if (!t) {
				errEl.setText("请输入 API Token（lsk_ 开头）。");
				return;
			}
			input.blur();
			this.close();
			this.onSubmit(t);
		};
		footer.createEl("button", { text: "确定", cls: "mod-cta" }).onclick = submit;
		footer.createEl("button", { text: "取消" }).onclick = () => this.close();
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submit();
		});
		// 移动端不自动聚焦：密码键盘一弹出就盖住界面且无法收起
		if (!Platform.isMobileApp) input.focus();
	}

	onClose(): void {
		this.contentEl.empty();
		this.onClosed?.();
	}
}
