/** 功能：为 fixed bottom editor 组装底部固定区域 cluster 实现者：alps 实现日期：2026-05-27 */

import * as PiTui from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const FALLBACK_CURSOR_MARKER = "\x1b_pi:c\x07";

/** 兼容旧版 pi-tui：若未导出 CURSOR_MARKER，则使用当前 APC 协议值。 */
export const FIXED_EDITOR_CURSOR_MARKER =
	typeof (PiTui as { CURSOR_MARKER?: unknown }).CURSOR_MARKER === "string"
		? (PiTui as { CURSOR_MARKER: string }).CURSOR_MARKER
		: FALLBACK_CURSOR_MARKER;

export type FixedEditorClusterInput = {
	/** 编辑器渲染行。 */
	editorLines?: readonly string[];
	/** 状态行，位于编辑器上方。 */
	statusLines?: readonly string[];
	/** 页脚行，位于编辑器下方。 */
	footerLines?: readonly string[];
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

/** 组装底部固定区域，负责宽度裁剪、光标提取与高度裁剪。 */
export function renderFixedEditorCluster(input: FixedEditorClusterInput): FixedEditorCluster {
	const width = coerceDimension(input.width);
	const maxHeight = coerceDimension(input.maxHeight);
	if (width <= 0 || maxHeight <= 0) {
		return { lines: [] };
	}

	const collectedLines = collectClusterLines(input).map((line) => ({
		...line,
		line: truncateVisibleLine(line.line, width),
	}));
	if (collectedLines.length === 0) {
		return { lines: [] };
	}

	const visibleLines = limitClusterHeight(collectedLines, maxHeight);
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

/** 按 status -> editor -> footer 的自上而下顺序收集 cluster 行。 */
function collectClusterLines(input: FixedEditorClusterInput): ClusterLine[] {
	return [
		...normalizeLines(input.statusLines),
		...normalizeLines(input.editorLines),
		...normalizeLines(input.footerLines),
	].map(extractCursorMarker);
}

/** 复制输入行，避免调用方数组被后续处理意外共享。 */
function normalizeLines(lines: readonly string[] | undefined): string[] {
	return lines ? [...lines] : [];
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

/** 高度超限时保留包含光标的窗口；没有光标时保留底部最新区域。 */
function limitClusterHeight(lines: ClusterLine[], maxHeight: number): ClusterLine[] {
	if (lines.length <= maxHeight) {
		return lines;
	}

	const cursorIndex = findCursorLineIndex(lines);
	if (cursorIndex === -1) {
		return lines.slice(lines.length - maxHeight);
	}

	const rowsBeforeCursor = Math.floor((maxHeight - 1) / 2);
	const lastStart = lines.length - maxHeight;
	const start = Math.max(0, Math.min(cursorIndex - rowsBeforeCursor, lastStart));
	return lines.slice(start, start + maxHeight);
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
