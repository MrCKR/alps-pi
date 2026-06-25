/** 功能：验证内置 Animations hidden thinking patch 生命周期。 实现者：alps 实现日期：2026-05-29 */

import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { bindAnimationsSession, enableAnimationsPatch, getAnimationsPatchState, configureAnimations, configureAnimationsRenderRequest, disposeAnimations, getAnimationsRuntimeState, handleAnimationsAgentEnd, handleAnimationsAgentStart, handleAnimationsMessageEnd, handleAnimationsMessageUpdate, handleAnimationsToolExecutionEnd, handleAnimationsToolExecutionStart, pauseAnimationsRuntime, resumeAnimationsRuntime } from "../src/features/animations/index.ts";
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

test("Animations tick 使用注入局部重绘回调，不触发 UI full render", async () => {
	ensurePiTheme();
	const workingMessages: string[] = [];
	let localRepaints = 0;
	let fullRenders = 0;
	configureAnimations({ ...DEFAULT_SETTINGS.animations, enabled: true, working: "crush", width: "default", fps: 60 });
	configureAnimationsRenderRequest(() => {
		localRepaints += 1;
	});
	const state = getAnimationsRuntimeState();
	state.currentCtx = {
		ui: {
			setWorkingMessage: (message: string) => workingMessages.push(message),
			requestRender: () => {
				fullRenders += 1;
			},
		},
	};
	state.currentUiCtx = state.currentCtx;

	try {
		resumeAnimationsRuntime();
		await new Promise((resolve) => setTimeout(resolve, 45));

		assert.ok(workingMessages.length > 0);
		assert.ok(localRepaints > 0);
		assert.equal(fullRenders, 0);
	} finally {
		configureAnimationsRenderRequest(undefined);
		pauseAnimationsRuntime();
		configureAnimations({ ...DEFAULT_SETTINGS.animations, enabled: false });
	}
});

test("无 requestRender 和 working loader 时不通过 hidden label API 逐帧重建历史", async () => {
	ensurePiTheme();
	const labels: Array<string | undefined> = [];
	configureAnimations({ ...DEFAULT_SETTINGS.animations, thinking: "shimmer", width: "default", fps: 30 });
	const state = getAnimationsRuntimeState();
	state.currentCtx = { ui: { setHiddenThinkingLabel: (label?: string) => labels.push(label) } };
	state.currentUiCtx = state.currentCtx;
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

test("stale ctx ui getter 不会让动画清理抛出且会移除旧 UI 引用", () => {
	configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "matrix3", width: "default" });
	const state = getAnimationsRuntimeState();
	const staleCtx = {
		id: "stale-reload-ctx",
		get ui() {
			throw new Error("extension ctx is stale");
		},
	};
	state.currentCtx = staleCtx;
	state.currentUiCtx = staleCtx;
	state.currentEventCtx = staleCtx;
	state.animating = true;
	state.workingMessageApplied = true;
	state.workingIndicatorHidden = true;

	assert.doesNotThrow(() => pauseAnimationsRuntime());
	assert.equal(state.currentCtx, undefined);
	assert.equal(state.currentUiCtx, undefined);
	assert.equal(state.currentEventCtx, undefined);
	assert.equal(state.animating, false);
	assert.equal(state.timer, undefined);
});

test("stale ctx ui getter 不会在新事件 scope 判断中冒泡", () => {
	configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "matrix3", width: "default" });
	const state = getAnimationsRuntimeState();
	const staleCtx = {
		id: "stale-event-ctx",
		get ui() {
			throw new Error("stale ctx");
		},
	};

	assert.doesNotThrow(() => handleAnimationsAgentStart({}, staleCtx));
	assert.equal(state.currentCtx, undefined);
	assert.equal(state.currentUiCtx, undefined);
	assert.equal(state.animating, true);
	assert.doesNotThrow(() => pauseAnimationsRuntime());
});

test("agent 活跃期接管底部 working、thinking 和 tool 单行动画时保留原生 spinner", () => {
	const workingMessages: Array<string | undefined> = [];
	const indicators: Array<unknown> = [];
	const widgets: Array<{ key: string; content?: string[] }> = [];
	configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "crush", thinking: "shimmer", tool: "pipeline", width: "default" });
	const state = getAnimationsRuntimeState();
	state.currentCtx = {
		ui: {
			setWorkingIndicator: (indicator?: unknown) => indicators.push(indicator),
			setWorkingMessage: (message?: string) => workingMessages.push(message),
			setWidget: (key: string, content?: string[]) => widgets.push({ key, content }),
		},
	};
	state.currentUiCtx = state.currentCtx;

	resumeAnimationsRuntime();
	assert.equal(indicators.length, 0);
	assert.match(stripAnsi(workingMessages.at(-1) ?? ""), /Working/);

	handleAnimationsMessageUpdate({ assistantMessageEvent: { type: "thinking_delta" } });
	assert.equal(indicators.length, 0);
	assert.match(stripAnsi(workingMessages.at(-1) ?? ""), /Thinking/);

	handleAnimationsMessageUpdate({ assistantMessageEvent: { type: "text_delta" } });
	handleAnimationsToolExecutionStart({ toolCallId: "tool-1" });
	assert.equal(state.toolCallIds.has("tool-1"), true);
	assert.notEqual(workingMessages.at(-1), undefined);
	assert.equal(indicators.length, 0);

	handleAnimationsToolExecutionEnd({ toolCallId: "tool-1" });
	assert.match(stripAnsi(workingMessages.at(-1) ?? ""), /Working/);

	handleAnimationsMessageEnd();
	assert.notEqual(workingMessages.at(-1), undefined);

	pauseAnimationsRuntime();
	assert.equal(workingMessages.at(-1), undefined);
	assert.equal(indicators.length, 0);
});

test("多行底部动画整体写入 working message，隐藏原生 spinner 且不用补空格方案", () => {
	const workingMessages: Array<string | undefined> = [];
	const indicators: Array<unknown> = [];
	const widgets: Array<{ key: string; content?: string[] }> = [];
	configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "matrix3", width: "default" });
	const state = getAnimationsRuntimeState();
	state.currentCtx = {
		ui: {
			setWorkingIndicator: (indicator?: unknown) => indicators.push(indicator),
			setWorkingMessage: (message?: string) => workingMessages.push(message),
			setWidget: (key: string, content?: string[]) => widgets.push({ key, content }),
		},
	};
	state.currentUiCtx = state.currentCtx;

	resumeAnimationsRuntime();
	const message = workingMessages.at(-1) ?? "";
	const lines = message.split("\n");
	assert.equal(typeof message, "string");
	assert.equal(lines.length, 3);
	assert.ok(lines.every((line) => !line.startsWith("  ")));
	assert.deepEqual(indicators.at(-1), { frames: [] });
	assert.equal(widgets.at(-1)?.content, undefined);

	pauseAnimationsRuntime();
	assert.equal(workingMessages.at(-1), undefined);
	assert.equal(indicators.at(-1), undefined);
});

test("多行动画切回单行动画会恢复原生 spinner", () => {
	const workingMessages: Array<string | undefined> = [];
	const indicators: Array<unknown> = [];
	configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "matrix3", width: "default" });
	const state = getAnimationsRuntimeState();
	state.currentCtx = {
		ui: {
			setWorkingIndicator: (indicator?: unknown) => indicators.push(indicator),
			setWorkingMessage: (message?: string) => workingMessages.push(message),
		},
	};
	state.currentUiCtx = state.currentCtx;

	resumeAnimationsRuntime();
	assert.deepEqual(indicators.at(-1), { frames: [] });
	assert.equal((workingMessages.at(-1) ?? "").split("\n").length, 3);

	configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "crush", width: "default" });
	assert.equal(indicators.at(-1), undefined);
	assert.equal((workingMessages.at(-1) ?? "").split("\n").length, 1);
});

test("多行动画在 pause、settings disable 和 dispose 时恢复原生 spinner", () => {
	for (const action of ["pause", "disable", "dispose"] as const) {
		disposeAnimations();
		const workingMessages: Array<string | undefined> = [];
		const indicators: Array<unknown> = [];
		configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "matrix3", width: "default" });
		const state = getAnimationsRuntimeState();
		state.currentCtx = {
			ui: {
				setWorkingIndicator: (indicator?: unknown) => indicators.push(indicator),
				setWorkingMessage: (message?: string) => workingMessages.push(message),
			},
		};
		state.currentUiCtx = state.currentCtx;

		resumeAnimationsRuntime();
		assert.deepEqual(indicators.at(-1), { frames: [] });
		if (action === "pause") pauseAnimationsRuntime();
		else if (action === "disable") configureAnimations({ ...DEFAULT_SETTINGS.animations, enabled: false, working: "matrix3", width: "default" });
		else disposeAnimations();
		assert.equal(workingMessages.at(-1), undefined);
		assert.equal(indicators.at(-1), undefined);
	}
});

test("父级 tool 与子代理事件交错时动画不早停，agent_end 最终清理", () => {
	const workingMessages: Array<string | undefined> = [];
	const indicators: Array<unknown> = [];
	configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "matrix3", tool: "matrix3", width: "default" });
	const parentCtx = {
		id: "parent",
		ui: {
			setWorkingIndicator: (indicator?: unknown) => indicators.push(indicator),
			setWorkingMessage: (message?: string) => workingMessages.push(message),
		},
	};
	const subCtx = { id: "sub", ui: parentCtx.ui };
	const staleParentCtx = { ...parentCtx, isCurrent: false };

	handleAnimationsAgentStart({}, parentCtx);
	handleAnimationsToolExecutionStart({ toolCallId: "tool-parent" }, parentCtx);
	const state = getAnimationsRuntimeState();
	assert.equal(state.animating, true);
	assert.equal(state.toolCallIds.has("tool-parent"), true);
	assert.equal(workingMessages.at(-1)?.includes("\n"), true);

	handleAnimationsAgentStart({}, subCtx);
	handleAnimationsMessageEnd(subCtx);
	assert.equal(state.animating, true);
	assert.equal(state.toolCallIds.has("tool-parent"), true);
	assert.notEqual(workingMessages.at(-1), undefined);

	handleAnimationsToolExecutionEnd({ toolCallId: "tool-parent" }, staleParentCtx);
	assert.equal(state.animating, true);
	assert.equal(state.toolCallIds.has("tool-parent"), false);
	assert.notEqual(workingMessages.at(-1), undefined);

	handleAnimationsAgentEnd({}, parentCtx);
	assert.equal(state.animating, false);
	assert.equal(state.timer, undefined);
	assert.equal(workingMessages.at(-1), undefined);
	assert.equal(indicators.at(-1), undefined);

	handleAnimationsToolExecutionEnd({ toolCallId: "tool-parent" }, staleParentCtx);
	assert.equal(state.animating, false);
	assert.equal(state.timer, undefined);
	assert.equal(workingMessages.at(-1), undefined);
});

test("stale parent agent_end 使用当前 ctx 清理且不覆盖 currentCtx", () => {
	const workingMessages: Array<string | undefined> = [];
	const indicators: Array<unknown> = [];
	configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "matrix3", width: "default" });
	const parentCtx = {
		id: "parent-current",
		ui: {
			setWorkingIndicator: (indicator?: unknown) => indicators.push(indicator),
			setWorkingMessage: (message?: string) => workingMessages.push(message),
		},
	};
	const staleParentCtx = { id: "parent-stale", isCurrent: false, ui: parentCtx.ui };

	handleAnimationsAgentStart({}, parentCtx);
	const state = getAnimationsRuntimeState();
	assert.equal(state.currentCtx, parentCtx);
	assert.equal(state.animating, true);
	assert.deepEqual(indicators.at(-1), { frames: [] });
	assert.notEqual(workingMessages.at(-1), undefined);

	handleAnimationsAgentEnd({}, staleParentCtx);
	assert.equal(state.currentCtx, parentCtx);
	assert.equal(state.animating, false);
	assert.equal(state.timer, undefined);
	assert.equal(workingMessages.at(-1), undefined);
	assert.equal(indicators.at(-1), undefined);
});

test("nested agent_end 不清理父级动画", () => {
	const workingMessages: Array<string | undefined> = [];
	configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "matrix3", tool: "matrix3", width: "default" });
	const parentCtx = { id: "parent", ui: { setWorkingMessage: (message?: string) => workingMessages.push(message), setWorkingIndicator() {} } };
	const subCtx = { id: "sub", ui: parentCtx.ui };

	handleAnimationsAgentStart({}, parentCtx);
	handleAnimationsToolExecutionStart({ toolCallId: "tool-parent" }, parentCtx);
	const state = getAnimationsRuntimeState();
	handleAnimationsAgentStart({}, subCtx);
	handleAnimationsAgentEnd({}, subCtx);

	assert.equal(state.animating, true);
	assert.equal(state.currentCtx, parentCtx);
	assert.equal(state.toolCallIds.has("tool-parent"), true);
	assert.notEqual(workingMessages.at(-1), undefined);
});

test("agent_end 后 late tool_execution_end 不复活动画", () => {
	const workingMessages: Array<string | undefined> = [];
	const indicators: Array<unknown> = [];
	configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "matrix3", tool: "matrix3", width: "default" });
	const parentCtx = {
		id: "parent",
		ui: {
			setWorkingIndicator: (indicator?: unknown) => indicators.push(indicator),
			setWorkingMessage: (message?: string) => workingMessages.push(message),
		},
	};
	const staleParentCtx = { id: "parent-stale", isCurrent: false, ui: parentCtx.ui };

	handleAnimationsAgentStart({}, parentCtx);
	handleAnimationsToolExecutionStart({ toolCallId: "tool-parent" }, parentCtx);
	handleAnimationsAgentEnd({}, parentCtx);
	const writesAfterEnd = workingMessages.length;
	const indicatorsAfterEnd = indicators.length;
	const state = getAnimationsRuntimeState();

	handleAnimationsToolExecutionEnd({ toolCallId: "tool-parent" }, staleParentCtx);
	assert.equal(state.animating, false);
	assert.equal(state.timer, undefined);
	assert.equal(workingMessages.length, writesAfterEnd);
	assert.equal(indicators.length, indicatorsAfterEnd);
	assert.equal(workingMessages.at(-1), undefined);
	assert.equal(indicators.at(-1), undefined);
});

test("nested no-UI session_start 不覆盖父级 working UI target", () => {
	const workingMessages: Array<string | undefined> = [];
	configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "matrix3", tool: "matrix3", width: "default" });
	const parentCtx = {
		id: "parent-ui",
		ui: {
			setWorkingMessage: (message?: string) => workingMessages.push(message),
			setWorkingIndicator() {},
		},
	};
	const noUiCtx = { id: "nested-no-ui", hasUI: false };

	bindAnimationsSession(parentCtx);
	handleAnimationsAgentStart({}, parentCtx);
	handleAnimationsToolExecutionStart({ toolCallId: "tool-parent" }, parentCtx);
	const state = getAnimationsRuntimeState();
	const writesBeforeNested = workingMessages.length;

	bindAnimationsSession(noUiCtx);
	handleAnimationsMessageEnd(noUiCtx);
	handleAnimationsToolExecutionEnd({ toolCallId: "tool-parent" }, noUiCtx);
	assert.equal(state.currentUiCtx, parentCtx);
	assert.equal(state.currentCtx, parentCtx);
	assert.equal(state.toolCallIds.has("tool-parent"), true);
	assert.equal(state.animating, true);

	(state as any).frame += 1;
	(state as any).timer && clearInterval((state as any).timer);
	(state as any).timer = undefined;
	configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "matrix3", tool: "matrix3", width: "default" });
	assert.ok(workingMessages.length > writesBeforeNested);
	assert.notEqual(workingMessages.at(-1), undefined);

	handleAnimationsAgentEnd({}, parentCtx);
	assert.equal(workingMessages.at(-1), undefined);
});

test("no-UI agent_start 在无 active tool 时不重置父级动画", async () => {
	const workingMessages: Array<string | undefined> = [];
	const indicators: Array<unknown> = [];
	configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "matrix3", width: "default", fps: 60 });
	const parentCtx = {
		id: "parent-ui",
		ui: {
			setWorkingIndicator: (indicator?: unknown) => indicators.push(indicator),
			setWorkingMessage: (message?: string) => workingMessages.push(message),
		},
	};
	const noUiCtx = { id: "nested-no-ui-agent", hasUI: false };

	bindAnimationsSession(parentCtx);
	resumeAnimationsRuntime();
	const state = getAnimationsRuntimeState();
	state.frame = 5;
	const generationBefore = state.agentGeneration;
	const currentUiBefore = state.currentUiCtx;
	const currentCtxBefore = state.currentCtx;
	const writesBeforeNested = workingMessages.length;
	assert.equal(state.toolCallIds.size, 0);

	handleAnimationsAgentStart({}, noUiCtx);
	assert.equal(state.frame, 5);
	assert.equal(state.agentGeneration, generationBefore);
	assert.equal(state.currentUiCtx, currentUiBefore);
	assert.equal(state.currentCtx, currentCtxBefore);
	assert.equal(state.toolCallIds.size, 0);
	assert.equal(state.animating, true);

	handleAnimationsMessageEnd(noUiCtx);
	handleAnimationsToolExecutionEnd({ toolCallId: "tool-from-no-ui" }, noUiCtx);
	handleAnimationsAgentEnd({}, noUiCtx);
	assert.equal(state.animating, true);
	assert.equal(state.currentUiCtx, parentCtx);
	assert.notEqual(workingMessages.at(-1), undefined);
	assert.notEqual(indicators.at(-1), undefined);

	assert.notEqual(state.timer, undefined);
	const deadline = Date.now() + 250;
	while (state.frame <= 5 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(state.frame > 5);
	assert.ok(workingMessages.length > writesBeforeNested);
	assert.equal(state.currentUiCtx, parentCtx);
	assert.equal(state.animating, true);

	handleAnimationsAgentEnd({}, parentCtx);
	assert.equal(state.animating, false);
	assert.equal(state.timer, undefined);
	assert.equal(workingMessages.at(-1), undefined);
	assert.equal(indicators.at(-1), undefined);
});

test("未登记 no-UI agent_end 不清理父级动画", () => {
	const workingMessages: Array<string | undefined> = [];
	configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "matrix3", width: "default" });
	const parentCtx = { id: "parent-ui", ui: { setWorkingMessage: (message?: string) => workingMessages.push(message), setWorkingIndicator() {} } };
	const noUiEndCtx = { id: "nested-no-ui-agent", hasUI: false };

	bindAnimationsSession(parentCtx);
	resumeAnimationsRuntime();
	const state = getAnimationsRuntimeState();
	const generationBefore = state.agentGeneration;
	const frameBefore = state.frame;
	const writesBeforeEnd = workingMessages.length;

	handleAnimationsAgentEnd({}, noUiEndCtx);

	assert.equal(state.animating, true);
	assert.equal(state.agentGeneration, generationBefore);
	assert.equal(state.frame, frameBefore);
	assert.equal(state.currentUiCtx, parentCtx);
	assert.equal(state.currentCtx, parentCtx);
	assert.equal(workingMessages.length, writesBeforeEnd);
	assert.notEqual(state.timer, undefined);

	handleAnimationsAgentEnd({}, parentCtx);
	assert.equal(state.animating, false);
	assert.equal(workingMessages.at(-1), undefined);
});

test("同 id 不同对象的 no-UI agent_start 到 agent_end 不清理父级动画", () => {
	const workingMessages: Array<string | undefined> = [];
	configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "matrix3", width: "default" });
	const parentCtx = { id: "parent-ui", ui: { setWorkingMessage: (message?: string) => workingMessages.push(message), setWorkingIndicator() {} } };
	const noUiStartCtx = { id: "nested-no-ui-agent", hasUI: false };
	const noUiEndCtx = { id: "nested-no-ui-agent", hasUI: false };

	bindAnimationsSession(parentCtx);
	resumeAnimationsRuntime();
	const state = getAnimationsRuntimeState();
	handleAnimationsAgentStart({}, noUiStartCtx);
	const generationBeforeEnd = state.agentGeneration;
	const writesBeforeEnd = workingMessages.length;

	handleAnimationsAgentEnd({}, noUiEndCtx);

	assert.equal(state.animating, true);
	assert.equal(state.agentGeneration, generationBeforeEnd);
	assert.equal(state.currentUiCtx, parentCtx);
	assert.equal(state.currentCtx, parentCtx);
	assert.equal(workingMessages.length, writesBeforeEnd);
	assert.notEqual(state.timer, undefined);

	handleAnimationsAgentEnd({}, parentCtx);
	assert.equal(state.animating, false);
	assert.equal(workingMessages.at(-1), undefined);
});

test("缺少 setWorkingMessage 的 ctx 不覆盖 current UI target", () => {
	const workingMessages: Array<string | undefined> = [];
	configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "crush", width: "default" });
	const parentCtx = { id: "parent-ui", ui: { setWorkingMessage: (message?: string) => workingMessages.push(message) } };
	const eventOnlyCtx = { id: "event-only", ui: { requestRender() {} } };

	bindAnimationsSession(parentCtx);
	handleAnimationsAgentStart({}, parentCtx);
	const state = getAnimationsRuntimeState();
	bindAnimationsSession(eventOnlyCtx);

	assert.equal(state.currentUiCtx, parentCtx);
	assert.equal(state.currentCtx, parentCtx);
	assert.notEqual(workingMessages.at(-1), undefined);
	handleAnimationsAgentEnd({}, { id: "stale-parent", isCurrent: false });
	assert.equal(workingMessages.at(-1), undefined);
});

test("tool 仍在运行时不应由 turn_end 停止动画，agent_end 才清理", () => {
	const workingMessages: Array<string | undefined> = [];
	const indicators: Array<unknown> = [];
	configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "matrix3", tool: "matrix3", width: "default" });
	const state = getAnimationsRuntimeState();
	state.currentCtx = {
		ui: {
			setWorkingIndicator: (indicator?: unknown) => indicators.push(indicator),
			setWorkingMessage: (message?: string) => workingMessages.push(message),
		},
	};
	state.currentUiCtx = state.currentCtx;

	resumeAnimationsRuntime();
	handleAnimationsToolExecutionStart({ toolCallId: "tool-1" });
	assert.equal(state.animating, true);
	assert.equal(workingMessages.at(-1)?.includes("\n"), true);

	const writesBeforeTurnEnd = workingMessages.length;
	// turn_end 事件由入口层记录和清理 bottom live usage；runtime 不应被 pause。
	assert.equal(state.animating, true);
	assert.equal(state.timer !== undefined, true);
	assert.equal(workingMessages.length, writesBeforeTurnEnd);

	pauseAnimationsRuntime();
	assert.equal(state.animating, false);
	assert.equal(state.timer, undefined);
	assert.equal(workingMessages.at(-1), undefined);
	assert.equal(indicators.at(-1), undefined);
});

