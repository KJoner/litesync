import { Modal, Notice } from "obsidian";
import { ConflictError, NotFoundError, VersionEntry } from "../api/client";
import { DiffTooLargeError, diffLinesView } from "../merge/diff";
import { SyncContext } from "../sync/context";
import { uploadFromPlain, versionPlain } from "../sync/transfer";
import { ensureParentFolder } from "../utils/path";
import { decodeUtf8Strict } from "../utils/text";

const ACTION_LABEL: Record<string, string> = {
	upsert: "修改",
	delete: "删除",
	restore: "恢复",
	merge: "合并",
};

function formatTime(unixSeconds: number): string {
	return new Date(unixSeconds * 1000).toLocaleString();
}

function formatSize(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** 版本历史列表（计划书 Phase 13）。 */
export class HistoryModal extends Modal {
	constructor(
		private ctx: SyncContext,
		private path: string,
	) {
		super(ctx.app);
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText(`版本历史 — ${this.path}`);
		this.contentEl.addClass("litesync-history");
		this.contentEl.setText("加载中…");

		let versions: VersionEntry[];
		try {
			versions = await this.ctx.client.history(this.path);
		} catch (e) {
			this.contentEl.setText(`加载历史失败：${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		this.contentEl.empty();
		if (versions.length === 0) {
			this.contentEl.setText("暂无历史版本（服务器未开启历史或文件尚未同步）。");
			return;
		}

		const current = this.ctx.store.get(this.path);
		const list = this.contentEl.createDiv({ cls: "litesync-history-list" });
		for (const v of versions) {
			const row = list.createDiv({ cls: "litesync-history-row" });
			const info = row.createDiv({ cls: "litesync-history-info" });
			const title = info.createDiv();
			title.createSpan({ cls: "litesync-rev", text: `Revision ${v.revision}` });
			title.createSpan({
				cls: `litesync-badge litesync-badge-${v.action}`,
				text: ACTION_LABEL[v.action] ?? v.action,
			});
			if (current && v.revision === current.revision) {
				title.createSpan({ cls: "litesync-badge litesync-badge-current", text: "当前" });
			}
			info.createDiv({
				cls: "litesync-history-meta",
				text:
					`${formatTime(v.createdAt)}` +
					(v.deviceId ? ` · ${v.deviceId.slice(0, 12)}` : "") +
					(v.action !== "delete" ? ` · ${formatSize(v.size)}` : ""),
			});

			if (v.action !== "delete") {
				const btns = row.createDiv({ cls: "litesync-history-actions" });
				btns.createEl("button", { text: "对比" }).onclick = () => void this.compare(v);
				btns.createEl("button", { text: "恢复" }).onclick = () => void this.restore(v);
				btns.createEl("button", { text: "另存副本" }).onclick = () => void this.saveCopy(v);
			}
		}
	}

	private async compare(v: VersionEntry): Promise<void> {
		try {
			const dl = await versionPlain(this.ctx, this.path, v.revision);
			const old = decodeUtf8Strict(dl.plain);
			if (old === null) {
				new Notice("二进制文件不支持文本对比");
				return;
			}
			const adapter = this.ctx.app.vault.adapter;
			let currentText = "";
			if (await adapter.stat(this.path)) {
				const cur = decodeUtf8Strict(await adapter.readBinary(this.path));
				if (cur === null) {
					new Notice("当前文件是二进制，无法文本对比");
					return;
				}
				currentText = cur;
			}
			new DiffModal(this.ctx, this.path, v.revision, old, currentText).open();
		} catch (e) {
			if (e instanceof NotFoundError) new Notice("该版本内容已被服务器清理");
			else if (e instanceof DiffTooLargeError) new Notice("文件差异过大，无法对比");
			else new Notice(`对比失败：${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/**
	 * 恢复历史版本：不回退 HEAD，而是把旧内容作为新 revision 上传（action=restore），
	 * 保持历史线性可追踪（计划书 Phase 13）。
	 */
	private async restore(v: VersionEntry): Promise<void> {
		try {
			const dl = await versionPlain(this.ctx, this.path, v.revision);

			const tracked = this.ctx.store.get(this.path);
			// 该版本内容与当前一致 → 无需产生新 revision（E2EE 下服务器无法自行判断）
			if (tracked && tracked.hash === dl.plainHash) {
				new Notice("该版本内容与当前一致，无需恢复");
				return;
			}
			const out = await uploadFromPlain(
				this.ctx,
				this.path,
				dl.plain,
				tracked?.revision ?? 0,
				dl.mtime || Date.now(),
				"restore",
			);
			const adapter = this.ctx.app.vault.adapter;
			await ensureParentFolder(adapter, this.path);
			await adapter.writeBinary(this.path, dl.plain, dl.mtime > 0 ? { mtime: dl.mtime } : undefined);
			const stat = await adapter.stat(this.path);
			this.ctx.store.set(this.path, {
				hash: dl.plainHash,
				serverHash: out.cipherHash,
				revision: out.revision,
				mtime: stat?.mtime ?? Date.now(),
				size: dl.plain.byteLength,
			});
			await this.ctx.store.save();
			new Notice(`已恢复 Revision ${v.revision} → 新版本 Revision ${out.revision}`);
			this.close();
		} catch (e) {
			if (e instanceof ConflictError) {
				new Notice("本地与服务器不同步，请先 Sync Now 再恢复");
			} else if (e instanceof NotFoundError) {
				new Notice("该版本内容已被服务器清理，无法恢复");
			} else {
				new Notice(`恢复失败：${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}

	private async saveCopy(v: VersionEntry): Promise<void> {
		try {
			const dl = await versionPlain(this.ctx, this.path, v.revision);
			const slash = this.path.lastIndexOf("/");
			const dot = this.path.lastIndexOf(".");
			const hasExt = dot > slash + 1;
			const stem = hasExt ? this.path.slice(0, dot) : this.path;
			const ext = hasExt ? this.path.slice(dot) : "";
			const copyPath = `${stem}.rev-${v.revision}${ext}`;
			const adapter = this.ctx.app.vault.adapter;
			await ensureParentFolder(adapter, copyPath);
			await adapter.writeBinary(copyPath, dl.plain);
			new Notice(`已另存为 ${copyPath}`);
		} catch (e) {
			if (e instanceof NotFoundError) new Notice("该版本内容已被服务器清理");
			else new Notice(`另存失败：${e instanceof Error ? e.message : String(e)}`);
		}
	}
}

/** 历史版本 vs 当前内容的逐行对比视图。 */
class DiffModal extends Modal {
	constructor(
		ctx: SyncContext,
		private path: string,
		private revision: number,
		private oldText: string,
		private newText: string,
	) {
		super(ctx.app);
	}

	onOpen(): void {
		this.titleEl.setText(`Revision ${this.revision} vs 当前 — ${this.path}`);
		this.contentEl.addClass("litesync-diff");
		let lines;
		try {
			lines = diffLinesView(this.oldText, this.newText);
		} catch {
			this.contentEl.setText("文件差异过大，无法对比");
			return;
		}
		const box = this.contentEl.createEl("pre", { cls: "litesync-diff-box" });
		let same = 0;
		for (const line of lines) {
			if (line.type === "same") same++;
			const el = box.createDiv({ cls: `litesync-diff-line litesync-diff-${line.type}` });
			el.setText((line.type === "add" ? "+ " : line.type === "del" ? "- " : "  ") + line.text);
		}
		if (same === lines.length) {
			this.contentEl.createDiv({ text: "两个版本内容相同。" });
		}
	}
}
