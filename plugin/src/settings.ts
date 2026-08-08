import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type PrivateSyncPlugin from "./main";

export interface PluginSettings {
	serverUrl: string;
	apiToken: string;
	deviceName: string;
	autoSync: boolean;
	/** 定时 pull 间隔（秒），0 表示关闭定时器 */
	syncIntervalSeconds: number;
	syncObsidian: boolean;
	/** 每行一个 Glob 模式 */
	ignorePatterns: string;
	debug: boolean;
	/**
	 * 信任此设备：解锁后把 VMK 用随机设备密钥包装存入 SecretStorage，
	 * 之后启动自动解锁。E2EE 密码本身永远不持久化。
	 */
	trustDevice: boolean;
	/** 设备密钥（base64，拆分包装的一半；另一半在 SecretStorage） */
	deviceKeyB64: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	serverUrl: "",
	apiToken: "", // 仅作为无 SecretStorage 时的降级存储；正常情况下为空，真实值在 SecretStorage
	deviceName: "",
	autoSync: true,
	syncIntervalSeconds: 30,
	syncObsidian: false,
	ignorePatterns: ".trash/**\n.DS_Store\nThumbs.db",
	debug: false,
	trustDevice: true,
	deviceKeyB64: "",
};

export class SyncSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: PrivateSyncPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("服务器").setHeading();

		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("同步服务器地址，例如 https://sync.example.com")
			.addText((text) =>
				text
					.setPlaceholder("https://sync.example.com")
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						this.plugin.settings.serverUrl = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("API Token")
			.setDesc("与服务器 OBSYNC_TOKEN 一致（保存在 Obsidian SecretStorage，不进入 data.json）")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("token")
					.setValue(this.plugin.getApiToken())
					.onChange(async (value) => {
						await this.plugin.setApiToken(value.trim());
					});
			});

		new Setting(containerEl)
			.setName("测试连接")
			.setDesc("验证服务器地址与 Token 是否可用")
			.addButton((btn) =>
				btn.setButtonText("Test Connection").onClick(async () => {
					btn.setDisabled(true);
					try {
						new Notice(await this.plugin.testConnection());
					} finally {
						btn.setDisabled(false);
					}
				}),
			);

		new Setting(containerEl)
			.setName("设备名称")
			.setDesc("用于冲突文件命名和服务器日志，例如 MacBook")
			.addText((text) =>
				text
					.setPlaceholder("MacBook")
					.setValue(this.plugin.settings.deviceName)
					.onChange(async (value) => {
						this.plugin.settings.deviceName = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("同步").setHeading();

		new Setting(containerEl)
			.setName("自动同步")
			.setDesc("文件变化后自动同步（含定时拉取远端变更）")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveSettings();
					this.plugin.applySettings();
				}),
			);

		new Setting(containerEl)
			.setName("同步间隔")
			.setDesc("定时向服务器拉取其他设备产生的变更")
			.addDropdown((dd) =>
				dd
					.addOptions({
						"15": "15 秒",
						"30": "30 秒",
						"60": "60 秒",
						"300": "5 分钟",
						"0": "关闭定时同步",
					})
					.setValue(String(this.plugin.settings.syncIntervalSeconds))
					.onChange(async (value) => {
						this.plugin.settings.syncIntervalSeconds = parseInt(value, 10);
						await this.plugin.saveSettings();
						this.plugin.applySettings();
					}),
			);

		new Setting(containerEl)
			.setName("同步 .obsidian 配置")
			.setDesc("同步 Obsidian 配置目录（workspace 和本插件目录永远不同步）")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncObsidian).onChange(async (value) => {
					this.plugin.settings.syncObsidian = value;
					await this.plugin.saveSettings();
					this.plugin.applySettings();
				}),
			);

		new Setting(containerEl)
			.setName("忽略规则")
			.setDesc("每行一个 Glob 模式；不含 / 的模式按文件名匹配")
			.addTextArea((text) => {
				text.inputEl.rows = 4;
				text.setValue(this.plugin.settings.ignorePatterns).onChange(async (value) => {
					this.plugin.settings.ignorePatterns = value;
					await this.plugin.saveSettings();
					this.plugin.applySettings();
				});
			});

		new Setting(containerEl)
			.setName("立即同步")
			.addButton((btn) =>
				btn
					.setButtonText("Sync Now")
					.setCta()
					.onClick(() => void this.plugin.syncNow()),
			);

		new Setting(containerEl).setName("端到端加密 (E2EE)").setHeading();

		const e2eeStatus = this.plugin.e2eeStatusText();
		new Setting(containerEl)
			.setName("状态")
			.setDesc(e2eeStatus.desc)
			.addButton((btn) => {
				btn.setButtonText(e2eeStatus.action).onClick(async () => {
					await this.plugin.e2eeAction();
					this.display(); // 刷新状态显示
				});
			});

		new Setting(containerEl)
			.setName("信任此设备（保持解锁）")
			.setDesc(
				"解锁后将 Vault Master Key 用随机设备密钥包装存入 Obsidian SecretStorage，" +
					"之后启动自动解锁。E2EE 密码本身永远不会被保存。",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.trustDevice).onChange(async (value) => {
					await this.plugin.setTrustDevice(value);
					this.display();
				}),
			);

		if (this.plugin.hasTrustedDevice()) {
			new Setting(containerEl)
				.setName("忘记此设备")
				.setDesc("删除本设备保存的密钥包装并锁定；下次必须重新输入 E2EE 密码")
				.addButton((btn) =>
					btn.setButtonText("🗑 忘记此设备").onClick(async () => {
						await this.plugin.forgetThisDevice();
						this.display();
					}),
				);
		}

		new Setting(containerEl).setName("调试").setHeading();

		new Setting(containerEl)
			.setName("Debug 日志")
			.setDesc("在开发者控制台输出同步日志")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debug).onChange(async (value) => {
					this.plugin.settings.debug = value;
					await this.plugin.saveSettings();
				}),
			);
	}
}
