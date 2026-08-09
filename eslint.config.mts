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
);
