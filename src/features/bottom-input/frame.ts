/** 功能：为固定底部输入框渲染完整线框，实现者：alps 实现日期：2026-05-29 */

import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../../terminal-sanitizer.ts";
import type { ThemeLike } from "../chrome-frame/styles.ts";
import type { BottomInputFrameStatus } from "./status.ts";

export type BeautifiedEditorFrameInput = {
	/** 原始 editor 渲染行。 */
	editorLines: readonly string[];
	/** 输入框总宽度。 */
	width: number;
	/** 当前主题。 */
	theme: ThemeLike;
	/** 边框内嵌状态。 */
	status: BottomInputFrameStatus;
};

export const MIN_FRAME_WIDTH = 8;
const FIXED_EDITOR_CURSOR_MARKER = CURSOR_MARKER;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 包装 editor 行为完整输入框线框；宽度不足时回退原始行，避免异常。 */
export function renderBeautifiedEditorFrame(input: BeautifiedEditorFrameInput): string[] {
	const width = Number.isFinite(input.width) ? Math.max(0, Math.floor(input.width)) : 0;
	if (width < MIN_FRAME_WIDTH) return [...input.editorLines];
	const editorLines = input.editorLines.length > 0 ? [...input.editorLines] : [""];
	return [
		buildTopBorder(width, input.theme, input.status),
		...editorLines.map((line) => renderContentLine(line, width, input.theme)),
		buildBottomBorder(width, input.theme, input.status.elapsed),
	];
}

function buildTopBorder(width: number, theme: ThemeLike, status: BottomInputFrameStatus): string {
	const leftLabel = joinStyledSegments([status.model, status.thinking], safeFg(theme, "borderMuted", " · "));
	const rightLabel = status.context ?? "";
	return buildBorderLine({
		width,
		theme,
		leftCorner: "╭",
		rightCorner: "╮",
		leftLabel,
		rightLabel,
	});
}

function buildBottomBorder(width: number, theme: ThemeLike, elapsed: string | null): string {
	return buildBorderLine({
		width,
		theme,
		leftCorner: "╰",
		rightCorner: "╯",
		rightLabel: elapsed?.trim() || "",
	});
}

function buildBorderLine(input: { width: number; theme: ThemeLike; leftCorner: string; rightCorner: string; leftLabel?: string; rightLabel?: string }): string {
	const { width, theme, leftCorner, rightCorner } = input;
	const safeWidth = Math.max(2, width);
	const innerBudget = Math.max(0, safeWidth - 2);
	let leftLabel = fitStatusLabel(input.leftLabel ?? "", Math.max(0, Math.floor(innerBudget * 0.45) - 2));
	let rightLabel = fitStatusLabel(input.rightLabel ?? "", Math.max(0, innerBudget - visibleWidth(labelPart(leftLabel)) - 2));

	// 线框必须始终闭合；窄宽度下优先裁剪右侧状态，再裁剪左侧状态，最后才省略状态。
	for (let guard = 0; guard < 6 && visibleWidth(labelPart(leftLabel)) + visibleWidth(labelPart(rightLabel)) > innerBudget; guard += 1) {
		const overflow = visibleWidth(labelPart(leftLabel)) + visibleWidth(labelPart(rightLabel)) - innerBudget;
		if (rightLabel) {
			rightLabel = fitStatusLabel(rightLabel, Math.max(0, visibleWidth(rightLabel) - overflow));
		} else if (leftLabel) {
			leftLabel = fitStatusLabel(leftLabel, Math.max(0, visibleWidth(leftLabel) - overflow));
		}
	}
	if (visibleWidth(labelPart(leftLabel)) + visibleWidth(labelPart(rightLabel)) > innerBudget) rightLabel = "";
	if (visibleWidth(labelPart(leftLabel)) + visibleWidth(labelPart(rightLabel)) > innerBudget) leftLabel = "";
	return composeBorderLine(theme, leftCorner, rightCorner, leftLabel, rightLabel, innerBudget);
}

function labelPart(label: string): string {
	return label ? ` ${label} ` : "";
}

function composeBorderLine(theme: ThemeLike, leftCorner: string, rightCorner: string, leftLabel: string, rightLabel: string, innerBudget: number): string {
	const leftPart = labelPart(leftLabel);
	const rightPart = labelPart(rightLabel);
	const dashCount = Math.max(0, innerBudget - visibleWidth(leftPart) - visibleWidth(rightPart));
	return styleBorder(theme, leftCorner) + leftPart + styleBorder(theme, "─".repeat(dashCount)) + rightPart + styleBorder(theme, rightCorner);
}

function fitStatusLabel(label: string, maxWidth: number): string {
	if (!label || maxWidth <= 0) return "";
	if (visibleWidth(label) <= maxWidth) return label;
	const plain = stripAnsi(label);
	return truncateToWidth(plain, maxWidth, "…", false);
}

function renderContentLine(line: string, width: number, theme: ThemeLike): string {
	const innerWidth = Math.max(0, width - 4);
	const safeLine = sanitizeEditorLine(line);
	const clipped = closeOpenAnsiCodes(truncateEditorLinePreservingCursor(safeLine, innerWidth));
	const padded = padToWidth(clipped, innerWidth);
	return styleBorder(theme, "│") + " " + padded + " " + styleBorder(theme, "│");
}

function sanitizeEditorLine(line: string): string {
	const placeholder = "\uE000ALPS_CURSOR\uE000";
	const withPlaceholder = String(line).split(FIXED_EDITOR_CURSOR_MARKER).join(placeholder);
	return sanitizeTerminalText(withPlaceholder, { allowNewline: false, allowTab: true, preserveSgr: true }).split(placeholder).join(FIXED_EDITOR_CURSOR_MARKER);
}

function truncateEditorLinePreservingCursor(line: string, width: number): string {
	if (width <= 0) return line.includes(FIXED_EDITOR_CURSOR_MARKER) ? FIXED_EDITOR_CURSOR_MARKER : "";
	if (!line.includes(FIXED_EDITOR_CURSOR_MARKER)) return truncateToWidth(line, width, "", false);
	const markerIndex = line.indexOf(FIXED_EDITOR_CURSOR_MARKER);
	const beforeCursor = line.slice(0, markerIndex);
	const afterCursor = line.slice(markerIndex + FIXED_EDITOR_CURSOR_MARKER.length);
	const beforeWidth = visibleWidth(beforeCursor);
	const totalWidth = beforeWidth + visibleWidth(afterCursor);
	if (totalWidth <= width) return line;

	// 宽度不足时用 pi-tui 的列切片保留 grapheme/ANSI 完整性；marker 自身零宽，不占内容预算。
	const startCol = Math.max(0, beforeWidth - Math.max(0, width - 1));
	const before = sliceVisibleColumns(beforeCursor, startCol, beforeWidth - startCol);
	const remaining = Math.max(0, width - visibleWidth(before));
	const after = sliceVisibleColumns(afterCursor, 0, remaining);
	return `${before}${FIXED_EDITOR_CURSOR_MARKER}${after}`;
}

function closeOpenAnsiCodes(line: string): string {
	// 内容含 SGR 时统一重置，避免裁剪后输入颜色泄漏到 padding 或右边框。
	return containsSgr(line) ? `${line}\x1b[0m` : line;
}

function containsSgr(line: string): boolean {
	for (let index = 0; index < line.length;) {
		const ansi = extractAnsiSequence(line, index);
		if (!ansi) {
			index += 1;
			continue;
		}
		if (ansi.code.startsWith("\x1b[") && ansi.code.endsWith("m")) return true;
		index += ansi.length;
	}
	return false;
}

/** 按终端可见列截取内容，保留允许的 SGR 与 grapheme 的完整性。 */
function sliceVisibleColumns(line: string, startCol: number, length: number): string {
	if (length <= 0) return "";
	const endCol = startCol + length;
	let result = "";
	let currentCol = 0;
	let pendingAnsi = "";
	for (let index = 0; index < line.length;) {
		const ansi = extractAnsiSequence(line, index);
		if (ansi) {
			if (currentCol >= startCol && currentCol < endCol) {
				result += ansi.code;
			} else if (currentCol < startCol) {
				pendingAnsi += ansi.code;
			}
			index += ansi.length;
			continue;
		}

		let textEnd = index;
		while (textEnd < line.length && !extractAnsiSequence(line, textEnd)) textEnd += 1;
		for (const { segment } of segmenter.segment(line.slice(index, textEnd))) {
			const segmentWidth = visibleWidth(segment);
			const inRange = currentCol >= startCol && currentCol < endCol;
			const fits = currentCol + segmentWidth <= endCol;
			if (inRange && fits) {
				if (pendingAnsi) {
					result += pendingAnsi;
					pendingAnsi = "";
				}
				result += segment;
			}
			currentCol += segmentWidth;
			if (currentCol >= endCol) break;
		}
		index = textEnd;
		if (currentCol >= endCol) break;
	}
	return result;
}

/** 解析常见 ANSI/OSC/APC 序列；用于本文件内安全列切片，不依赖 pi-tui 私有导出。 */
function extractAnsiSequence(line: string, index: number): { code: string; length: number } | null {
	if (line[index] !== "\x1b") return null;
	const next = line[index + 1];
	if (next === "[") {
		for (let end = index + 2; end < line.length; end += 1) {
			const code = line.charCodeAt(end);
			if (code >= 0x40 && code <= 0x7e) return { code: line.slice(index, end + 1), length: end + 1 - index };
		}
		return null;
	}
	if (next === "]" || next === "_" || next === "P" || next === "^") {
		for (let end = index + 2; end < line.length; end += 1) {
			if (line[end] === "\x07") return { code: line.slice(index, end + 1), length: end + 1 - index };
			if (line[end] === "\x1b" && line[end + 1] === "\\") return { code: line.slice(index, end + 2), length: end + 2 - index };
		}
	}
	return null;
}

function padToWidth(line: string, width: number): string {
	const current = visibleWidth(line);
	return current >= width ? line : line + " ".repeat(width - current);
}

function joinStyledSegments(segments: Array<string | null>, separator: string): string {
	return segments.filter((segment): segment is string => Boolean(segment)).join(separator);
}

function styleBorder(theme: ThemeLike, text: string): string {
	return safeFg(theme, "mdCode", text, "border");
}

function safeFg(theme: ThemeLike, token: string, text: string, fallback = "text"): string {
	try {
		return theme.fg(token, text);
	} catch {
		try {
			return theme.fg(fallback, text);
		} catch {
			return text;
		}
	}
}

function stripAnsi(input: string): string {
	return sanitizeTerminalText(input, { allowNewline: false, allowTab: false, preserveSgr: false });
}
