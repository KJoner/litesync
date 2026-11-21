import { App, Modal, Notice } from "obsidian";
import { SyncContext } from "../sync/context";
import {
	abandonReplaceJob,
	buildReverseJob,
	confirmPhrase,
	confirmReplaceJobChecked,
	jobUnfinished,
	openReplacePermit,
	planReplaceRemote,
	recoveryDir,
	refreshReverseWatermark,
	replaceCapabilities,
	ReplaceJobError,
	ReplaceProgress,
	runReplaceJob,
	saveRecoveryPoint,
} from "./replace-remote";
import { ReplaceAction, ReplaceJob } from "./replace-types";

/** 阶段保护说明（0.20.1）：执行入口关闭时，界面如实说明能做什么、不能做什么。 */
const STAGED_NOTE =
	"「用本地完整替换远端」的执行入口处于验收阶段，默认关闭：这里只能生成只读差异预览。" +
	"需要执行时，先在 设置 → LiteSync → 高级 → 高级恢复 中开启。已经开始的作业仍可诊断、放弃或回滚。";

export interface ReplaceModalOptions {
	/** 在接入向导里（bootstrap 仍 pending）：完成后以 local-replace 完成接入 */
	bootstrapContext: boolean;
	/** 正向执行入口是否开启（0.20.1 阶段保护）；关闭时只读预览 + 诊断 / 放弃 / 回滚 */
	executionEnabled: boolean;
	vaultName: string;
	vaultChoice: string;
	/** 计划前的准备（已接入设备：先等同步收敛、待推送队列排空） */
	beforePlan?: () => Promise<void>;
	/** 执行 / 续跑前的准备（已接入设备：完成一次权威绑定校验，重启后 gate 是 unbound） */
	beforeResume?: () => Promise<void>;
	/** 执行期间冻结普通同步（已接入设备） */
	holdSync: () => void;
	releaseSync: () => void;
	/** 作业 completed 之后（接入向导：完成接入并开始普通同步） */
	onCompleted?: (job: ReplaceJob) => Promise<void>;
}

const LABEL: Record<ReplaceAction, string> = {
	update: "覆盖远端",
	delete: "删除远端",
	create: "新建到远端",
	keep: "两边一致",
	restore: "按恢复点重建",
};

/**
 * 「用本地完整替换远端」向导（0.20 / ADR-016）。所有安全判定在 replace-remote.ts；
 * 这里只负责把预览讲清楚、要求输入仓库名确认、显示进度与结果。
 */
export class ReplaceRemoteModal extends Modal {
	private busy = false;

	constructor(
		app: App,
		private ctx: SyncContext,
		private opts: ReplaceModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("用本地完整替换远端（高级恢复）");
		const job = this.ctx.store.state.replaceJob;
		if (job && jobUnfinished(job)) this.renderResume(job);
		else this.renderIntro(job);
	}

	onClose(): void {
		this.contentEl.empty();
		// 没有未完成的作业就没有理由继续冻结普通同步（releaseSync 幂等；未完成的作业保持冻结，
		// 直到用户续跑、放弃或回滚）
		if (!this.busy && !jobUnfinished(this.ctx.store.state.replaceJob)) this.opts.releaseSync();
	}

	private renderIntro(last: ReplaceJob | null): void {
		const { contentEl } = this;
		contentEl.empty();
		const caps = replaceCapabilities(last, this.opts.executionEnabled);
		contentEl.createEl("p", {
			text:
				"这是高风险的恢复操作：远端仓库会变成本设备同步范围内的样子——内容不同的文件以本地为准覆盖、" +
				"远端多出来的文件被删除（删除留有记录，可从历史恢复）、本地多出来的文件被上传。其他设备下次同步时会收到这些变化。",
		});
		contentEl.createEl("p", {
			cls: "litesync-history-meta",
			text:
				"执行前会：① 生成完整的差异预览；② 要求输入仓库名确认；③ 把将被覆盖或删除的远端原始版本保存到插件目录作为恢复点；" +
				"执行中远端或本地出现预览之外的变化会立即暂停。只想把空仓库初始化成本地内容时，请改用接入向导的「用本地初始化空仓库」。",
		});
		if (!caps.executeForward) contentEl.createEl("p", { cls: "litesync-history-meta", text: STAGED_NOTE });
		const status = contentEl.createDiv({ cls: "litesync-history-meta" });
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		const btn = footer.createEl("button", { text: caps.executeForward ? "生成差异预览" : "生成只读差异预览", cls: "mod-cta" });
		btn.onclick = () => void this.plan(btn, status);
		if (last && caps.reverse) {
			footer.createEl("button", { text: "回滚上一次替换…" }).onclick = () => void this.prepareReverse(last, status);
		}
		footer.createEl("button", { text: "取消" }).onclick = () => this.close();
	}

	private async plan(btn: HTMLButtonElement, status: HTMLElement): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		btn.disabled = true;
		try {
			status.setText("正在等待同步收敛…");
			await this.opts.beforePlan?.();
			const job = await planReplaceRemote(this.ctx, {
				vaultName: this.opts.vaultName,
				vaultChoice: this.opts.vaultChoice,
				bootstrapContext: this.opts.bootstrapContext,
				onProgress: (p) => status.setText(`比较中 ${p.done}/${p.total}：${p.current}`),
			});
			this.renderPreview(job);
		} catch (e) {
			status.setText(`无法生成预览：${e instanceof Error ? e.message : String(e)}`);
			btn.disabled = false;
		} finally {
			this.busy = false;
		}
	}

	private async prepareReverse(job: ReplaceJob, status: HTMLElement): Promise<void> {
		try {
			const rev = buildReverseJob(job, Date.now(), { bootstrapContext: !this.ctx.store.bootstrapReady });
			await refreshReverseWatermark(this.ctx, rev);
			this.renderPreview(rev);
		} catch (e) {
			status.setText(`无法生成回滚：${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private renderPreview(job: ReplaceJob): void {
		const { contentEl } = this;
		contentEl.empty();
		const reverse = job.kind === "reverse";
		contentEl.createEl("p", {
			text: reverse
				? "回滚预览：把远端恢复到上一次替换之前。本设备随后会跟随恢复后的远端；会被替换掉的本地副本先备份到恢复目录。"
				: `差异预览（目标仓库「${job.vaultName || "默认仓库"}」）：`,
		});
		const grid = contentEl.createDiv({ cls: "litesync-plan-counts" });
		const cell = (label: string, n: number): void => {
			const c = grid.createDiv({ cls: "litesync-plan-count" });
			c.createEl("strong", { text: String(n) });
			c.createSpan({ text: label });
		};
		cell(reverse ? "写回旧版本" : "覆盖远端", job.counts.update);
		cell(reverse ? "删除" : "删除远端", job.counts.delete);
		cell(reverse ? "按恢复点重建" : "新建到远端", job.counts.create);
		cell("两边一致", job.counts.keep);
		cell("范围外（不动）", job.counts.outOfScope);

		const list = contentEl.createDiv({ cls: "litesync-plan-list" });
		const shown = job.items.filter((i) => i.action !== "keep");
		if (shown.length === 0) list.setText("两边已经一致，没有需要改动的文件。");
		for (const it of shown.slice(0, 300)) list.createDiv({ text: `${LABEL[it.action]} · ${it.path}` });
		if (shown.length > 300) list.createDiv({ text: `…还有 ${shown.length - 300} 项` });

		if (shown.length === 0) {
			const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
			footer.createEl("button", { text: "关闭", cls: "mod-cta" }).onclick = () => this.close();
			return;
		}
		// 阶段保护：正向执行入口关闭时预览到此为止（只读：没有保存恢复点，也没有写入任何东西）
		if (!reverse && !replaceCapabilities(null, this.opts.executionEnabled).executeForward) {
			contentEl.createEl("p", {
				cls: "litesync-history-meta",
				text: "这是只读预览：没有保存恢复点，也没有写入任何东西。" + STAGED_NOTE,
			});
			const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
			footer.createEl("button", { text: "关闭", cls: "mod-cta" }).onclick = () => this.close();
			return;
		}

		const phrase = confirmPhrase(job);
		contentEl.createEl("p", { text: `确认要执行，请输入「${phrase}」：` });
		const input = contentEl.createEl("input", { type: "text", cls: "litesync-modal-input" });
		input.setAttribute("autocomplete", "off");
		const status = contentEl.createDiv({ cls: "litesync-history-meta" });
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		const btn = footer.createEl("button", { text: "保存恢复点并执行", cls: "mod-warning" });
		btn.disabled = true;
		input.addEventListener("input", () => {
			// 已确认过的作业（中断后续跑）不再受确认短语约束
			btn.disabled = job.state === "planned" && input.value.trim() !== phrase;
		});
		footer.createEl("button", { text: "取消" }).onclick = () => this.close();
		btn.onclick = () => {
			// 已经确认过、执行中断后在同一个窗口里点「继续执行」：这是续跑，不是第二次确认——
			// 与诊断页的「继续执行」完全一样（同一批幂等键，执行许可在 execute 里照样逐项复核）。
			// 以前这里仍走确认，作业已是 interrupted，只会得到「作业状态不允许确认」、原地卡死（WIN-11 真机实测）
			if (job.state !== "planned") {
				void this.execute(job, status, btn);
				return;
			}
			// 确认前复核执行许可（PL-03）：预览之后才出现的停机（完整性、凭据、换连接……）在这里挡住
			const ok = confirmReplaceJobChecked(this.ctx, job, input.value, Date.now());
			if (!ok.ok) {
				status.setText(ok.reason);
				return;
			}
			void this.execute(job, status, btn);
		};
	}

	private renderResume(job: ReplaceJob): void {
		const { contentEl } = this;
		contentEl.empty();
		const caps = replaceCapabilities(job, this.opts.executionEnabled);
		const done = job.items.filter((i) => i.status === "done").length;
		contentEl.createEl("p", {
			text:
				`有一个未完成的${job.kind === "reverse" ? "回滚" : "替换"}作业（已完成 ${done}/${job.items.length} 项）。` +
				"在你继续或放弃之前，普通同步保持暂停。继续执行会沿用同一批幂等键，已完成的不会重复写入。",
		});
		// 诊断：状态、最近一次失败原因、恢复点位置——不管执行入口开没开都如实展示
		const lastError = job.staleReason ?? job.items.find((i) => i.error)?.error;
		contentEl.createEl("p", {
			cls: "litesync-history-meta",
			text:
				`作业状态：${job.state}` +
				(lastError ? `；最近一次中断原因：${lastError}` : "") +
				`；恢复点：${recoveryDir(this.ctx, job.parentJobId ?? job.jobId)}`,
		});
		if (!caps.resume) {
			contentEl.createEl("p", {
				cls: "litesync-history-meta",
				text: "继续执行正向替换需要先在 设置 → 高级 → 高级恢复 中开启（验收阶段）。现在可以放弃它，或回滚已完成的部分。",
			});
		}
		const status = contentEl.createDiv({ cls: "litesync-history-meta" });
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		if (caps.resume) {
			const btn = footer.createEl("button", { text: "继续执行", cls: "mod-cta" });
			btn.onclick = () => void this.execute(job, status, btn);
		}
		if (caps.abandon) {
			footer.createEl("button", { text: "放弃作业" }).onclick = () => {
				void (async () => {
					await abandonReplaceJob(this.ctx, job);
					this.opts.releaseSync();
					new Notice("已放弃作业：已完成的条目保留（可在这里生成回滚），普通同步已恢复。", 10000);
					this.close();
				})();
			};
		}
		if (caps.abandon && caps.reverse) {
			// 放弃后直接进入回滚预览：普通同步继续冻结，免得它在「替换了一半」的状态上推拉；
			// 不确认回滚就关闭窗口时由 onClose 恢复普通同步
			footer.createEl("button", { text: "放弃并回滚已完成的部分…" }).onclick = () => {
				void (async () => {
					await abandonReplaceJob(this.ctx, job);
					await this.prepareReverse(job, status);
				})();
			};
		}
		footer.createEl("button", { text: "关闭" }).onclick = () => this.close();
	}

	private async execute(job: ReplaceJob, status: HTMLElement, btn: HTMLButtonElement): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		btn.disabled = true;
		this.opts.holdSync();
		const show = (p: ReplaceProgress): void => {
			const what = p.phase === "snapshot" ? "保存恢复点" : p.phase === "verify" ? "核对远端变更" : "执行";
			status.setText(p.total ? `${what} ${p.done}/${p.total}${p.current ? `：${p.current}` : ""}` : `${what}…`);
		};
		try {
			await this.opts.beforeResume?.();
			// 执行许可（PL-03）：签发时核对一遍门；之后每个破坏性动作前再核对它没有被收回
			const permit = openReplacePermit(this.ctx, job);
			if (!job.snapshotComplete) await saveRecoveryPoint(this.ctx, job, show, permit);
			const r = await runReplaceJob(this.ctx, job, show, permit);
			if (r.state === "completed") {
				this.opts.releaseSync();
				await this.opts.onCompleted?.(job);
				this.renderDone(job);
				return;
			}
			// paused_stale：作业停住，普通同步恢复（剩余条目不会被自动继续）
			this.opts.releaseSync();
			this.renderStale(job, r.reason ?? "");
		} catch (e) {
			// interrupted / 被执行许可挡下：普通同步保持暂停，直到用户继续、放弃或回滚
			if (e instanceof ReplaceJobError && e.code === "blocked") {
				status.setText(`${e.message}。处理好之后可以继续（已完成的不会重复，恢复点完好）。`);
			} else {
				status.setText(`执行中断（可稍后继续，已完成的不会重复）：${e instanceof Error ? e.message : String(e)}`);
			}
			btn.disabled = false;
			btn.setText("继续执行");
		} finally {
			this.busy = false;
		}
	}

	private renderDone(job: ReplaceJob): void {
		const { contentEl } = this;
		contentEl.empty();
		const c = job.counts;
		contentEl.createEl("p", {
			text:
				job.kind === "reverse"
					? "回滚完成：远端已恢复到替换之前。本设备会在接下来的同步中跟随远端；被替换掉的本地副本已备份。"
					: `替换完成：覆盖 ${c.update}、删除 ${c.delete}、新建 ${c.create}。其他设备下次同步时会收到这些变化。`,
		});
		contentEl.createEl("p", {
			cls: "litesync-history-meta",
			text: `恢复点与备份保存在插件目录：${recoveryDir(this.ctx, job.kind === "reverse" ? job.jobId : job.jobId)}`,
		});
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		if (job.kind === "local-replace-remote") {
			footer.createEl("button", { text: "生成回滚…" }).onclick = () => void this.prepareReverse(job, contentEl.createDiv());
		}
		footer.createEl("button", { text: "关闭", cls: "mod-cta" }).onclick = () => this.close();
	}

	private renderStale(job: ReplaceJob, reason: string): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", { text: "作业已暂停：远端或本地出现了预览之外的变化，继续执行可能覆盖不该覆盖的内容。" });
		contentEl.createEl("p", { cls: "litesync-history-meta", text: reason });
		const done = job.items.filter((i) => i.status === "done").length;
		contentEl.createEl("p", {
			cls: "litesync-history-meta",
			text: `已完成 ${done}/${job.items.length} 项（保留）。请重新生成预览确认剩余差异；也可以回滚已完成的部分。`,
		});
		const status = contentEl.createDiv({ cls: "litesync-history-meta" });
		const footer = contentEl.createDiv({ cls: "litesync-resolver-footer" });
		const again = footer.createEl("button", { text: "重新预览", cls: "mod-cta" });
		again.onclick = () => void this.plan(again, status);
		if (job.kind === "local-replace-remote" && done > 0) {
			footer.createEl("button", { text: "回滚已完成的部分…" }).onclick = () => void this.prepareReverse(job, status);
		}
		footer.createEl("button", { text: "关闭" }).onclick = () => this.close();
	}
}
