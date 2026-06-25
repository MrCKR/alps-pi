/** 功能：Bottom Input 生命周期诊断 JSONL 日志；默认关闭且不记录正文。 实现者：alps 实现日期：2026-06-23 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type BottomInputDebugEvent =
	| "bind_session"
	| "sync_layout"
	| "disable"
	| "fail_closed"
	| "disable_with_failure";

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

let sequence = 0;
let configuredLogPath = "";

/** 配置诊断日志路径；空字符串表示关闭。 */
export function configureBottomInputDebug(logPath: string | undefined): void {
	configuredLogPath = typeof logPath === "string" ? logPath.trim() : "";
}

export function isBottomInputDebugEnabled(): boolean {
	const logPath = resolveLogPath();
	return Boolean(logPath && isAbsolute(logPath));
}

/** 写入脱敏 bottom-input 生命周期摘要；失败时吞掉，避免影响输入框 runtime。 */
export function writeBottomInputDebugLog(options: BottomInputDebugOptions): void {
	const logPath = resolveLogPath();
	if (!logPath || !isAbsolute(logPath)) return;
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${JSON.stringify(buildEntry(options))}\n`, "utf8");
	} catch {
		// 诊断失败不得影响 bottom-input runtime。
	}
}

function resolveLogPath(): string {
	return configuredLogPath || process.env.ALPS_PI_BOTTOM_INPUT_DEBUG_LOG?.trim() || readDebugPathFile();
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
