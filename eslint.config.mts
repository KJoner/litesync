// 与 Obsidian 官方 obsidian-sample-plugin 保持一致的 ESLint 配置：
// eslint-plugin-obsidianmd recommended（社区审核机器人使用的同一套规则）。
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores, defineConfig } from "eslint/config";

export default defineConfig(
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"versions.json",
		"main.js",
		"package.json",
		"package-lock.json",
		"tsconfig.json",
		// 本仓库特有：Node 构建/测试脚本与测试产物不属于插件 runtime 代码
		"scripts",
		"tests",
		".test-build",
		"docs",
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mts", "manifest.json"],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".json"],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// v0.13.2 §6.11：同步业务代码禁止直接构造/覆盖 FileState。
		// 裸 `store.set()` 会把 fileId / generation / metaGeneration / serverPseudonym
		// 一起抹掉（LS-121-C04 就是这么产生的），必须走具名转换。
		// StateStore 自身是这些转换的实现处，因此豁免。
		files: ["src/**/*.ts"],
		ignores: ["src/state/store.ts"],
		rules: {
			"no-restricted-syntax": [
				"error",
				{
					selector: "MemberExpression[property.name='set'][object.property.name='store']",
					message:
						"禁止直接调用 store.set()（§6.11）。请使用具名转换：replaceWithNewObject / patchContentState / applyRemoteIdentity / applyMetaRenameState / markDeleted / restoreObject / recordConflict。",
				},
				{
					selector: "CallExpression[callee.property.name='writeBinary']",
					message:
						"禁止直接写入 Vault 文件（§6.1）。请通过 LocalCommitter（writeIfLocalUnchanged / ctx.committer.commitRemoteChange）提交，否则会绕过防覆盖前置检查。",
				},
			],
		},
	},
	{
		// LocalCommitter 本身就是那个唯一入口，它必须能直接写盘
		files: ["src/sync/local-commit.ts"],
		rules: { "no-restricted-syntax": "off" },
	},
);
