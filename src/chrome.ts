/** 功能：渲染统一消息 chrome box，保证 ANSI/CJK/OSC/image 场景的宽度安全 实现者：alps 实现日期：2026-05-26 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { containsImageLine } from "./image.ts";
import { extractBoundaryOscMarkers, restoreBoundaryOscMarkers } from "./osc.ts";
import { DEFAULT_CONFIG, getChromeLabel, getChromeStyle, type ChromeConfig, type ChromeKind, type ChromeStatus, type ThemeLike } from "./styles.ts";

export type RenderBoxOptions = {
	toolName?: string;
	status?: ChromeStatus;
	config?: ChromeConfig;
};

const MIN_FULL_BOX_WIDTH = 8;

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

function simpleLines(lines: readonly string[], width: number): string[] {
	const max = safeWidth(width);
	if (max <= 0) return [];
	const raw = lines.length > 0 ? lines : [""];
	return raw.flatMap((line) => String(line).split("\n")).map((line) => truncateToWidth(line, max, "", false));
}

function buildTopBorder(label: string, width: number, theme: ThemeLike, borderToken: string, labelToken: string): string {
	const left = "╭─ ";
	const separator = " ";
	const right = "╮";
	const labelBudget = Math.max(0, width - visibleWidth(left + separator + right));
	const visibleLabel = truncateToWidth(label, labelBudget, "", false);
	const leftBorder = styleText(theme, borderToken, left);
	const styledLabel = styleText(theme, labelToken, visibleLabel);
	const dashCount = Math.max(0, width - visibleWidth(left + visibleLabel + separator + right));
	const rightBorder = styleText(theme, borderToken, separator + "─".repeat(dashCount) + right);
	return leftBorder + styledLabel + rightBorder;
}

function buildBottomBorder(width: number, theme: ThemeLike, borderToken: string): string {
	return styleText(theme, borderToken, "╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
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
	return line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "");
}

/** 判断普通消息是否没有可见内容；工具类块即使正文为空也保留标题状态。 */
export function isEmptyMessageChrome(kind: ChromeKind, contentLines: readonly string[]): boolean {
	if (kind === "tool" || kind === "toolPending" || kind === "toolSuccess" || kind === "toolError" || kind === "bash" || kind === "working") {
		return false;
	}
	if (contentLines.length === 0) return true;
	return contentLines.every((line) => stripControlMarkers(String(line)).trim().length === 0);
}

export function renderNeonBox(kind: ChromeKind, contentLines: readonly string[], width: number, theme: ThemeLike, options: RenderBoxOptions = {}): string[] {
	if (isEmptyMessageChrome(kind, contentLines)) return [];
	const boxWidth = safeWidth(width);
	if (boxWidth < MIN_FULL_BOX_WIDTH) {
		return simpleLines(contentLines, boxWidth);
	}

	const markers = extractBoundaryOscMarkers(contentLines.map(String));
	const rawLines = markers.lines.length > 0 ? markers.lines : [""];
	if (isEmptyMessageChrome(kind, rawLines)) return [];
	const status = options.status;
	const style = getChromeStyle(kind, { toolName: options.toolName, status }, options.config ?? DEFAULT_CONFIG);
	const label = getChromeLabel(kind, { toolName: options.toolName, status });
	const innerWidth = Math.max(1, boxWidth - 4);
	const hasImage = containsImageLine(rawLines);

	const lines: string[] = [];
	lines.push(buildTopBorder(label, boxWidth, theme, style.border, style.label));
	for (const raw of rawLines) {
		const split = String(raw).split("\n");
		for (const part of split) {
			const partHasImage = hasImage && containsImageLine([part]);
			const wrapped = wrapContentLine(part, innerWidth, partHasImage);
			for (const wrappedLine of wrapped) {
				if (partHasImage) {
					lines.push(wrappedLine);
				} else {
					lines.push(renderContentLine(wrappedLine, boxWidth, theme, style.border, style.text));
				}
			}
		}
	}
	if (lines.length === 1) {
		lines.push(renderContentLine("", boxWidth, theme, style.border, style.text));
	}
	lines.push(buildBottomBorder(boxWidth, theme, style.border));

	const withBg = lines.map((line) => (containsImageLine([line]) ? line : applyLineBackground(theme, style.bg, line, boxWidth)));
	return restoreBoundaryOscMarkers(withBg, markers);
}
