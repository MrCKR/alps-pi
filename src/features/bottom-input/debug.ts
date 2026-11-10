/** 功能：Bottom Input 生命周期诊断 JSONL 日志；默认关闭且不记录正文。 实现者：alps 实现日期：2026-06-23 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDebugLogSink, flushDebugLogsSync } from "../../debug-log.ts";

export type BottomInputDebugEvent =
	| "bind_session"
	| "sync_layout"
	| "disable"
	| "fail_closed"
	| "disable_with_failure"
	| "editor_frame_mismatch";

type BottomInputDebugState = {
	enabled: boolean;
	installed: boolean;
	layoutInstalled: boolean;
	generation: number;
	layoutOwnerGeneration: number | null;
	hasCompositor: boolean;
	hasEditor: boolean;
	hasFooter: boolean;
	failure?: string;
};

type BottomInputDebugOptions = {
	event: BottomInputDebugEvent;
	state: BottomInputDebugState;
	ctx?: any;
	currentCtx?: any;
	currentUi?: any;
	nextUi?: any;
	note?: string;
	reason?: string;
	details?: Record<string, unknown>;
	error?: unknown;
};

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEBUG_PATH_FILE = resolve(PACKAGE_ROOT, ".temp", "bottom-input-debug.path");

const PATH_CACHE_TTL_MS = 5_000;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES_PER_SECOND = 20;

let sequence = 0;
let configuredLogPath = "";
let cachedLogPath = "";
let cachedLogPathAt = 0;
let cachedLogPathValid = false;

const logSink = createDebugLogSink({
	name: "bottom-input",
	getPath: resolveLogPath,
	maxBytes: MAX_LOG_BYTES,
	maxEntriesPerSecond: MAX_ENTRIES_PER_SECOND,
});

/** 配置诊断日志路径；空字符串表示关闭。 */
export function configureBottomInputDebug(logPath: string | undefined): void {
	configuredLogPath = typeof logPath === "string" ? logPath.trim() : "";
	invalidatePathCache();
}

export function isBottomInputDebugEnabled(): boolean {
	return Boolean(resolveLogPath());
}

/** 写入脱敏 bottom-input 生命周期摘要；失败时吞掉，避免影响输入框 runtime。 */
export function writeBottomInputDebugLog(options: BottomInputDebugOptions): void {
	if (!isBottomInputDebugEnabled()) return;
	try {
		logSink.write(buildEntry(options));
	} catch {
		// 诊断失败不得影响 bottom-input runtime。
	}
}

/**
 * 检测输入框线框内容行与实际输入文本不一致。
 * 典型异常：输入框为空，但内容行里画出了别的文本（例如流式正文）。
 * 只在这两类互斥情形下返回，避免长文本截断造成误报。
 */
export function findFrameContentMismatch(
	editorText: string,
	lines: readonly string[],
): { innerText: string; editorText: string } | undefined {
	const contentRows: string[] = [];
	for (const line of lines) {
		const plain = stripAnsiText(String(line));
		if (!plain.startsWith("│")) continue;
		contentRows.push(plain.replace(/^│\s?/, "").replace(/\s*│\s*$/, "").trim());
	}
	const innerText = contentRows.join(" ").trim();
	const expected = editorText.replace(/\r/g, "").trim();
	if (innerText && !expected) return { innerText: truncateForLog(innerText), editorText: "" };
	if (!innerText && expected) return { innerText: "", editorText: truncateForLog(expected) };
	return undefined;
}

/** 记录一次输入框线框内容行异常；由 editor.render 在热路径上调用，自身不做 IO 缓存。 */
export function logFrameContentMismatch(
	editorText: string,
	lines: readonly string[],
	width: number,
): void {
	if (!isBottomInputDebugEnabled()) return;
	const mismatch = findFrameContentMismatch(editorText, lines);
	if (!mismatch) return;
	try {
		logSink.write({
			event: "editor_frame_mismatch",
			seq: ++sequence,
			timestamp: new Date().toISOString(),
			width,
			rowCount: lines.length,
			innerText: mismatch.innerText,
			editorTextLength: mismatch.editorText.length,
			editorTextPreview: truncateForLog(mismatch.editorText, 60),
		});
	} catch {
		// 诊断失败不得影响渲染。
	}
}

function truncateForLog(value: string, limit = 120): string {
	return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** 去掉转义序列，只保留可见文本；用于比对内容行。 */
function stripAnsiText(value: string): string {
	let output = "";
	for (let index = 0; index < value.length;) {
		if (value[index] === "\x1b") {
			const next = value[index + 1];
			if (next === "[") {
				let end = index + 2;
				while (end < value.length && !/[@-~]/.test(value[end]!)) end += 1;
				index = end + 1;
				continue;
			}
			if (next === "]" || next === "_" || next === "P" || next === "^") {
				let end = index + 2;
				while (end < value.length && value[end] !== "\x07" && !(value[end] === "\x1b" && value[end + 1] === "\\")) end += 1;
				index = value[end] === "\x1b" ? end + 2 : end + 1;
				continue;
			}
			index += 2;
			continue;
		}
		output += value[index];
		index += 1;
	}
	return output;
}

/** 路径解析带 TTL 缓存：bind_session 等热路径每个事件都会调用，不能每次都读文件。 */
function resolveLogPath(): string {
	const now = Date.now();
	if (cachedLogPathValid && now - cachedLogPathAt < PATH_CACHE_TTL_MS) return cachedLogPath;
	const candidate = configuredLogPath || process.env.ALPS_PI_BOTTOM_INPUT_DEBUG_LOG?.trim() || readDebugPathFile();
	// 只接受绝对路径；相对路径可能与终端工作目录混淆，直接视为关闭。
	cachedLogPath = candidate && isAbsolute(candidate) ? candidate : "";
	cachedLogPathAt = now;
	cachedLogPathValid = true;
	return cachedLogPath;
}

function invalidatePathCache(): void {
	cachedLogPathValid = false;
	cachedLogPath = "";
	cachedLogPathAt = 0;
	// 路径切换前先落盘，避免丢掉切换瞬间的缓冲。
	flushDebugLogsSync();
	logSink.reset();
}

function readDebugPathFile(): string {
	try {
		if (process.env.ALPS_PI_SETTINGS_PATH) return "";
		if (!existsSync(DEBUG_PATH_FILE)) return "";
		return readFileSync(DEBUG_PATH_FILE, "utf8").trim();
	} catch {
		return "";
	}
}

function buildEntry(options: BottomInputDebugOptions) {
	return {
		event: options.event,
		seq: ++sequence,
		timestamp: new Date().toISOString(),
		note: options.note,
		reason: options.reason,
		state: summarizeState(options.state),
		ctx: summarizeCtx(options.ctx, options.currentCtx),
		currentCtx: summarizeCtx(options.currentCtx, options.currentCtx),
		uiApi: summarizeUiApi(options.currentUi),
		nextUiApi: summarizeUiApi(options.nextUi),
		details: sanitizeDetails(options.details),
		error: summarizeError(options.error),
	};
}

function summarizeState(state: BottomInputDebugState) {
	return {
		enabled: state.enabled,
		installed: state.installed,
		layoutInstalled: state.layoutInstalled,
		generation: state.generation,
		layoutOwnerGeneration: state.layoutOwnerGeneration,
		hasCompositor: state.hasCompositor,
		hasEditor: state.hasEditor,
		hasFooter: state.hasFooter,
		failure: state.failure ? String(state.failure).slice(0, 160) : undefined,
	};
}

function summarizeCtx(ctx: any, currentCtx: any) {
	if (!ctx) return { present: false, hash: null, isCurrent: false, hasUI: false, stale: false };
	const safe = safeReadCtx(ctx);
	return {
		present: true,
		hash: stableHash(safe.idSource),
		isCurrent: ctx === currentCtx,
		hasUI: safe.hasUI,
		stale: safe.stale,
	};
}

function safeReadCtx(ctx: any): { idSource: string; hasUI: boolean; stale: boolean } {
	try {
		const id = typeof ctx?.id === "string" || typeof ctx?.id === "number" ? String(ctx.id) : objectTag(ctx);
		return {
			idSource: id,
			hasUI: ctx?.hasUI === true && Boolean(ctx?.ui),
			stale: false,
		};
	} catch (error) {
		return {
			idSource: objectTag(ctx),
			hasUI: false,
			stale: isStaleCtxError(error),
		};
	}
}

function summarizeUiApi(ui: any) {
	return {
		present: Boolean(ui),
		setEditorComponent: typeof ui?.setEditorComponent === "function",
		getEditorComponent: typeof ui?.getEditorComponent === "function",
		setFooter: typeof ui?.setFooter === "function",
		requestRender: typeof ui?.requestRender === "function",
		onTerminalInput: typeof ui?.onTerminalInput === "function",
		setStatus: typeof ui?.setStatus === "function",
		getEditorText: typeof ui?.getEditorText === "function",
		setEditorText: typeof ui?.setEditorText === "function",
	};
}

function sanitizeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!details) return undefined;
	const sanitized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(details)) {
		if (typeof value === "boolean" || typeof value === "number" || value === null) {
			sanitized[key] = value;
		} else if (typeof value === "string") {
			sanitized[key] = value.slice(0, 160);
		} else {
			sanitized[key] = Object.prototype.toString.call(value);
		}
	}
	return sanitized;
}

function summarizeError(error: unknown) {
	if (!error) return null;
	const anyError = error as any;
	const name = error instanceof Error ? error.name : typeof error;
	const code = typeof anyError?.code === "string" || typeof anyError?.code === "number" ? String(anyError.code) : null;
	return { name, code, stale: isStaleCtxError(error) };
}

function objectTag(value: object): string {
	const tag = Object.prototype.toString.call(value);
	return `${tag}:${Object.keys(value as Record<string, unknown>).sort().join(",")}`;
}

function stableHash(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function isStaleCtxError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("extension ctx is stale") || message.includes("stale ctx");
}
