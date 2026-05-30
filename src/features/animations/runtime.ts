/** 功能：维护 Animations 动画帧、working/status 接管、hidden thinking 替换与会话绑定。 实现者：alps 实现日期：2026-05-29 */

import type { Component } from "@earendil-works/pi-tui";
import { type AnimationsSettings, cloneDefaultAnimationsSettings, normalizeAnimationsSettings } from "./settings.ts";
import { pickRandomAnimation, renderAnimationFrame, resolveAnimationWidth, type AnimationPhase } from "./registry.ts";

const WORKING_WIDGET_KEY = "alps-pi-animations";
export const THINKING_DONE_LABEL = "Thinking complete";

export type AnimationRuntimeState = {
	settings: AnimationsSettings;
	frame: number;
	timer: ReturnType<typeof setInterval> | undefined;
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
	/** 是否曾通过 Pi 原生 hidden label API 驱动重绘；关闭时用于恢复默认 label。 */
	hiddenLabelApplied: boolean;
	/** 是否曾写入底部 working message；停止时用于恢复 Pi 默认文案。 */
	workingMessageApplied: boolean;
	/** 是否曾写入多行动画 widget；停止时用于清理旧版本或外部插件残留。 */
	workingWidgetApplied: boolean;
	/** 上一帧底部动画行数；用于测试与后续排查单行/多行切换。 */
	lastWorkingLines: number;
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
		hiddenLabelApplied: false,
		workingMessageApplied: false,
		workingWidgetApplied: false,
		lastWorkingLines: 0,
		currentAssistantMessage: undefined,
		freezeGeneration: 0,
	};
}

function migrateAnimationsRuntimeState(existing: Partial<AnimationRuntimeState>): AnimationRuntimeState {
	// /reload 会复用 Symbol.for 下的旧对象；新字段必须补齐，避免旧 runtime state 崩溃。
	existing.settings = normalizeAnimationsSettings(existing.settings ?? cloneDefaultAnimationsSettings());
	if (typeof existing.frame !== "number") existing.frame = 0;
	if (!(existing.activeComponents instanceof Set)) existing.activeComponents = new Set();
	if (!(existing.toolCallIds instanceof Set)) existing.toolCallIds = new Set();
	if (typeof existing.animating !== "boolean") existing.animating = false;
	if (typeof existing.thinkingActive !== "boolean") existing.thinkingActive = false;
	if (typeof existing.previousRandomWorking !== "string") existing.previousRandomWorking = undefined;
	if (typeof existing.previousRandomThinking !== "string") existing.previousRandomThinking = undefined;
	if (typeof existing.previousRandomTool !== "string") existing.previousRandomTool = undefined;
	if (typeof existing.hiddenLabelApplied !== "boolean") existing.hiddenLabelApplied = false;
	if (typeof existing.workingMessageApplied !== "boolean") existing.workingMessageApplied = false;
	if (typeof existing.workingWidgetApplied !== "boolean") existing.workingWidgetApplied = false;
	if (typeof existing.lastWorkingLines !== "number") existing.lastWorkingLines = 0;
	if (!("currentAssistantMessage" in existing)) existing.currentAssistantMessage = undefined;
	if (typeof existing.freezeGeneration !== "number") existing.freezeGeneration = 0;
	return existing as AnimationRuntimeState;
}

export function configureAnimationsRuntime(settings: AnimationsSettings): void {
	const state = getAnimationsRuntimeState();
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
	state.currentCtx = ctx;
}

/** agent 开始输出时接管底部 Working/Thinking/Tool 动画，并驱动 hidden thinking 组件刷新。 */
export function resumeAnimationsRuntime(): void {
	const state = getAnimationsRuntimeState();
	state.animating = true;
	state.thinkingActive = false;
	state.toolCallIds.clear();
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
	state.animating = false;
	state.thinkingActive = false;
	state.toolCallIds.clear();
	state.currentAssistantMessage = undefined;
	freezeAnimatedThinkingComponentsSoon(state);
	stopTimer(state);
	clearWorkingAnimation(state);
	resetHiddenThinkingLabel(state);
}

/** 根据 assistant 流式事件切换 bottom 动画 phase；thinking 优先于 tool/working。 */
export function handleAnimationsMessageUpdate(event: any): void {
	const state = getAnimationsRuntimeState();
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
export function handleAnimationsMessageEnd(): void {
	const state = getAnimationsRuntimeState();
	state.thinkingActive = false;
	state.currentAssistantMessage = undefined;
	freezeAnimatedThinkingComponentsSoon(state);
	requestAnimationsRender(state);
}

/** tool 开始执行时切换到底部 tool 动画；多 tool 并行时保留计数。 */
export function handleAnimationsToolExecutionStart(event: any): void {
	const state = getAnimationsRuntimeState();
	state.toolCallIds.add(readToolCallId(event));
	requestAnimationsRender(state);
}

/** tool 执行完成后移除对应 id；没有 tool 时回到 working 动画。 */
export function handleAnimationsToolExecutionEnd(event: any): void {
	const state = getAnimationsRuntimeState();
	const id = readToolCallId(event);
	if (event?.toolCallId === undefined) state.toolCallIds.clear();
	else state.toolCallIds.delete(id);
	requestAnimationsRender(state);
}

export function disposeAnimationsRuntime(): void {
	const state = getAnimationsRuntimeState();
	pauseAnimationsRuntime();
	for (const component of state.activeComponents) component.dispose();
	state.activeComponents.clear();
	state.currentCtx = undefined;
	resetRandomAnimations(state);
}

function startTimer(state: AnimationRuntimeState): void {
	stopTimer(state);
	const fps = Math.max(1, state.settings.fps);
	state.timer = setInterval(() => {
		state.frame += 1;
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
		if (!isStaleCtxError(error)) console.debug?.("[alps-pi] Animations render request failed:", error);
	}
}

function renderWorkingAnimationFrame(state: AnimationRuntimeState, ui: any): boolean {
	if (!state.settings.enabled || !state.animating || typeof ui?.setWorkingMessage !== "function") return false;
	const phase = resolveCurrentPhase(state);
	const width = resolveAnimationWidth(state.settings.width, process.stdout.columns || 80);
	const lines = renderAnimationFrame(resolveAnimationNameForPhase(state, phase), state.frame, width, phase);
	const firstLine = lines[0] ?? "Working...";
	ui.setWorkingMessage(lines.length > 1 ? lines.join("\n") : firstLine);
	state.workingMessageApplied = true;
	if (state.workingWidgetApplied && typeof ui?.setWidget === "function") {
		ui.setWidget(WORKING_WIDGET_KEY, undefined);
		state.workingWidgetApplied = false;
	}
	state.lastWorkingLines = lines.length;
	return true;
}

function clearWorkingAnimation(state: AnimationRuntimeState): void {
	const shouldClearMessage = state.workingMessageApplied;
	const shouldClearWidget = state.workingWidgetApplied;
	state.workingMessageApplied = false;
	state.workingWidgetApplied = false;
	state.lastWorkingLines = 0;
	if (!shouldClearMessage && !shouldClearWidget) return;
	try {
		const ui = getCurrentUi(state);
		if (shouldClearWidget && typeof ui?.setWidget === "function") ui.setWidget(WORKING_WIDGET_KEY, undefined);
		if (shouldClearMessage && typeof ui?.setWorkingMessage === "function") ui.setWorkingMessage(undefined);
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
	return state.currentCtx?.hasUI === false ? undefined : state.currentCtx?.ui;
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

function readToolCallId(event: any): string {
	return String(event?.toolCallId ?? "__unknown_tool__");
}

function isStaleCtxError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("extension ctx is stale") || message.includes("stale ctx");
}
