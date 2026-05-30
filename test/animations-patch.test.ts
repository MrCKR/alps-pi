/** 功能：验证内置 Animations hidden thinking patch 生命周期。 实现者：alps 实现日期：2026-05-29 */

import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { enableAnimationsPatch, getAnimationsPatchState, configureAnimations, disposeAnimations, getAnimationsRuntimeState, handleAnimationsMessageEnd, handleAnimationsMessageUpdate, handleAnimationsToolExecutionEnd, handleAnimationsToolExecutionStart, pauseAnimationsRuntime, resumeAnimationsRuntime } from "../src/features/animations/index.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { stripAnsi } from "./helpers.test.ts";

function ensurePiTheme() {
	try {
		initTheme("default");
	} catch {
		// 已初始化时无需重复处理。
	}
}

function createMessage(thinking = "hidden thought") {
	return { content: [{ type: "thinking", thinking }] } as any;
}

test.afterEach(() => {
	disposeAnimations();
});

test("流式 hidden thinking label 被替换为动画 component", () => {
	ensurePiTheme();
	configureAnimations(DEFAULT_SETTINGS.animations);
	resumeAnimationsRuntime();
	const message = createMessage();
	handleAnimationsMessageUpdate({ message, assistantMessageEvent: { type: "thinking_delta" } });
	const component = new AssistantMessageComponent(message, true) as any;

	assert.equal(component.contentContainer.children.some((child: any) => child.constructor?.name === "AnimatedThinkingComponent"), true);
});

test("disable 后恢复原始 updateContent", () => {
	const proto = AssistantMessageComponent.prototype as any;
	const original = proto.updateContent;
	enableAnimationsPatch();
	assert.notEqual(proto.updateContent, original);
	disposeAnimations();
	assert.equal(proto.updateContent, original);
});

test("重复 enable 不重复包裹 updateContent", () => {
	const proto = AssistantMessageComponent.prototype as any;
	enableAnimationsPatch();
	const once = proto.updateContent;
	enableAnimationsPatch();
	assert.equal(proto.updateContent, once);
	assert.equal(getAnimationsPatchState().enabled, true);
});

test("disabled settings 不替换原生 Thinking label", () => {
	ensurePiTheme();
	configureAnimations({ ...DEFAULT_SETTINGS.animations, enabled: false });
	const component = new AssistantMessageComponent(createMessage(), true) as any;

	assert.equal(component.contentContainer.children.some((child: any) => child.constructor?.name === "AnimatedThinkingComponent"), false);
	assert.match(stripAnsi(component.render(80).join("\n")), /Thinking\.\.\./);
});

test("历史 hidden thinking 不注册动画组件，避免长对话 hidethink 切换卡死", () => {
	ensurePiTheme();
	configureAnimations(DEFAULT_SETTINGS.animations);
	const state = getAnimationsRuntimeState();
	for (let index = 0; index < 200; index += 1) {
		const component = new AssistantMessageComponent(createMessage(`hidden thought ${index}`), true) as any;
		assert.equal(component.contentContainer.children.some((child: any) => child.constructor?.name === "AnimatedThinkingComponent"), false);
	}

	assert.equal(state.activeComponents.size, 0);
});

test("已完成 hidden thinking 显示静态完成文案但不进入动画集合", () => {
	ensurePiTheme();
	configureAnimations(DEFAULT_SETTINGS.animations);
	const state = getAnimationsRuntimeState();
	const component = new AssistantMessageComponent({ content: [{ type: "thinking", thinking: "done" }, { type: "text", text: "answer" }] }, true) as any;

	assert.equal(component.contentContainer.children.some((child: any) => child.constructor?.name === "AnimatedThinkingComponent"), false);
	assert.match(stripAnsi(component.render(80).join("\n")), /Thinking complete/);
	assert.equal(state.activeComponents.size, 0);
});

test("多行动画 component render 返回多行，完成后显示 thinking 配色的英文完成文案", () => {
	const state = getAnimationsRuntimeState();
	const settings = { ...DEFAULT_SETTINGS.animations, thinking: "aurora" };
	configureAnimations(settings);
	resumeAnimationsRuntime();
	const message = createMessage();
	handleAnimationsMessageUpdate({ message, assistantMessageEvent: { type: "thinking_delta" } });
	const component = new AssistantMessageComponent(message, true) as any;
	const animated = component.contentContainer.children.find((child: any) => child.constructor?.name === "AnimatedThinkingComponent");
	assert.ok(animated);
	assert.equal(animated.render(80).length, 3);
	animated.freeze();
	const frozen = animated.render(80).join("\n");
	assert.match(stripAnsi(frozen), /Thinking complete/);
	assert.match(frozen, /\x1b\[[\d;]*m/);
	assert.equal(state.activeComponents.size, 0);
});

test("timer 在 agent 活跃期运行，并在 agent 结束后停止", () => {
	ensurePiTheme();
	configureAnimations(DEFAULT_SETTINGS.animations);
	const state = getAnimationsRuntimeState();
	assert.equal(state.timer, undefined);

	resumeAnimationsRuntime();
	assert.notEqual(state.timer, undefined);

	const message = createMessage();
	handleAnimationsMessageUpdate({ message, assistantMessageEvent: { type: "thinking_delta" } });
	const component = new AssistantMessageComponent(message, true) as any;
	const animated = component.contentContainer.children.find((child: any) => child.constructor?.name === "AnimatedThinkingComponent");
	assert.ok(animated);
	assert.notEqual(state.timer, undefined);

	animated.dispose();
	assert.notEqual(state.timer, undefined);

	pauseAnimationsRuntime();
	assert.equal(state.timer, undefined);
});

test("无 requestRender 和 working loader 时不通过 hidden label API 逐帧重建历史", async () => {
	ensurePiTheme();
	const labels: Array<string | undefined> = [];
	configureAnimations({ ...DEFAULT_SETTINGS.animations, thinking: "shimmer", width: "default", fps: 30 });
	const state = getAnimationsRuntimeState();
	state.currentCtx = { ui: { setHiddenThinkingLabel: (label?: string) => labels.push(label) } };
	resumeAnimationsRuntime();
	const message = createMessage();
	handleAnimationsMessageUpdate({ message, assistantMessageEvent: { type: "thinking_delta" } });
	const component = new AssistantMessageComponent(message, true) as any;
	assert.ok(component.contentContainer.children.some((child: any) => child.constructor?.name === "AnimatedThinkingComponent"));

	await new Promise((resolve) => setTimeout(resolve, 45));
	assert.deepEqual(labels, []);

	pauseAnimationsRuntime();
	configureAnimations({ ...DEFAULT_SETTINGS.animations, enabled: false });
	assert.deepEqual(labels, []);
});

test("热重载旧 runtime state 会自动补齐新增字段", () => {
	const state = getAnimationsRuntimeState();
	(state as any).toolCallIds = undefined;
	(state as any).thinkingActive = undefined;
	(state as any).workingMessageApplied = undefined;

	assert.doesNotThrow(() => pauseAnimationsRuntime());
	assert.ok(getAnimationsRuntimeState().toolCallIds instanceof Set);
});

test("agent 活跃期接管底部 working、thinking 和 tool 动画", () => {
	const workingMessages: Array<string | undefined> = [];
	const widgets: Array<{ key: string; content?: string[] }> = [];
	configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "crush", thinking: "shimmer", tool: "pipeline", width: "default" });
	const state = getAnimationsRuntimeState();
	state.currentCtx = {
		ui: {
			setWorkingMessage: (message?: string) => workingMessages.push(message),
			setWidget: (key: string, content?: string[]) => widgets.push({ key, content }),
		},
	};

	resumeAnimationsRuntime();
	assert.match(stripAnsi(workingMessages.at(-1) ?? ""), /Working/);

	handleAnimationsMessageUpdate({ assistantMessageEvent: { type: "thinking_delta" } });
	assert.match(stripAnsi(workingMessages.at(-1) ?? ""), /Thinking/);

	handleAnimationsMessageUpdate({ assistantMessageEvent: { type: "text_delta" } });
	handleAnimationsToolExecutionStart({ toolCallId: "tool-1" });
	assert.equal(state.toolCallIds.has("tool-1"), true);
	assert.notEqual(workingMessages.at(-1), undefined);

	handleAnimationsToolExecutionEnd({ toolCallId: "tool-1" });
	assert.match(stripAnsi(workingMessages.at(-1) ?? ""), /Working/);

	handleAnimationsMessageEnd();
	assert.notEqual(workingMessages.at(-1), undefined);

	pauseAnimationsRuntime();
	assert.equal(workingMessages.at(-1), undefined);
});

test("多行底部动画整体写入 working message，并清理旧 widget 残留", () => {
	const workingMessages: Array<string | undefined> = [];
	const widgets: Array<{ key: string; content?: string[] }> = [];
	configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "matrix3", width: "default" });
	const state = getAnimationsRuntimeState();
	state.currentCtx = {
		ui: {
			setWorkingMessage: (message?: string) => workingMessages.push(message),
			setWidget: (key: string, content?: string[]) => widgets.push({ key, content }),
		},
	};

	resumeAnimationsRuntime();
	assert.equal(typeof workingMessages.at(-1), "string");
	assert.equal((workingMessages.at(-1) ?? "").split("\n").length, 3);
	assert.equal(widgets.at(-1)?.content, undefined);

	pauseAnimationsRuntime();
	assert.equal(workingMessages.at(-1), undefined);
});

