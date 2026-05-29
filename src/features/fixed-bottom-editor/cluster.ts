/** 功能：为 fixed bottom editor 组装底部固定区域 cluster 实现者：alps 实现日期：2026-05-27 */

import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const FIXED_EDITOR_CURSOR_MARKER = CURSOR_MARKER;

export type FixedEditorClusterInput = {
	/** 原生 status 行，例如 working 动画、todo/status 区域；位于主状态栏上方。 */
	statusLines?: readonly string[];
	/** 输入框上方主状态栏，贴近 editor 上边缘。 */
	topLines?: readonly string[];
	/** 编辑器渲染行。 */
	editorLines?: readonly string[];
	/** 输入框下方次级状态行。 */
	secondaryLines?: readonly string[];
	/** 输入框下方最后一行用户问题。 */
	lastPromptLines?: readonly string[];
	/** 最大可见列宽。 */
	width: number;
	/** cluster 最大行数。 */
	maxHeight: number;
};

export type FixedEditorCursor = {
	/** 光标在输出 cluster 中的行索引。 */
	row: number;
	/** 光标 marker 在原始行中的可见列。 */
	col: number;
};

export type FixedEditorCluster = {
	/** 已移除 cursor marker 且宽度安全的输出行。 */
	lines: string[];
	/** 若输入包含 cursor marker，则返回裁剪后的光标位置。 */
	cursor?: FixedEditorCursor;
};

type ClusterLine = {
	line: string;
	cursorCol?: number;
};

type ClusterSections = {
	status: ClusterLine[];
	top: ClusterLine[];
	editor: ClusterLine[];
	secondary: ClusterLine[];
	lastPrompt: ClusterLine[];
};

/** 组装底部固定区域，负责宽度裁剪、光标提取与高度裁剪。 */
export function renderFixedEditorCluster(input: FixedEditorClusterInput): FixedEditorCluster {
	const width = coerceDimension(input.width);
	const maxHeight = coerceDimension(input.maxHeight);
	if (width <= 0 || maxHeight <= 0) {
		return { lines: [] };
	}

	const sections = collectClusterSections(input, width);
	if (Object.values(sections).every((lines) => lines.length === 0)) {
		return { lines: [] };
	}

	const visibleLines = limitClusterHeight(sections, maxHeight);
	const lines = visibleLines.map((line) => line.line);
	const cursorRow = findCursorLineIndex(visibleLines);
	if (cursorRow === -1) {
		return { lines };
	}

	return {
		lines,
		cursor: {
			row: cursorRow,
			col: visibleLines[cursorRow]!.cursorCol!,
		},
	};
}

/** 将非有限值、负数和小数规整为安全的非负整数尺寸。 */
function coerceDimension(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** 按原版分层收集 cluster：status -> top -> editor -> secondary -> lastPrompt。 */
function collectClusterSections(input: FixedEditorClusterInput, width: number): ClusterSections {
	return {
		status: normalizeLines(input.statusLines, width),
		top: normalizeLines(input.topLines, width),
		editor: normalizeLines(input.editorLines, width),
		secondary: normalizeLines(input.secondaryLines, width),
		lastPrompt: normalizeLines(input.lastPromptLines, width),
	};
}

/** 复制输入行、裁剪宽度并提取光标 marker，避免调用方数组被下游处理意外共享。 */
function normalizeLines(lines: readonly string[] | undefined, width: number): ClusterLine[] {
	return lines
		? [...lines].map((line) => extractCursorMarker(truncateVisibleLine(line, width)))
		: [];
}

/** 提取并移除光标 marker；多余 marker 一并移除，光标采用该行第一个 marker。 */
function extractCursorMarker(line: string): ClusterLine {
	let cleanedLine = line;
	let cursorCol: number | undefined;
	let markerIndex = cleanedLine.indexOf(FIXED_EDITOR_CURSOR_MARKER);
	while (markerIndex !== -1) {
		if (cursorCol === undefined) {
			cursorCol = visibleWidth(cleanedLine.slice(0, markerIndex));
		}
		cleanedLine = cleanedLine.slice(0, markerIndex) + cleanedLine.slice(markerIndex + FIXED_EDITOR_CURSOR_MARKER.length);
		markerIndex = cleanedLine.indexOf(FIXED_EDITOR_CURSOR_MARKER, markerIndex);
	}
	return cursorCol === undefined ? { line: cleanedLine } : { line: cleanedLine, cursorCol };
}

/** 使用 pi-tui 宽度工具裁剪单行，保证 ANSI/CJK/emoji 不会让可见宽度越界。 */
function truncateVisibleLine(line: string, width: number): string {
	return visibleWidth(line) <= width ? line : truncateToWidth(line, width, "", false);
}

/** 高度超限时按原版优先保留 editor，再让 top/status/secondary/lastPrompt 竞争剩余空间。 */
function limitClusterHeight(sections: ClusterSections, maxHeight: number): ClusterLine[] {
	const editor = capEditorLines(sections.editor, maxHeight);
	let remaining = maxHeight - editor.length;

	const top = takeTail(sections.top, remaining);
	remaining -= top.length;

	const secondary = takeTail(sections.secondary, remaining);
	remaining -= secondary.length;

	const lastPrompt = takeTail(sections.lastPrompt, remaining);
	remaining -= lastPrompt.length;

	const status = takeTail(sections.status, remaining);

	return [
		...status,
		...top,
		...editor,
		...secondary,
		...lastPrompt,
	];
}

/** 高度不足时优先保留包含光标的 editor 窗口。 */
function capEditorLines(lines: ClusterLine[], count: number): ClusterLine[] {
	if (count <= 0) return [];
	if (lines.length <= count) return lines;

	const cursorIndex = findCursorLineIndex(lines);
	if (cursorIndex !== -1) {
		const start = Math.max(0, Math.min(cursorIndex - count + 1, lines.length - count));
		return lines.slice(start, start + count);
	}

	return lines.slice(0, count);
}

/** 从尾部取指定行数，用于保留最新 status/widget 信息。 */
function takeTail(lines: ClusterLine[], count: number): ClusterLine[] {
	if (count <= 0) return [];
	return lines.length <= count ? lines : lines.slice(lines.length - count);
}

/** 返回最靠近底部的 cursor marker 行，匹配 pi-tui 从底部扫描光标的行为。 */
function findCursorLineIndex(lines: readonly ClusterLine[]): number {
	for (let index = lines.length - 1; index >= 0; index--) {
		if (lines[index]!.cursorCol !== undefined) {
			return index;
		}
	}
	return -1;
}
