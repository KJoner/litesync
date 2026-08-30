// v0.19 单用户多仓库（插件侧）。覆盖：
//   - 绑定指纹包含 vaultChoice：切换目标仓库立即触发重新绑定（unbound），
//     不必等 vaultId 检测（那是第二道防线）；
//   - 旧状态（无 vaultChoice 字段）的绑定被视为未绑定 → 一次无损重新校验。
//
// INV: INV-10（凭据/目标变化必须重新绑定）
import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { window: unknown }).window = globalThis;

import { vaultPickerVisible } from "../src/bootstrap/bootstrap-types";
import { computeBinding, StateStore } from "../src/state/store";

function memAdapter() {
	const files = new Map<string, string>();
	return {
		exists: async (p: string) => files.has(p),
		read: async (p: string) => files.get(p)!,
		write: async (p: string, d: string) => void files.set(p, d),
	} as unknown as ConstructorParameters<typeof StateStore>[0];
}

test("v19: vaultChoice 进入绑定指纹——切换仓库立即失配", async () => {
	const base = { serverUrl: "https://s", apiToken: "t", deviceId: "d", vaultKey: null };
	const a = await computeBinding({ ...base });
	const same = await computeBinding({ ...base, vaultChoice: "" });
	const b = await computeBinding({ ...base, vaultChoice: "v-second" });

	const store = new StateStore(memAdapter(), "state.json");
	await store.load();
	store.setBinding(a);
	assert.equal(store.isBoundTo(same), true, "空 vaultChoice 与省略等价（0.18 升级兼容）");
	assert.equal(store.isBoundTo(b), false, "切换目标仓库必须立即失配触发重新校验");
});

test("v19: 选仓库步在名下仅一个仓库时也必须显示（新建仓库的唯一入口）", () => {
	// 0.19.0 实测缺口：曾按「≤1 个自动跳过」实现，名下只有一个仓库的用户
	// 想把第二个本地库接为新远端仓库时无路可走——向导径直对着默认仓库
	// 对账（要求解锁它的 E2EE、显示它的文件数）。判定必须只看端点可用性
	// 与宿主接线，与仓库数量无关。
	assert.equal(vaultPickerVisible(true, true), true, "单仓库也显示（数量不参与判定）");
	assert.equal(vaultPickerVisible(false, true), false, "旧服务器（listVaults 不可用）→ 跳过");
	assert.equal(vaultPickerVisible(true, false), false, "宿主未接线 setVaultChoice → 跳过");
});

test("v19: 旧版本绑定（无 vaultChoice 字段）读入后视为未绑定", async () => {
	const adapter = memAdapter();
	const s1 = new StateStore(adapter, "state.json");
	await s1.load();
	// 模拟 0.18 存下的四字段指纹
	(s1.state.binding as unknown) = {
		serverUrl: "https://s",
		tokenDigest: "abcd",
		deviceId: "d",
		vaultKeyDigest: "",
	};
	await s1.save();

	const s2 = new StateStore(adapter, "state.json");
	await s2.load();
	assert.equal(s2.binding, null, "缺新字段的旧指纹必须归一为未绑定（触发一次无损重新校验）");
});
