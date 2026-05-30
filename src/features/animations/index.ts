/** 功能：汇总 Animations 独立模块生命周期 API。 实现者：alps 实现日期：2026-05-29 */

import type { AnimationsSettings } from "./settings.ts";
import { enableAnimationsPatch, disableAnimationsPatch } from "./patch.ts";
import { bindAnimationsRuntimeSession, configureAnimationsRuntime, disposeAnimationsRuntime, handleAnimationsMessageEnd, handleAnimationsMessageUpdate, handleAnimationsToolExecutionEnd, handleAnimationsToolExecutionStart, pauseAnimationsRuntime, resumeAnimationsRuntime } from "./runtime.ts";

export { ANIMATIONS, getAnimation, getAnimationsForCategory, pickRandomAnimation, renderAnimationFrame, resolveAnimationWidth } from "./registry.ts";
export { AnimationsPreviewComponent } from "./preview.ts";
export type { AnimationCategory, AnimationDefinition, AnimationPhase, AnimationWidth } from "./registry.ts";
export { DEFAULT_ANIMATIONS_SETTINGS, normalizeAnimationsSettings } from "./settings.ts";
export type { AnimationsSettings } from "./settings.ts";
export { AnimatedThinkingComponent, THINKING_DONE_LABEL, getAnimationsRuntimeState, handleAnimationsMessageEnd, handleAnimationsMessageUpdate, handleAnimationsToolExecutionEnd, handleAnimationsToolExecutionStart, pauseAnimationsRuntime, resumeAnimationsRuntime } from "./runtime.ts";
export { disableAnimationsPatch, enableAnimationsPatch, getAnimationsPatchState } from "./patch.ts";

export function configureAnimations(settings: AnimationsSettings): void {
	configureAnimationsRuntime(settings);
	if (settings.enabled) {
		enableAnimationsPatch();
	} else {
		disableAnimationsPatch();
	}
}

export function bindAnimationsSession(ctx: any): void {
	bindAnimationsRuntimeSession(ctx);
}

export function disposeAnimations(): void {
	try {
		disposeAnimationsRuntime();
	} finally {
		disableAnimationsPatch();
	}
}
