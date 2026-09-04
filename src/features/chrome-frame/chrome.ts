/** 功能：渲染统一消息 chrome box，保证 ANSI/CJK/OSC/image 场景的宽度安全 实现者：alps 实现日期：2026-05-26 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../../terminal-sanitizer.ts";
import { isImageEscapeLine } from "./image.ts";
import { collectBoundaryOscMarkersFromBlankEdges, extractBoundaryOscMarkers, restoreBoundaryOscMarkers } from "./osc.ts";
import { DEFAULT_CONFIG, getChromeLabel, getChromeStyle, type ChromeConfig, type ChromeKind, type ChromeStatus, type ThemeLike } from "./styles.ts";

export type RenderBoxOptions = {
	toolName?: string;
	status?: ChromeStatus;
	config?: ChromeConfig;
	elapsedText?: string;
	tokenText?: string;
	label?: string;
	truncateContent?: boolean;
};

const MIN_FULL_BOX_WIDTH = 8;
const COMPACT_THINKING_BORDER_TOKEN = "borderAccent";

export function padToWidth(line: string, width: number): string {
	const current = visibleWidth(line);
	if (current >= width) return line;
	return line + " ".repeat(width - current);
}

function safeWidth(width: number): number {
	if (!Number.isFinite(width)) return 0;
	return Math.max(0, Math.floor(width));
}

function styleText(theme: ThemeLike, token: string, text: string): string {
	return theme.fg(token, text);
}

function applyLineBackground(_theme: ThemeLike, _bgToken: string, line: string, width: number): string {
	// 完整外框已经提供视觉分组；正文不再铺底色，避免大面积色块和额外 ANSI 输出。
	return padToWidth(line, width);
}

/** 窄宽度 fallback 也属于 terminal 输出边界，必须先净化外部文本再截断。 */
function simpleLines(lines: readonly string[], width: number): string[] {
	const max = safeWidth(width);
	if (max <= 0) return [];
	const raw = lines.length > 0 ? lines : [""];
	return raw
		.flatMap((line) => sanitizeTerminalText(line, { preserveSgr: true }).split("\n"))
		.map((line) => truncateToWidth(line, max, "", false));
}

function buildTopBorder(label: string, width: number, theme: ThemeLike, borderToken: string, labelToken: string, tokenText?: string): string {
	const left = "╭─ ";
	const separator = " ";
	const right = "╮";
	const titleText = tokenText?.trim() ? `${label} ─ ${tokenText.trim()}` : label;
	const labelBudget = Math.max(0, width - visibleWidth(left + separator + right));
	const visibleLabel = truncateToWidth(titleText, labelBudget, "", false);
	const leftBorder = styleText(theme, borderToken, left);
	const styledLabel = styleText(theme, labelToken, visibleLabel);
	const dashCount = Math.max(0, width - visibleWidth(left + visibleLabel + separator + right));
	const rightBorder = styleText(theme, borderToken, separator + "─".repeat(dashCount) + right);
	return leftBorder + styledLabel + rightBorder;
}

function buildCompactThinkingTopBorder(label: string, width: number, theme: ThemeLike, borderToken: string, labelToken: string, options: Pick<RenderBoxOptions, "tokenText">): string {
	return buildTopBorder(label, width, theme, borderToken, labelToken, options.tokenText);
}

function buildCompactThinkingBottomBorder(width: number, theme: ThemeLike, borderToken: string, options: Pick<RenderBoxOptions, "elapsedText">): string {
	return buildBottomBorder(width, theme, borderToken, options.elapsedText);
}

function stripAnsiForContent(line: string): string {
	return stripControlMarkers(line).trim();
}

function firstCompactThinkingLine(lines: readonly string[]): string {
	for (const raw of lines) {
		for (const part of String(raw).split("\n")) {
			const text = stripAnsiForContent(part);
			if (text) return text;
		}
	}
	return "Thinking complete";
}

export function renderCompactThinkingBox(contentLines: readonly string[], width: number, theme: ThemeLike, config: ChromeConfig = DEFAULT_CONFIG, options: Pick<RenderBoxOptions, "elapsedText" | "tokenText"> = {}): string[] {
	const boxWidth = safeWidth(width);
	if (boxWidth < MIN_FULL_BOX_WIDTH) return simpleLines(contentLines, boxWidth);
	const label = "THINK";
	const style = getChromeStyle("thinking", {}, config);
	const borderToken = COMPACT_THINKING_BORDER_TOKEN;
	const innerWidth = Math.max(0, boxWidth - 4);
	const content = truncateToWidth(firstCompactThinkingLine(contentLines), innerWidth, "", false);
	const padded = padToWidth(content, innerWidth);
	return [
		buildCompactThinkingTopBorder(label, boxWidth, theme, borderToken, style.label, options),
		styleText(theme, borderToken, "│") + " " + styleText(theme, borderToken, padded) + " " + styleText(theme, borderToken, "│"),
		buildCompactThinkingBottomBorder(boxWidth, theme, borderToken, options),
	];
}

function buildBottomBorder(width: number, theme: ThemeLike, borderToken: string, elapsedText?: string): string {
	const text = elapsedText?.trim();
	if (!text) {
		return styleText(theme, borderToken, "╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
	}

	// 将消息间隔压到底边右侧；宽度不足时截断文本，优先保持外框闭合。
	const textBudget = Math.max(0, width - visibleWidth("╰  ╯"));
	const visibleText = truncateToWidth(text, textBudget, "", false);
	if (!visibleText) {
		return styleText(theme, borderToken, "╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
	}
	const suffix = ` ${visibleText} `;
	const dashCount = Math.max(0, width - visibleWidth(`╰${suffix}╯`));
	return styleText(theme, borderToken, "╰" + "─".repeat(dashCount) + suffix + "╯");
}

function wrapContentLine(line: string, innerWidth: number, hasImage: boolean): string[] {
	if (hasImage) return [line];
	const wrapped = wrapTextWithAnsi(line, Math.max(1, innerWidth));
	return wrapped.length > 0 ? wrapped : [""];
}

function renderContentLine(line: string, width: number, theme: ThemeLike, borderToken: string, textToken: string): string {
	const innerWidth = Math.max(0, width - 4);
	const clipped = truncateToWidth(line, innerWidth, "", false);
	const padded = padToWidth(clipped, innerWidth);
	return styleText(theme, borderToken, "│") + " " + styleText(theme, textToken, padded) + " " + styleText(theme, borderToken, "│");
}

function stripControlMarkers(line: string): string {
	return sanitizeTerminalText(line, { allowNewline: false, allowTab: false, preserveSgr: false });
}

/** 净化消息正文；image 协议行由既有 image fallback 保护，其它用户/工具正文只保留 SGR。 */
function sanitizeContentLines(lines: readonly string[]): string[] {
	const raw = lines.length > 0 ? lines : [""];
	return raw.map((line) => isImageEscapeLine(line) ? String(line) : sanitizeTerminalText(line, { preserveSgr: true }));
}

function isBlankAfterControlMarkers(line: string): boolean {
	const text = String(line);
	if (!text.includes("\x1b")) return text.trim().length === 0;
	return stripControlMarkers(text).trim().length === 0;
}

/** 只对非 user 普通消息框裁剪边界 padding 空行；正文中间空行保持原样。 */
function shouldTrimBoundaryBlankLines(kind: ChromeKind): boolean {
	return kind === "assistant"
		|| kind === "thinking"
		|| kind === "bash"
		|| kind === "tool"
		|| kind === "toolPending"
		|| kind === "toolSuccess"
		|| kind === "toolError"
		|| kind === "custom"
		|| kind === "skill"
		|| kind === "compaction"
		|| kind === "branch";
}

/** 按可见文本判断边界纯空白；忽略 ANSI/OSC/OSC133 控制序列，不触碰图片行。 */
function trimBoundaryBlankContentLines(kind: ChromeKind, lines: readonly string[]): string[] {
	const normalized = [...lines];
	if (!shouldTrimBoundaryBlankLines(kind)) return normalized;
	while (normalized.length > 0 && !isImageEscapeLine(normalized[0] ?? "") && isBlankAfterControlMarkers(normalized[0] ?? "")) {
		normalized.shift();
	}
	while (normalized.length > 0 && !isImageEscapeLine(normalized.at(-1) ?? "") && isBlankAfterControlMarkers(normalized.at(-1) ?? "")) {
		normalized.pop();
	}
	return normalized;
}

/** 判断普通消息是否没有可见内容；工具类块即使正文为空也保留标题状态。 */
export function isEmptyMessageChrome(kind: ChromeKind, contentLines: readonly string[]): boolean {
	if (kind === "tool" || kind === "toolPending" || kind === "toolSuccess" || kind === "toolError" || kind === "bash" || kind === "working") {
		return false;
	}
	if (contentLines.length === 0) return true;
	return contentLines.every(isBlankAfterControlMarkers);
}

export function renderNeonBox(kind: ChromeKind, contentLines: readonly string[], width: number, theme: ThemeLike, options: RenderBoxOptions = {}): string[] {
	if (isEmptyMessageChrome(kind, contentLines)) return [];
	const boxWidth = safeWidth(width);
	if (boxWidth < MIN_FULL_BOX_WIDTH) {
		return simpleLines(contentLines, boxWidth);
	}

	const markers = collectBoundaryOscMarkersFromBlankEdges(
		extractBoundaryOscMarkers(contentLines.map(String)),
		isBlankAfterControlMarkers,
		isImageEscapeLine,
	);
	const rawLines = sanitizeContentLines(trimBoundaryBlankContentLines(kind, markers.lines));
	if (isEmptyMessageChrome(kind, rawLines)) return [];
	const status = options.status;
	const style = getChromeStyle(kind, { toolName: options.toolName, status }, options.config ?? DEFAULT_CONFIG);
	const label = options.label ?? getChromeLabel(kind, { toolName: options.toolName, status });
	const innerWidth = Math.max(1, boxWidth - 4);

	const lines: string[] = [];
	const pushTextLine = (line: string) => {
		lines.push(applyLineBackground(theme, style.bg, line, boxWidth));
	};
	const pushContentLine = (line: string) => {
		lines.push(line);
	};
	pushTextLine(buildTopBorder(label, boxWidth, theme, style.border, style.label, options.tokenText));
	for (const raw of rawLines) {
		const split = String(raw).split("\n");
		for (const part of split) {
			const partHasImage = isImageEscapeLine(part);
			const wrapped = options.truncateContent && !partHasImage ? [part] : wrapContentLine(part, innerWidth, partHasImage);
			for (const wrappedLine of wrapped) {
				if (partHasImage) {
					pushContentLine(wrappedLine);
				} else {
					pushContentLine(applyLineBackground(theme, style.bg, renderContentLine(wrappedLine, boxWidth, theme, style.border, style.text), boxWidth));
				}
			}
		}
	}
	if (lines.length === 1) {
		pushContentLine(applyLineBackground(theme, style.bg, renderContentLine("", boxWidth, theme, style.border, style.text), boxWidth));
	}
	pushTextLine(buildBottomBorder(boxWidth, theme, style.border, options.elapsedText));

	// OSC133 边界 marker 只挂到外框边界，避免 WezTerm 将内容行行首 marker 解释成额外布局边界。
	return restoreBoundaryOscMarkers(lines, markers, { startIndex: 0, endIndex: lines.length - 1 });
}
