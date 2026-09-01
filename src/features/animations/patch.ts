/** 功能：独立 patch AssistantMessageComponent hidden thinking label 为 alps 内置动画。 实现者：alps 实现日期：2026-05-29 */

import { Text } from "@earendil-works/pi-tui";
import { PI_COMPONENTS, inspectPiRuntimeCapabilities, type PiRuntimeCapabilities } from "../../pi-compat.ts";
import { AnimatedThinkingComponent, THINKING_DONE_LABEL, getAnimationsRuntimeState } from "./runtime.ts";

const { AssistantMessageComponent } = PI_COMPONENTS;
const ANIMATIONS_PATCH_KEY = Symbol.for("alps.pi.animations.patch.v1");

export type AnimationsPatchState = {
	enabled: boolean;
	originalUpdateContent?: Function;
	wrappedUpdateContent?: Function;
	failure?: string;
};

export function getAnimationsPatchState(): AnimationsPatchState {
	const existing = (globalThis as any)[ANIMATIONS_PATCH_KEY] as AnimationsPatchState | undefined;
	if (existing) return existing;
	const state: AnimationsPatchState = { enabled: false };
	(globalThis as any)[ANIMATIONS_PATCH_KEY] = state;
	return state;
}

export function enableAnimationsPatch(capabilities: PiRuntimeCapabilities = inspectPiRuntimeCapabilities()): AnimationsPatchState {
	const state = getAnimationsPatchState();
	const proto = AssistantMessageComponent.prototype as any;
	state.failure = undefined;
	if (!capabilities.animations.supported) {
		state.enabled = false;
		state.failure = capabilities.animations.failure ?? "animations capability unavailable";
		return state;
	}
	if (state.enabled && proto.updateContent === state.wrappedUpdateContent) return state;
	if (typeof proto.updateContent !== "function") {
		state.failure = "AssistantMessageComponent.prototype.updateContent missing";
		return state;
	}
	const original = state.originalUpdateContent ?? proto.updateContent;
	state.originalUpdateContent = original;
	state.wrappedUpdateContent = function patchedUpdateContent(this: any, ...args: any[]) {
		const message = args[0];
		try {
			if (this.__alpsPiAnimatedThinkingApplied) disposeExistingAnimatedThinking(this);
		} catch {
			// 清理旧动画组件失败不能阻断 Pi 原生渲染。
		}
		Reflect.apply(original, this, args);
		try {
			replaceHiddenThinkingLabels(this, message);
		} catch (error) {
			console.debug?.("[alps-pi] Animations hidden thinking patch failed:", error);
		}
	};
	proto.updateContent = state.wrappedUpdateContent;
	state.enabled = true;
	return state;
}

export function disableAnimationsPatch(): AnimationsPatchState {
	const state = getAnimationsPatchState();
	const proto = AssistantMessageComponent.prototype as any;
	if (state.originalUpdateContent && proto.updateContent === state.wrappedUpdateContent) {
		proto.updateContent = state.originalUpdateContent;
	}
	state.enabled = false;
	state.wrappedUpdateContent = undefined;
	state.originalUpdateContent = undefined;
	state.failure = undefined;
	return state;
}

function disposeExistingAnimatedThinking(instance: any): void {
	const children = instance?.contentContainer?.children;
	if (!Array.isArray(children)) return;
	for (const child of children) {
		if (child instanceof AnimatedThinkingComponent) child.dispose();
	}
	instance.__alpsPiAnimatedThinkingApplied = false;
}

function replaceHiddenThinkingLabels(instance: any, message: any): void {
	const runtimeState = getAnimationsRuntimeState();
	if (!runtimeState.settings.enabled) return;
	if (!instance?.hideThinkingBlock) return;
	if (!messageHasThinking(message)) return;
	const children = instance.contentContainer?.children;
	if (!Array.isArray(children)) return;
	const shouldAnimate = shouldAnimateHiddenThinking(runtimeState, message);
	for (let index = 0; index < children.length; index += 1) {
		const child = children[index];
		if (!isHiddenThinkingText(instance, child)) continue;
		if (shouldAnimate) {
			children[index] = new AnimatedThinkingComponent(runtimeState, undefined, false, readStyledCompletionLabel(child), readOutputPad(instance));
			instance.__alpsPiAnimatedThinkingApplied = true;
		} else if (shouldFreezeHiddenThinking(message)) {
			children[index] = createCompletedThinkingText(child, readOutputPad(instance));
		}
	}
}

function messageHasThinking(message: any): boolean {
	return Array.isArray(message?.content) && message.content.some((content: any) => content?.type === "thinking" && typeof content.thinking === "string" && content.thinking.trim());
}

function shouldFreezeHiddenThinking(message: any): boolean {
	return message?.stopReason !== undefined || Array.isArray(message?.content) && message.content.some((content: any) => content?.type === "text" && typeof content.text === "string" && content.text.trim());
}

function shouldAnimateHiddenThinking(runtimeState: ReturnType<typeof getAnimationsRuntimeState>, message: any): boolean {
	// 只动画当前流式 assistant；长历史切换 hidethink 会全量重建，不能把旧消息全部注册成动态组件。
	return runtimeState.animating && runtimeState.currentAssistantMessage === message && !shouldFreezeHiddenThinking(message);
}

function createCompletedThinkingText(child: any, outputPad: number): Text {
	// 完成态保持原生 Text 组件，避免历史消息进入动画 timer/activeComponents 集合。
	return new Text(readStyledCompletionLabel(child) ?? THINKING_DONE_LABEL, outputPad, 0);
}

function readOutputPad(instance: any): number {
	return instance?.outputPad === 0 ? 0 : 1;
}

function readStyledCompletionLabel(child: any): string | undefined {
	return typeof child?.text === "string" ? child.text.replace(/Thinking\.\.\./g, THINKING_DONE_LABEL) : undefined;
}

function isHiddenThinkingText(instance: any, child: any): boolean {
	if (!child || typeof child.text !== "string") return false;
	const label = typeof instance.hiddenThinkingLabel === "string" ? instance.hiddenThinkingLabel : "Thinking...";
	return child.text.includes(label) || child.text.includes("Thinking...") || child.text.includes(THINKING_DONE_LABEL);
}
