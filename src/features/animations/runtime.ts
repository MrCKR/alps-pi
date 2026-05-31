/** 功能：维护 Animations 动画帧、working/status 接管、hidden thinking 替换与会话绑定。 实现者：alps 实现日期：2026-05-29 */

import type { Component } from "@earendil-works/pi-tui";
import { type AnimationsSettings, cloneDefaultAnimationsSettings, normalizeAnimationsSettings } from "./settings.ts";
import { pickRandomAnimation, renderAnimationFrame, resolveAnimationWidth, type AnimationPhase } from "./registry.ts";
import { isAnimationDebugEnabled, summarizeWorkingLineWidths, writeAnimationDebugLog, type AnimationDebugEvent } from "./debug.ts";

const WORKING_WIDGET_KEY = "alps-pi-animations";
export const THINKING_DONE_LABEL = "Thinking complete";

export type AnimationRuntimeState = {
	settings: AnimationsSettings;
	frame: number;
	timer: ReturnType<typeof setInterval> | undefined;
	/** 最近一个可写 working animation 的 UI ctx；子代理 no-UI ctx 不得覆盖。 */
	currentUiCtx: any;
	/** 最近一个参与事件处理的 ctx；仅用于诊断与 scope 判断。 */
	currentEventCtx: any;
	/** 兼容旧测试与热重载状态的 UI ctx 别名。 */
	currentCtx: any;
	activeComponents: Set<AnimatedThinkingComponent>;
	randomWorking: string | undefined;
	randomThinking: string | undefined;
	randomTool: string | undefined;
	previousRandomWorking: string | undefined;
	previousRandomThinking: string | undefined;
	previousRandomTool: string | undefined;
	/** 当前 agent 回合是否处于输出期；启用后接管 Pi 底部 working loader。 */
	animating: boolean;
	/** 当前是否正在接收 thinking 流；优先级高于 tool/working。 */
	thinkingActive: boolean;
	/** 正在运行的 tool 调用 id；非空时底部动画进入 tool phase。 */
	toolCallIds: Set<string>;
	/** 当前顶层 agent generation；用于隔离子代理与 late tool 事件。 */
	agentGeneration: number;
	/** 已关闭的最近 agent generation；late event 只能幂等清理，不得复活动画。 */
	closedAgentGeneration: number;
	/** tool id 到所属 agent generation 的映射，避免子代理事件清空父级 tool。 */
	toolOwners: Map<string, number>;
	/** 被识别为嵌套子代理的 ctx；其 message/turn 事件只允许诊断，不改父级动画状态。 */
	ignoredAgentContexts: WeakSet<object>;
	/** 是否曾通过 Pi 原生 hidden label API 驱动重绘；关闭时用于恢复默认 label。 */
	hiddenLabelApplied: boolean;
	/** 是否曾写入底部 working message；停止时用于恢复 Pi 默认文案。 */
	workingMessageApplied: boolean;
	/** 是否曾写入多行动画 widget；停止时用于清理旧版本或外部插件残留。 */
	workingWidgetApplied: boolean;
	/** 是否曾为多行动画隐藏 Pi 原生 working spinner；切回单行或停止接管时用于恢复默认 indicator。 */
	workingIndicatorHidden: boolean;
	/** 上一帧底部动画行数；用于测试与后续排查单行/多行切换。 */
	lastWorkingLines: number;
	/** 上一帧底部动画每行可见宽度摘要；仅用于诊断，不保存文本。 */
	lastWorkingLineWidths: number[];
	/** 当前正在流式更新的 assistant message；避免长历史重建时把旧 hidden thinking 全部注册成动画组件。 */
	currentAssistantMessage: any;
	/** 防止上一轮异步冻结任务误冻结下一轮新组件。 */
	freezeGeneration: number;
};

const ANIMATIONS_STATE_KEY = Symbol.for("alps.pi.animations.runtime.v1");

export class AnimatedThinkingComponent implements Component {
	private readonly state: AnimationRuntimeState;
	private readonly animationName: string | undefined;
	private readonly completionLabel: string | undefined;
	private frozen = false;

	constructor(state = getAnimationsRuntimeState(), animationName?: string, frozen = false, completionLabel?: string) {
		this.state = state;
		this.animationName = animationName;
		this.completionLabel = completionLabel;
		this.frozen = frozen;
		if (!this.frozen) {
			this.state.activeComponents.add(this);
			if (shouldRunTimer(this.state)) startTimer(this.state);
		}
	}

	/** 组件移除后由 patch/runtime 尽力清理，避免长期 session 中积累引用。 */
	dispose(): void {
		this.state.activeComponents.delete(this);
		if (!shouldRunTimer(this.state)) stopTimer(this.state);
	}

	/** 思考流结束后冻结为完成文案，防止历史消息继续随全局 timer 播放。 */
	freeze(): void {
		if (this.frozen) return;
		this.frozen = true;
		this.state.activeComponents.delete(this);
		if (!shouldRunTimer(this.state)) stopTimer(this.state);
	}

	render(width: number): string[] {
		if (!this.state.settings.enabled) return [" Thinking... "];
		if (this.frozen) return [` ${this.completionLabel ?? renderThinkingCompleteLabel()} `];
		const terminalWidth = Math.max(1, Math.floor(width));
		const animationWidth = Math.min(resolveAnimationWidth(this.state.settings.width, terminalWidth), Math.max(1, terminalWidth - 2));
		const name = this.animationName ?? resolveAnimationNameForPhase(this.state, "thinking");
		return renderAnimationFrame(name, this.state.frame, animationWidth, "thinking").map((line) => ` ${line} `);
	}

	invalidate(): void {}
}

export function getAnimationsRuntimeState(): AnimationRuntimeState {
	const existing = (globalThis as any)[ANIMATIONS_STATE_KEY] as Partial<AnimationRuntimeState> | undefined;
	if (existing) return migrateAnimationsRuntimeState(existing);
	const state = createDefaultAnimationsRuntimeState();
	(globalThis as any)[ANIMATIONS_STATE_KEY] = state;
	return state;
}

function createDefaultAnimationsRuntimeState(): AnimationRuntimeState {
	return {
		settings: cloneDefaultAnimationsSettings(),
		frame: 0,
		timer: undefined,
		currentUiCtx: undefined,
		currentEventCtx: undefined,
		currentCtx: undefined,
		activeComponents: new Set(),
		randomWorking: undefined,
		randomThinking: undefined,
		randomTool: undefined,
		previousRandomWorking: undefined,
		previousRandomThinking: undefined,
		previousRandomTool: undefined,
		animating: false,
		thinkingActive: false,
		toolCallIds: new Set(),
		agentGeneration: 0,
		closedAgentGeneration: 0,
		toolOwners: new Map(),
		ignoredAgentContexts: new WeakSet(),
		hiddenLabelApplied: false,
		workingMessageApplied: false,
		workingWidgetApplied: false,
		workingIndicatorHidden: false,
		lastWorkingLines: 0,
		lastWorkingLineWidths: [],
		currentAssistantMessage: undefined,
		freezeGeneration: 0,
	};
}

function migrateAnimationsRuntimeState(existing: Partial<AnimationRuntimeState>): AnimationRuntimeState {
	// /reload 会复用 Symbol.for 下的旧对象；新字段必须补齐，避免旧 runtime state 崩溃。
	existing.settings = normalizeAnimationsSettings(existing.settings ?? cloneDefaultAnimationsSettings());
	if (typeof existing.frame !== "number") existing.frame = 0;
	if (!(existing.activeComponents instanceof Set)) existing.activeComponents = new Set();
	if (!('currentUiCtx' in existing)) existing.currentUiCtx = canWriteWorkingAnimation(existing.currentCtx) ? existing.currentCtx : undefined;
	if (!('currentEventCtx' in existing)) existing.currentEventCtx = undefined;
	if (!(existing.toolCallIds instanceof Set)) existing.toolCallIds = new Set();
	if (typeof existing.agentGeneration !== "number") existing.agentGeneration = 0;
	if (typeof existing.closedAgentGeneration !== "number") existing.closedAgentGeneration = 0;
	if (!(existing.toolOwners instanceof Map)) existing.toolOwners = new Map();
	if (!(existing.ignoredAgentContexts instanceof WeakSet)) existing.ignoredAgentContexts = new WeakSet();
	if (typeof existing.animating !== "boolean") existing.animating = false;
	if (typeof existing.thinkingActive !== "boolean") existing.thinkingActive = false;
	if (typeof existing.previousRandomWorking !== "string") existing.previousRandomWorking = undefined;
	if (typeof existing.previousRandomThinking !== "string") existing.previousRandomThinking = undefined;
	if (typeof existing.previousRandomTool !== "string") existing.previousRandomTool = undefined;
	if (typeof existing.hiddenLabelApplied !== "boolean") existing.hiddenLabelApplied = false;
	if (typeof existing.workingMessageApplied !== "boolean") existing.workingMessageApplied = false;
	if (typeof existing.workingWidgetApplied !== "boolean") existing.workingWidgetApplied = false;
	if (typeof existing.workingIndicatorHidden !== "boolean") existing.workingIndicatorHidden = false;
	if (typeof existing.lastWorkingLines !== "number") existing.lastWorkingLines = 0;
	if (!Array.isArray(existing.lastWorkingLineWidths)) existing.lastWorkingLineWidths = [];
	if (!("currentAssistantMessage" in existing)) existing.currentAssistantMessage = undefined;
	if (typeof existing.freezeGeneration !== "number") existing.freezeGeneration = 0;
	return existing as AnimationRuntimeState;
}

export function configureAnimationsRuntime(settings: AnimationsSettings): void {
	const state = getAnimationsRuntimeState();
	writeAnimationDebugLog({ event: "configure", state });
	const previousFps = state.settings.fps;
	const previousRandomMode = state.settings.randomMode;
	state.settings = normalizeAnimationsSettings(settings);
	if (previousRandomMode !== state.settings.randomMode) resetRandomAnimations(state);
	if (!state.settings.enabled) {
		stopTimer(state);
		resetRandomAnimations(state);
		clearWorkingAnimation(state);
		resetHiddenThinkingLabel(state);
		requestAnimationsRender(state);
		return;
	}
	if (shouldRunTimer(state) && (!state.timer || previousFps !== state.settings.fps)) startTimer(state);
	requestAnimationsRender(state);
}

export function bindAnimationsRuntimeSession(ctx: any): void {
	const state = getAnimationsRuntimeState();
	state.currentEventCtx = ctx;
	if (canWriteWorkingAnimation(ctx)) {
		state.currentUiCtx = ctx;
		state.currentCtx = ctx;
		writeAnimationDebugLog({ event: "bind_session", state, ctx });
		return;
	}
	writeAnimationDebugLog({ event: "bind_session", state, ctx, note: "ignored_no_ui_target" });
}

/** agent_start 只为当前顶层 ctx 创建 generation；子代理启动不得清空父级 tool 状态。 */
export function handleAnimationsAgentStart(event?: any, ctx?: any): void {
	const state = getAnimationsRuntimeState();
	if (isStaleEventCtx(ctx)) {
		writeAnimationDebugLog({ event: "agent_start", state, ctx, payload: event, note: "ignored_stale_ctx" });
		return;
	}
	if (isNestedAgentStart(state, ctx)) {
		rememberIgnoredAgentContext(state, ctx);
		writeAnimationDebugLog({ event: "agent_start", state, ctx, payload: event, note: "ignored_nested_agent" });
		return;
	}
	bindEventCtx(state, ctx);
	resumeAnimationsRuntime();
}

/** agent_end 是动画最终清理点；no-UI 子代理结束不得清掉父级动画，stale parent end 仍用当前 ctx 幂等清理。 */
export function handleAnimationsAgentEnd(event?: any, ctx?: any): void {
	const state = getAnimationsRuntimeState();
	if (isIgnoredAgentContext(state, ctx) || isNestedNonWritableEvent(state, ctx)) {
		rememberIgnoredAgentContext(state, ctx);
		writeAnimationDebugLog({ event: "agent_end", state, ctx, payload: event, note: "ignored_nested_agent" });
		return;
	}
	if (isStaleEventCtx(ctx)) {
		writeAnimationDebugLog({ event: "agent_end", state, ctx, payload: event, note: hasActiveAnimationState(state) ? "stale_ctx_cleanup_current" : "stale_ctx_no_active_runtime" });
		if (hasActiveAnimationState(state)) pauseAnimationsRuntime();
		return;
	}
	bindEventCtx(state, ctx);
	pauseAnimationsRuntime();
}

/** 入口事件诊断打点；只写脱敏事件与状态摘要。 */
export function recordAnimationsLifecycleEvent(event: AnimationDebugEvent, ctx?: any, payload?: any): void {
	writeAnimationDebugLog({ event, state: getAnimationsRuntimeState(), ctx, payload });
}

/** agent 开始输出时接管底部 Working/Thinking/Tool 动画，并驱动 hidden thinking 组件刷新。 */
export function resumeAnimationsRuntime(): void {
	const state = getAnimationsRuntimeState();
	writeAnimationDebugLog({ event: "resume", state });
	state.animating = true;
	state.thinkingActive = false;
	state.agentGeneration += 1;
	state.toolCallIds.clear();
	state.toolOwners.clear();
	state.currentAssistantMessage = undefined;
	state.frame = 0;
	state.freezeGeneration += 1;
	state.workingWidgetApplied = true;
	resetRandomAnimations(state);
	if (state.settings.enabled) startTimer(state);
	requestAnimationsRender(state);
}

/** agent 结束或 session 释放时停止动画接管，并恢复 Pi 默认 working/hidden thinking 状态。 */
export function pauseAnimationsRuntime(): void {
	const state = getAnimationsRuntimeState();
	writeAnimationDebugLog({ event: "pause", state });
	state.animating = false;
	state.thinkingActive = false;
	state.closedAgentGeneration = state.agentGeneration;
	state.toolCallIds.clear();
	state.toolOwners.clear();
	state.currentAssistantMessage = undefined;
	freezeAnimatedThinkingComponentsSoon(state);
	stopTimer(state);
	clearWorkingAnimation(state);
	resetHiddenThinkingLabel(state);
}

/** 根据 assistant 流式事件切换 bottom 动画 phase；thinking 优先于 tool/working。 */
export function handleAnimationsMessageUpdate(event: any, ctx?: any): void {
	const state = getAnimationsRuntimeState();
	if (shouldIgnoreScopedEvent(state, ctx)) {
		writeAnimationDebugLog({ event: "message_update", state, ctx, payload: event, note: "ignored_scoped_event" });
		return;
	}
	bindEventCtx(state, ctx);
	if (event?.message) state.currentAssistantMessage = event.message;
	const type = event?.assistantMessageEvent?.type;
	if (type === "thinking_start" || type === "thinking_delta") {
		state.thinkingActive = true;
	} else if (type === "thinking_end" || type === "text_delta") {
		state.thinkingActive = false;
		freezeAnimatedThinkingComponentsSoon(state);
	}
	if (shouldRunTimer(state) && !state.timer) startTimer(state);
	requestAnimationsRender(state);
}

/** assistant message 完成后退出 thinking phase，但 agent 可能还会继续执行 tool。 */
export function handleAnimationsMessageEnd(ctx?: any): void {
	const state = getAnimationsRuntimeState();
	if (shouldIgnoreScopedEvent(state, ctx)) {
		writeAnimationDebugLog({ event: "message_end", state, ctx, note: "ignored_scoped_event" });
		return;
	}
	bindEventCtx(state, ctx);
	state.thinkingActive = false;
	state.currentAssistantMessage = undefined;
	freezeAnimatedThinkingComponentsSoon(state);
	requestAnimationsRender(state);
}

/** tool 开始执行时切换到底部 tool 动画；多 tool 并行时保留计数。 */
export function handleAnimationsToolExecutionStart(event: any, ctx?: any): void {
	const state = getAnimationsRuntimeState();
	if (shouldIgnoreScopedEvent(state, ctx)) {
		writeAnimationDebugLog({ event: "tool_execution_start", state, ctx, payload: event, note: "ignored_scoped_event" });
		return;
	}
	bindEventCtx(state, ctx);
	const id = readToolCallId(event);
	state.toolCallIds.add(id);
	state.toolOwners.set(id, state.agentGeneration);
	requestAnimationsRender(state);
}

/** tool 执行完成后只移除所属 tool；late/stale end 不得复活动画。 */
export function handleAnimationsToolExecutionEnd(event: any, ctx?: any): void {
	const state = getAnimationsRuntimeState();
	const stale = isStaleEventCtx(ctx) || isIgnoredAgentContext(state, ctx) || isNestedNoUiEvent(state, ctx);
	const generation = state.agentGeneration;
	if (event?.toolCallId === undefined) {
		if (!stale) clearToolsForGeneration(state, generation);
		writeAnimationDebugLog({ event: "tool_execution_end", state, ctx, payload: event, note: stale ? "ignored_stale_unknown_tool" : "cleared_current_generation_tools" });
		if (!stale && state.animating) requestAnimationsRender(state);
		return;
	}
	const id = readToolCallId(event);
	const owner = state.toolOwners.get(id);
	if (owner !== undefined && !isIgnoredAgentContext(state, ctx) && !isNestedNoUiEvent(state, ctx)) {
		state.toolOwners.delete(id);
		state.toolCallIds.delete(id);
	} else if (!stale) {
		state.toolCallIds.delete(id);
	}
	writeAnimationDebugLog({ event: "tool_execution_end", state, ctx, payload: event, note: stale ? "bookkeeping_only" : undefined });
	if (!stale && state.animating && (owner === undefined || owner === generation)) requestAnimationsRender(state);
}

export function disposeAnimationsRuntime(): void {
	const state = getAnimationsRuntimeState();
	pauseAnimationsRuntime();
	for (const component of state.activeComponents) component.dispose();
	state.activeComponents.clear();
	state.currentUiCtx = undefined;
	state.currentEventCtx = undefined;
	state.currentCtx = undefined;
	resetRandomAnimations(state);
}

function startTimer(state: AnimationRuntimeState): void {
	stopTimer(state);
	const fps = Math.max(1, state.settings.fps);
	state.timer = setInterval(() => {
		state.frame += 1;
		writeAnimationDebugLog({ event: "timer_tick", state });
		requestAnimationsRender(state);
	}, Math.max(16, Math.round(1000 / fps)));
	state.timer.unref?.();
}

function stopTimer(state: AnimationRuntimeState): void {
	if (!state.timer) return;
	clearInterval(state.timer);
	state.timer = undefined;
}

function requestAnimationsRender(state: AnimationRuntimeState): void {
	try {
		for (const component of state.activeComponents) component.invalidate();
		const ui = getCurrentUi(state);
		renderWorkingAnimationFrame(state, ui);
		if (typeof ui?.requestRender === "function") {
			ui.requestRender();
		}
		// 不用 setHiddenThinkingLabel 作为逐帧刷新驱动：Pi 会因此重建全历史 AssistantMessage，长对话下会卡死。
	} catch (error) {
		writeAnimationDebugLog({ event: "render_fail", state, error });
		if (!isStaleCtxError(error)) console.debug?.("[alps-pi] Animations render request failed:", error);
	}
}

function renderWorkingAnimationFrame(state: AnimationRuntimeState, ui: any): boolean {
	if (!state.settings.enabled || !state.animating) return false;
	if (typeof ui?.setWorkingMessage !== "function") {
		writeAnimationDebugLog({ event: "working_render_skipped", state, note: "no_ui_target" });
		return false;
	}
	const phase = resolveCurrentPhase(state);
	const width = resolveAnimationWidth(state.settings.width, process.stdout.columns || 80);
	const lines = renderAnimationFrame(resolveAnimationNameForPhase(state, phase), state.frame, width, phase);
	if (isAnimationDebugEnabled()) state.lastWorkingLineWidths = summarizeWorkingLineWidths(lines);
	// 仅多行动画隐藏 Pi 原生 spinner，避免首行被额外前缀推后；单行动画保留原生 spinner。
	syncWorkingIndicatorForLines(state, ui, lines.length);
	const firstLine = lines[0] ?? "Working...";
	ui.setWorkingMessage(lines.length > 1 ? lines.join("\n") : firstLine);
	state.workingMessageApplied = true;
	writeAnimationDebugLog({ event: "working_render", state });
	if (state.workingWidgetApplied && typeof ui?.setWidget === "function") {
		ui.setWidget(WORKING_WIDGET_KEY, undefined);
		state.workingWidgetApplied = false;
	}
	state.lastWorkingLines = lines.length;
	return true;
}

/** 根据已渲染 working message 行数同步 Pi 原生 indicator；API 缺失时安全跳过，不影响动画文案。 */
function syncWorkingIndicatorForLines(state: AnimationRuntimeState, ui: any, lineCount: number): void {
	if (lineCount > 1) {
		hideWorkingIndicator(state, ui);
		return;
	}
	restoreWorkingIndicator(state, ui);
}

function hideWorkingIndicator(state: AnimationRuntimeState, ui: any): void {
	if (state.workingIndicatorHidden || typeof ui?.setWorkingIndicator !== "function") return;
	try {
		ui.setWorkingIndicator({ frames: [] });
		state.workingIndicatorHidden = true;
	} catch (error) {
		if (!isStaleCtxError(error)) console.debug?.("[alps-pi] Animations working indicator hide failed:", error);
	}
}

function restoreWorkingIndicator(state: AnimationRuntimeState, ui: any): void {
	if (!state.workingIndicatorHidden || typeof ui?.setWorkingIndicator !== "function") return;
	try {
		ui.setWorkingIndicator(undefined);
		state.workingIndicatorHidden = false;
	} catch (error) {
		if (!isStaleCtxError(error)) console.debug?.("[alps-pi] Animations working indicator restore failed:", error);
	}
}

function clearWorkingAnimation(state: AnimationRuntimeState): void {
	const shouldClearMessage = state.workingMessageApplied;
	const shouldClearWidget = state.workingWidgetApplied;
	const shouldRestoreIndicator = state.workingIndicatorHidden;
	state.workingMessageApplied = false;
	state.workingWidgetApplied = false;
	state.workingIndicatorHidden = false;
	state.lastWorkingLines = 0;
	state.lastWorkingLineWidths = [];
	if (!shouldClearMessage && !shouldClearWidget && !shouldRestoreIndicator) return;
	try {
		const ui = getCurrentUi(state);
		if (shouldClearWidget && typeof ui?.setWidget === "function") ui.setWidget(WORKING_WIDGET_KEY, undefined);
		if (shouldClearMessage && typeof ui?.setWorkingMessage === "function") ui.setWorkingMessage(undefined);
		if (shouldRestoreIndicator && typeof ui?.setWorkingIndicator === "function") ui.setWorkingIndicator(undefined);
	} catch (error) {
		if (!isStaleCtxError(error)) console.debug?.("[alps-pi] Animations working reset failed:", error);
	}
}

function resetHiddenThinkingLabel(state: AnimationRuntimeState): void {
	if (!state.hiddenLabelApplied) return;
	try {
		getCurrentUi(state)?.setHiddenThinkingLabel?.(undefined);
	} catch (error) {
		if (!isStaleCtxError(error)) console.debug?.("[alps-pi] Animations hidden label reset failed:", error);
	}
	state.hiddenLabelApplied = false;
}

function getCurrentUi(state: AnimationRuntimeState): any {
	const ctx = canWriteWorkingAnimation(state.currentUiCtx) ? state.currentUiCtx : canWriteWorkingAnimation(state.currentCtx) ? state.currentCtx : undefined;
	return ctx?.ui;
}

function resolveCurrentPhase(state: AnimationRuntimeState): AnimationPhase {
	if (state.thinkingActive) return "thinking";
	if (state.toolCallIds.size > 0) return "tool";
	return "working";
}

function resolveAnimationNameForPhase(state: AnimationRuntimeState, phase: AnimationPhase): string {
	if (!state.settings.randomMode) {
		if (phase === "thinking") return state.settings.thinking;
		if (phase === "tool") return state.settings.tool;
		return state.settings.working;
	}
	if (phase === "thinking") {
		if (!state.randomThinking) state.randomThinking = state.previousRandomThinking = pickRandomAnimation("thinking", state.previousRandomThinking);
		return state.randomThinking;
	}
	if (phase === "tool") {
		if (!state.randomTool) state.randomTool = state.previousRandomTool = pickRandomAnimation("working", state.previousRandomTool);
		return state.randomTool;
	}
	if (!state.randomWorking) state.randomWorking = state.previousRandomWorking = pickRandomAnimation("working", state.previousRandomWorking);
	return state.randomWorking;
}

function renderThinkingCompleteLabel(): string {
	return `\x1b[3m\x1b[38;5;141m${THINKING_DONE_LABEL}\x1b[39m\x1b[23m`;
}

function freezeAnimatedThinkingComponentsSoon(state: AnimationRuntimeState): void {
	// extension 事件早于 Pi interactive listener；用下一轮 macrotask 等最终 AssistantMessageComponent.updateContent 完成后再冻结。
	const freezeGeneration = state.freezeGeneration;
	const timer = setTimeout(() => {
		if (state.freezeGeneration !== freezeGeneration) return;
		for (const component of [...state.activeComponents]) component.freeze();
		requestAnimationsRender(state);
	}, 0);
	timer.unref?.();
}

function resetRandomAnimations(state: AnimationRuntimeState): void {
	state.randomWorking = undefined;
	state.randomThinking = undefined;
	state.randomTool = undefined;
}

function shouldRunTimer(state: AnimationRuntimeState): boolean {
	return state.settings.enabled && state.animating;
}

function hasActiveAnimationState(state: AnimationRuntimeState): boolean {
	return Boolean(
		state.animating
		|| state.timer
		|| state.thinkingActive
		|| state.toolCallIds.size > 0
		|| state.workingMessageApplied
		|| state.workingWidgetApplied
		|| state.workingIndicatorHidden
		|| state.activeComponents.size > 0
	);
}

function readToolCallId(event: any): string {
	return String(event?.toolCallId ?? "__unknown_tool__");
}

function bindEventCtx(state: AnimationRuntimeState, ctx?: any): void {
	if (!ctx || isStaleEventCtx(ctx)) return;
	state.currentEventCtx = ctx;
	if (!canWriteWorkingAnimation(ctx)) return;
	state.currentUiCtx = ctx;
	state.currentCtx = ctx;
}

/** 判断 ctx 是否能作为 working animation 输出目标。 */
function canWriteWorkingAnimation(ctx: any): boolean {
	return Boolean(ctx && ctx.hasUI !== false && typeof ctx.ui?.setWorkingMessage === "function");
}

function isStaleEventCtx(ctx?: any): boolean {
	return Boolean(ctx && ctx.isCurrent === false);
}

function rememberIgnoredAgentContext(state: AnimationRuntimeState, ctx?: any): void {
	if (ctx && (typeof ctx === "object" || typeof ctx === "function")) state.ignoredAgentContexts.add(ctx);
}

function isIgnoredAgentContext(state: AnimationRuntimeState, ctx?: any): boolean {
	return Boolean(ctx && (typeof ctx === "object" || typeof ctx === "function") && state.ignoredAgentContexts.has(ctx));
}

function isNestedAgentStart(state: AnimationRuntimeState, ctx?: any): boolean {
	if (!state.animating || !ctx) return false;
	if (ctx.hasUI === false && ctx !== state.currentUiCtx) return true;
	return Boolean(state.toolCallIds.size > 0 && ctx !== state.currentCtx);
}

function shouldIgnoreScopedEvent(state: AnimationRuntimeState, ctx?: any): boolean {
	return isStaleEventCtx(ctx) || isIgnoredAgentContext(state, ctx) || isNestedNonWritableEvent(state, ctx);
}

function isNestedNoUiEvent(state: AnimationRuntimeState, ctx?: any): boolean {
	return isNestedNonWritableEvent(state, ctx);
}

function isNestedNonWritableEvent(state: AnimationRuntimeState, ctx?: any): boolean {
	return Boolean(state.animating && ctx && ctx !== state.currentUiCtx && !isStaleEventCtx(ctx) && !canWriteWorkingAnimation(ctx));
}

function clearToolsForGeneration(state: AnimationRuntimeState, generation: number): void {
	for (const [id, owner] of [...state.toolOwners]) {
		if (owner !== generation) continue;
		state.toolOwners.delete(id);
		state.toolCallIds.delete(id);
	}
}

function isStaleCtxError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("extension ctx is stale") || message.includes("stale ctx");
}
