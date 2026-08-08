/** 三方合并的输入/输出模型（计划书 Phase 14）。 */

export interface MergeInput {
	base: string;
	local: string;
	remote: string;
}

export interface MergeConflict {
	id: string;

	/** base 行区间 [baseStart, baseEnd)，纯插入时二者相等 */
	baseStart: number;
	baseEnd: number;

	baseText: string;
	localText: string;
	remoteText: string;
}

/** 合并结果的分段表示：稳定文本段与冲突段交替出现，供 Resolver UI 使用。 */
export type MergeSegment =
	| { type: "text"; text: string }
	| { type: "conflict"; conflict: MergeConflict };

export interface MergeResult {
	clean: boolean;
	/**
	 * clean 时为最终合并文本；
	 * 有冲突时为“冲突处取 local”的预览文本（绝不自动写入 Vault，
	 * 也绝不输出 <<<<<<< 之类的 conflict marker）。
	 */
	mergedText: string;
	conflicts: MergeConflict[];
	segments: MergeSegment[];
}
