/** 功能：Animations 生命周期诊断 JSONL 日志；默认关闭且不记录正文。 实现者：alps 实现日期：2026-05-31 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AnimationRuntimeState } from "./runtime.ts";

export type AnimationDebugEvent =
	| "agent_start"
	| "message_update"
	| "message_end"
	| "tool_execution_start"
	| "tool_execution_update"
	| "tool_execution_end"
	| "turn_end"
	| "agent_end"
	| "session_shutdown"
	| "configure"
	| "bind_session"
	| "pause"
	| "resume"
	| "timer_tick"
	| "render_fail"
	| "working_render"
	| "working_render_skipped";

type AnimationDebugOptions = {
	event: AnimationDebugEvent;
	state: AnimationRuntimeState;
	ctx?: any;
	payload?: any;
	error?: unknown;
	note?: string;
};

const HASH_LIMIT = 8;
let sequence = 0;

export function isAnimationDebugEnabled(): boolean {
	const logPath = process.env.ALPS_PI_ANIM_DEBUG_LOG?.trim();
	return Boolean(logPath && isAbsolute(logPath));
}

/** 写入脱敏动画生命周期摘要；失败时吞掉，避免影响 runtime。 */
export function writeAnimationDebugLog(options: AnimationDebugOptions): void {
	const logPath = process.env.ALPS_PI_ANIM_DEBUG_LOG?.trim();
	if (!logPath || !isAbsolute(logPath)) return;
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${JSON.stringify(buildEntry(options))}\n`, "utf8");
	} catch {
		// 诊断失败不得影响动画 runtime。
	}
}

function buildEntry(options: AnimationDebugOptions) {
	const ctx = options.ctx ?? options.state.currentEventCtx ?? options.state.currentCtx;
	return {
		event: options.event,
		seq: ++sequence,
		timestamp: new Date().toISOString(),
		note: options.note,
		animating: Boolean(options.state.animating),
		timerActive: Boolean(options.state.timer),
		toolCallIds: summarizeToolCallIds(options.state.toolCallIds),
		thinkingActive: Boolean(options.state.thinkingActive),
		workingMessageApplied: Boolean(options.state.workingMessageApplied),
		workingIndicatorHidden: Boolean(options.state.workingIndicatorHidden),
		lastWorkingLines: {
			count: Math.max(0, options.state.lastWorkingLines || 0),
			widths: Array.isArray(options.state.lastWorkingLineWidths) ? options.state.lastWorkingLineWidths.slice(0, 8) : [],
		},
		ctx: summarizeCtx(ctx, options.state.currentUiCtx ?? options.state.currentCtx),
		eventCtx: summarizeCtx(ctx, options.state.currentEventCtx),
		uiApi: summarizeUiApi((options.state.currentUiCtx ?? options.state.currentCtx)?.ui),
		payload: summarizePayload(options.payload),
		error: summarizeError(options.error),
	};
}

function summarizeToolCallIds(ids: Set<string> | undefined) {
	const values = [...(ids ?? new Set<string>())].map((value) => stableHash(value)).sort();
	return {
		count: values.length,
		hashes: values.slice(0, HASH_LIMIT),
	};
}

function summarizeCtx(ctx: any, currentCtx: any) {
	if (!ctx) {
		return {
			present: false,
			hash: null,
			isCurrent: false,
			hasUI: false,
		};
	}
	const idSource = typeof ctx?.id === "string" || typeof ctx?.id === "number" ? String(ctx.id) : objectTag(ctx);
	return {
		present: true,
		hash: stableHash(idSource),
		isCurrent: ctx === currentCtx,
		hasUI: ctx?.hasUI !== false && Boolean(ctx?.ui),
	};
}

function summarizeUiApi(ui: any) {
	return {
		setWorkingMessage: typeof ui?.setWorkingMessage === "function",
		setWorkingIndicator: typeof ui?.setWorkingIndicator === "function",
		requestRender: typeof ui?.requestRender === "function",
	};
}

function summarizePayload(payload: any) {
	const type = payload?.assistantMessageEvent?.type;
	const toolCallId = payload?.toolCallId;
	return {
		assistantMessageEventType: typeof type === "string" ? type : null,
		hasMessage: Boolean(payload?.message),
		hasUsage: Boolean(payload?.message?.usage),
		toolCallIdHash: toolCallId === undefined ? null : stableHash(String(toolCallId)),
	};
}

function summarizeError(error: unknown) {
	if (!error) return null;
	const anyError = error as any;
	const name = error instanceof Error ? error.name : typeof error;
	const code = typeof anyError?.code === "string" || typeof anyError?.code === "number" ? String(anyError.code) : null;
	return { name, code, stale: isStaleCtxError(error) };
}

export function summarizeWorkingLineWidths(lines: readonly string[]): number[] {
	return lines.slice(0, 8).map((line) => safeVisibleWidth(line));
}

function safeVisibleWidth(line: string): number {
	try {
		return visibleWidth(String(line));
	} catch {
		return 0;
	}
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
