import { App, Modal } from "obsidian";

/**
 * 新手入口（0.20 / 需求 §6.2）：「打开网页注册或登录」。
 *
 * 插件不内置任何身份服务地址——它只知道用户自己的同步服务器。服务器首页就是
 * LiteSync 网页：未登录时给出注册/登录入口，登录后在仓库卡片上「连接 Obsidian」
 * 生成连接链接。还不知道服务器地址时先问一个。
 */
export function websiteUrl(serverUrl: string): string | null {
	const raw = serverUrl.trim();
	if (!raw) return null;
	try {
		const u = new URL(raw);
		const loopback = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(u.hostname);
		if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return null;
		const path = u.pathname.endsWith("/") ? u.pathname : `${u.pathname}/`;
		return `${u.origin}${path}`;
	} catch {
		return null;
	}
}

/**
 * 网页里管理本人设备的页面（UI 焕新 U5，审查 UX-06）：LiteSync 网页「账号与设备」（`<网页>/#/me`），
 * 其中「已授权的设备」用账号会话撤销设备，不需要服务器根 Token。地址由当前服务器地址得出，保留自托管的子路径；
 * 不能用于网页的地址（非 https、本机调试除外）返回 null。
 */
export function deviceManageUrl(serverUrl: string): string | null {
	const site = websiteUrl(serverUrl);
	return site ? `${site}#/me` : null;
}

export class OpenWebsiteModal extends Modal {
	constructor(
		app: App,
		private openUrl: (url: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("打开 LiteSync 网页");
		const { contentEl } = this;
		contentEl.createEl("p", {
			text: "输入你使用的 LiteSync 服务器地址（例如 https://sync.example.com）。网页上可以注册或登录、创建加密仓库，再点「连接 Obsidian」得到连接链接。",
		});
		const input = contentEl.createEl("input", {
			type: "url",
			cls: "litesync-modal-input",
			placeholder: "https://sync.example.com",
		});
		input.setAttribute("autocomplete", "url");
		const errEl = contentEl.createDiv({ cls: "litesync-history-meta" });
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		const go = (): void => {
			const url = websiteUrl(input.value);
			if (!url) {
				errEl.setText("地址必须以 https:// 开头（本机调试可用 http://localhost）");
				return;
			}
			this.close();
			this.openUrl(url);
		};
		footer.createEl("button", { text: "打开", cls: "mod-cta" }).onclick = go;
		footer.createEl("button", { text: "取消" }).onclick = () => this.close();
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				input.blur();
				go();
			}
		});
		window.setTimeout(() => input.focus(), 50);
	}
}
