/** 功能：chrome-frame 渲染诊断 JSONL 日志；默认关闭且不影响渲染 实现者：alps 实现日期：2026-05-31 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { isImageEscapeLine } from "./image.ts";
import type { ChromeKind } from "./styles.ts";

export type ChromeFrameDebugBranch =
	| "normal"
	| "fallback"
	| "narrowFallback"
	| "imageFallback"
	| "imageSuppressed"
	| "compactThinking"
	| "cacheHit"
	| "empty"
	| "errorFallback";

export type ChromeFrameDebugOptions = {
	targetId: string;
	targetKind: ChromeKind;
	inputWidth: number;
	resolvedFrameWidth: number;
	innerWidth?: number | null;
	originalLineCount?: number | null;
	displayedLineCount?: number | null;
	boxedLineCount?: number | null;
	branch: ChromeFrameDebugBranch;
	cacheKeySummary?: string | null;
	hasImageLine?: boolean;
	usesCompactThinking?: boolean;
	error?: string;
	lines: readonly string[];
};

type ControlSummary = {
	osc133: number;
	osc: number;
	csi: number;
	sgr: number;
	dcs: number;
	apc: number;
	pm: number;
};

const PREVIEW_LIMIT = 24;
const TAIL_CODEPOINT_LIMIT = 10;
const OSC133_PATTERN = /\x1b\]133;[A-Z](?:\x07|\x1b\\)/g;
const OSC_PATTERN = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const SGR_PATTERN = /\x1b\[[0-9;:]*m/g;
const DCS_PATTERN = /\x1bP[\s\S]*?(?:\x07|\x1b\\)/g;
const APC_PATTERN = /\x1b_[\s\S]*?(?:\x07|\x1b\\)/g;
const PM_PATTERN = /\x1b\^[\s\S]*?(?:\x07|\x1b\\)/g;
const C0_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
let sequence = 0;

export function isChromeFrameDebugEnabled(): boolean {
	const logPath = process.env.ALPS_PI_FRAME_DEBUG_LOG?.trim();
	return Boolean(logPath && isAbsolute(logPath));
}

function countMatches(input: string, pattern: RegExp): number {
	pattern.lastIndex = 0;
	let count = 0;
	while (pattern.exec(input)) count += 1;
	return count;
}

function summarizeControls(input: string): ControlSummary {
	return {
		osc133: countMatches(input, OSC133_PATTERN),
		osc: countMatches(input, OSC_PATTERN),
		csi: countMatches(input, CSI_PATTERN),
		sgr: countMatches(input, SGR_PATTERN),
		dcs: countMatches(input, DCS_PATTERN),
		apc: countMatches(input, APC_PATTERN),
		pm: countMatches(input, PM_PATTERN),
	};
}

function stripInvisibleControls(input: string): string {
	return input
		.replace(DCS_PATTERN, "")
		.replace(APC_PATTERN, "")
		.replace(PM_PATTERN, "")
		.replace(OSC_PATTERN, "")
		.replace(CSI_PATTERN, "")
		.replace(C0_PATTERN, "");
}

function previewClass(char: string): string {
	if (/\s/u.test(char)) return "S";
	if (/^[╭╮╰╯│─]$/u.test(char)) return "B";
	if (/^[A-Z]$/u.test(char)) return "U";
	if (/^[a-z]$/u.test(char)) return "L";
	if (/^[0-9]$/u.test(char)) return "D";
	if (/^[\p{P}\p{S}]$/u.test(char)) return "P";
	if (visibleWidth(char) > 1) return "W";
	return "O";
}

function maskedPreviewStart(input: string, limit = PREVIEW_LIMIT): string {
	return [...input].slice(0, limit).map(previewClass).join("");
}

function maskedPreviewEnd(input: string, limit = PREVIEW_LIMIT): string {
	const chars = [...input];
	return chars.slice(Math.max(0, chars.length - limit)).map(previewClass).join("");
}

function tailCodepoints(input: string): string[] {
	const controls: string[] = [];
	const chars = [...input].reverse();
	for (const char of chars) {
		const code = char.codePointAt(0)!;
		if (code === 0x1b || code === 0x07 || code === 0x0a || code === 0x0d || code === 0x09 || code < 0x20 || code === 0x7f) {
			controls.push(`U+${code.toString(16).toUpperCase().padStart(4, "0")}`);
			if (controls.length >= TAIL_CODEPOINT_LIMIT) break;
		}
	}
	return controls.reverse();
}

function safeVisibleWidth(input: string): number {
	try {
		return visibleWidth(stripInvisibleControls(input));
	} catch {
		return 0;
	}
}

function lineRole(index: number, total: number, branch: ChromeFrameDebugBranch, usesCompactThinking: boolean | undefined): string {
	if (branch === "normal" || branch === "imageSuppressed" || branch === "cacheHit") {
		if (usesCompactThinking) {
			if (index === 0) return "compactTop";
			if (index === total - 1) return "compactBottom";
			return "compactContent";
		}
		if (index === 0) return "top";
		if (index === total - 1) return "bottom";
		return "content";
	}
	if (branch === "compactThinking") {
		if (index === 0) return "compactTop";
		if (index === total - 1) return "compactBottom";
		return "compactContent";
	}
	if (branch === "fallback" || branch === "narrowFallback" || branch === "imageFallback" || branch === "errorFallback") return "fallback";
	return "unknown";
}

function summarizeLine(line: string, index: number, total: number, branch: ChromeFrameDebugBranch, usesCompactThinking: boolean | undefined) {
	const raw = String(line);
	const isImageLine = isImageEscapeLine(raw);
	const printable = isImageLine ? "" : stripInvisibleControls(raw);
	const controlSummary = summarizeControls(raw);
	return {
		index,
		role: lineRole(index, total, branch, usesCompactThinking),
		visibleWidth: safeVisibleWidth(raw),
		startsWithOsc133: /^\x1b\]133;[A-Z](?:\x07|\x1b\\)/.test(raw),
		containsOsc133: controlSummary.osc133 > 0,
		containsOsc: controlSummary.osc > 0,
		containsCsi: controlSummary.csi > 0,
		blank: printable.trim().length === 0,
		prefixPreview: isImageLine ? "" : maskedPreviewStart(printable),
		suffixPreview: isImageLine ? "" : maskedPreviewEnd(printable),
		tailCodepoints: isImageLine ? [] : tailCodepoints(raw),
		rawLength: raw.length,
		controlSummary,
		isImageLine,
	};
}

export function summarizeChromeFrameCacheKey(value: string | undefined): string | null {
	if (!value) return null;
	let hash = 5381;
	for (let index = 0; index < value.length; index += 1) {
		hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
	}
	return `len:${value.length}:hash:${(hash >>> 0).toString(16)}`;
}

export function writeChromeFrameDebugLog(options: ChromeFrameDebugOptions): void {
	const logPath = process.env.ALPS_PI_FRAME_DEBUG_LOG?.trim();
	if (!logPath || !isAbsolute(logPath)) return;
	try {
		const lines = options.lines.map(String);
		const entry = {
			event: "chrome-frame-render",
			seq: ++sequence,
			timestamp: new Date().toISOString(),
			targetId: options.targetId || "unknown",
			targetKind: options.targetKind,
			inputWidth: options.inputWidth,
			resolvedFrameWidth: options.resolvedFrameWidth,
			innerWidth: options.innerWidth ?? null,
			originalLineCount: options.originalLineCount ?? null,
			displayedLineCount: options.displayedLineCount ?? null,
			boxedLineCount: options.boxedLineCount ?? lines.length,
			branch: options.branch,
			cacheKeySummary: options.cacheKeySummary ?? null,
			hasImageLine: Boolean(options.hasImageLine),
			usesCompactThinking: Boolean(options.usesCompactThinking),
			error: options.error,
			lines: lines.map((line, index) => summarizeLine(line, index, lines.length, options.branch, options.usesCompactThinking)),
		};
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
	} catch {
		// 诊断失败不得影响 chrome-frame render。
	}
}
