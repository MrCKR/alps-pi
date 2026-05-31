/** 功能：验证扩展入口接入统一 bottom-input runtime 生命周期 实现者：alps 实现日期：2026-05-28 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerAlpsPiExtension } from "../index.ts";
import { createInitialPatchState, PATCH_KEY } from "../src/features/chrome-frame/patch.ts";
import { configureAnimations, disposeAnimations, getAnimationsPatchState, getAnimationsRuntimeState } from "../src/features/animations/index.ts";
import type { BottomInputRuntime } from "../src/features/bottom-input/index.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";

function createHarness(options: { failEnable?: boolean; configureFailure?: boolean } = {}) {
	const handlers = new Map<string, Function[]>();
	const commands = new Map<string, any>();
	const runtimeCalls: string[] = [];
	const disposePatchEnabledSnapshots: boolean[] = [];
	let enabled = false;
	const runtime: BottomInputRuntime = {
		bindSession(ctx: any) {
			runtimeCalls.push(`bind:${ctx.id}`);
		},
		setEnabled(nextEnabled: boolean) {
			runtimeCalls.push(`set:${nextEnabled}`);
			if (options.failEnable && nextEnabled) {
				enabled = false;
				return { enabled: false, installed: false, failure: "boom" };
			}
			enabled = nextEnabled;
			return { enabled, installed: enabled };
		},
		dispose() {
			// 记录 dispose 当下的 patch 状态，强约束 shutdown 必须先释放 runtime 再 disablePatch。
			disposePatchEnabledSnapshots.push(Boolean((globalThis as any)[PATCH_KEY]?.enabled));
			runtimeCalls.push("dispose");
			enabled = false;
		},
		getStatus() {
			return { enabled, installed: enabled };
		},
		configure(settings: { fixedEnabled?: boolean; beautifiedInputEnabled?: boolean }) {
			if (typeof settings.beautifiedInputEnabled === "boolean") runtimeCalls.push(`beautified:${settings.beautifiedInputEnabled}`);
			if (typeof settings.fixedEnabled === "boolean") runtimeCalls.push(`set:${settings.fixedEnabled}`);
			if (options.configureFailure && settings.fixedEnabled) {
				enabled = false;
				return { enabled: false, installed: false, failure: "boom" };
			}
			if (typeof settings.fixedEnabled === "boolean") enabled = settings.fixedEnabled;
			return { enabled, installed: enabled };
		},
		setBeautifiedInputEnabled(nextEnabled: boolean) {
			runtimeCalls.push(`beautified:${nextEnabled}`);
		},
		resetSessionStartTime() {
			runtimeCalls.push("resetTime");
		},
		setLastPrompt(prompt: unknown) {
			runtimeCalls.push(`prompt:${String(prompt)}`);
		},
		setThinkingLevel(level: unknown) {
			runtimeCalls.push(`thinking:${String(level)}`);
		},
		setStreaming(streaming: boolean) {
			runtimeCalls.push(`streaming:${streaming}`);
		},
		setLiveUsage() {
			runtimeCalls.push("liveUsage");
		},
		clearLiveUsage() {
			runtimeCalls.push("clearLiveUsage");
		},
		requestRender() {
			runtimeCalls.push("render");
		},
		stashOrRestoreEditorText() {
			runtimeCalls.push("stash");
		},
		setShortcuts() {
			runtimeCalls.push("shortcuts");
		},
	};
	const pi = {
		registerCommand(name: string, options: any) {
			commands.set(name, options);
		},
		registerShortcut(name: string, options: any) {
			commands.set(`shortcut:${name}`, options);
		},
		on(event: string, handler: Function) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};

	registerAlpsPiExtension(pi as any, { bottomInputRuntime: runtime });

	return {
		commands,
		disposePatchEnabledSnapshots,
		handlers,
		runtimeCalls,
		emit(event: string, ctx: any = { id: "ctx" }, payload: any = {}) {
			for (const handler of handlers.get(event) ?? []) {
				handler(payload, ctx);
			}
		},
	};
}

const settingsDirs: string[] = [];

function readPersistedFixedEnabled(): boolean | null {
	const file = process.env.ALPS_PI_SETTINGS_PATH!;
	try {
		const raw = JSON.parse(readFileSync(file, "utf-8"));
		return raw?.fixedBottomEditor?.enabled ?? raw?.["alps-pi"]?.fixedBottomEditor?.enabled ?? null;
	} catch {
		return null;
	}
}

test.beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "alps-pi-entry-"));
	settingsDirs.push(dir);
	process.env.ALPS_PI_SETTINGS_PATH = join(dir, "settings.json");
	(globalThis as any)[PATCH_KEY] = createInitialPatchState();
});

test.afterEach(() => {
	disposeAnimations();
	delete process.env.ALPS_PI_SETTINGS_PATH;
	for (const dir of settingsDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("extension load 后注册 session_start、动画事件和 session_shutdown", () => {
	const harness = createHarness();
	assert.ok(harness.commands.has("alps-pi"));
	assert.equal(harness.handlers.get("session_start")?.length, 1);
	assert.equal(harness.handlers.get("message_update")?.length, 1);
	assert.equal(harness.handlers.get("tool_execution_start")?.length, 1);
	assert.equal(harness.handlers.get("tool_execution_update")?.length, 1);
	assert.equal(harness.handlers.get("tool_execution_end")?.length, 1);
	assert.equal(harness.handlers.get("agent_end")?.length, 1);
	assert.equal(harness.handlers.get("session_shutdown")?.length, 1);
	assert.ok(harness.commands.has("shortcut:alt+s"));
});

test("session_start 配置 animations 并调用统一 runtime", () => {
	const harness = createHarness();
	harness.emit("session_start", { id: "one" });

	assert.deepEqual(harness.runtimeCalls, ["shortcuts", "beautified:true", "bind:one", "resetTime", "prompt:", "shortcuts", "beautified:true", "set:true"]);
	assert.equal(getAnimationsRuntimeState().currentEventCtx.id, "one");
	assert.equal(getAnimationsPatchState().enabled, true);
});

test("若设置为 true，session_start 尝试安装 runtime", () => {
	const harness = createHarness();
	(globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled = true;

	harness.emit("session_start", { id: "two" });

	assert.ok(harness.runtimeCalls.includes("set:true"));
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled, true);
});

test("session_shutdown 先 dispose runtime、保留 fixedBottomEditor/beautifiedInput 设置，再 disablePatch", () => {
	const harness = createHarness();
	(globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled = true;
	(globalThis as any)[PATCH_KEY].config.settings.beautifiedInput.enabled = false;
	assert.equal((globalThis as any)[PATCH_KEY].enabled, true);

	harness.emit("session_shutdown");

	assert.equal(harness.runtimeCalls.includes("dispose"), true);
	assert.deepEqual(harness.disposePatchEnabledSnapshots, [true]);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled, true);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.beautifiedInput.enabled, false);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.animations.enabled, true);
	assert.equal("bottomStatus" in (globalThis as any)[PATCH_KEY].config.settings, false);
	assert.equal(getAnimationsPatchState().enabled, false);
	assert.equal((globalThis as any)[PATCH_KEY].enabled, false);
});

test("shutdown 后下一次 session_start 会按持久化设置恢复 fixed editor 和 beautified input", () => {
	const harness = createHarness();
	(globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled = true;
	(globalThis as any)[PATCH_KEY].config.settings.beautifiedInput.enabled = false;

	harness.emit("session_shutdown");
	harness.emit("session_start", { id: "next" });

	assert.deepEqual(harness.runtimeCalls.slice(-6), ["bind:next", "resetTime", "prompt:", "shortcuts", "beautified:false", "set:true"]);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled, true);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.beautifiedInput.enabled, false);
});

test("session_start 会按设置切换 beautified input", () => {
	const harness = createHarness();
	(globalThis as any)[PATCH_KEY].config.settings.beautifiedInput.enabled = false;

	harness.emit("session_start", { id: "beautified" });

	assert.equal(harness.runtimeCalls.includes("beautified:false"), true);
});

test("session_start 安装失败时保留 fixedBottomEditor 用户偏好 true", () => {
	const harness = createHarness({ configureFailure: true });
	(globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled = true;

	harness.emit("session_start", { id: "fail" });

	assert.equal(harness.runtimeCalls.includes("set:true"), true);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled, true);
	assert.equal(readPersistedFixedEnabled(), null);
});

test("扩展启动时读取持久化设置", () => {
	const file = process.env.ALPS_PI_SETTINGS_PATH!;
	writeFileSync(file, JSON.stringify({
		chromeFrame: { enabled: false, assistantFrame: false, toolCompactMode: false, compactEditTool: true },
		fixedBottomEditor: { enabled: false },
		beautifiedInput: { enabled: false },
		animations: { enabled: false, thinking: "aurora", fps: 8 },
		bottomStatus: { enabled: true },
	}), "utf-8");

	const harness = createHarness();
	harness.emit("session_start", { id: "persisted" });

	const settings = (globalThis as any)[PATCH_KEY].config.settings;
	assert.equal(settings.chromeFrame.enabled, false);
	assert.equal(settings.chromeFrame.assistantFrame, false);
	assert.equal(settings.chromeFrame.toolCompactMode, false);
	assert.equal(settings.chromeFrame.compactEditTool, true);
	assert.equal(settings.fixedBottomEditor.enabled, false);
	assert.equal(settings.beautifiedInput.enabled, false);
	assert.equal(settings.animations.enabled, false);
	assert.equal(settings.animations.thinking, "aurora");
	assert.equal(settings.animations.fps, 8);
	assert.equal("bottomStatus" in settings, false);
	assert.equal(harness.runtimeCalls.includes("bind:persisted"), true);
	assert.equal(harness.runtimeCalls.includes("set:true"), false);
	assert.equal(harness.runtimeCalls.includes("beautified:false"), true);
});

test("tool_execution_update 默认关闭 debug 时只记录诊断且不改变 animations runtime", () => {
	const previousLog = process.env.ALPS_PI_ANIM_DEBUG_LOG;
	delete process.env.ALPS_PI_ANIM_DEBUG_LOG;
	try {
		const harness = createHarness();
		const state = getAnimationsRuntimeState();
		const workingMessages: string[] = [];
		const originalCtx = {
			id: "original-ctx",
			ui: {
				setWorkingMessage: (message: string) => workingMessages.push(message),
			},
		};
		state.currentCtx = originalCtx;
		state.timer = undefined;

		harness.emit("tool_execution_update", { id: "update-ctx", ui: { setWorkingMessage: () => workingMessages.push("updated") } }, { toolCallId: "tool-1" });

		assert.equal(state.currentCtx, originalCtx);
		assert.equal(state.timer, undefined);
		assert.deepEqual(workingMessages, []);
	} finally {
		if (previousLog === undefined) delete process.env.ALPS_PI_ANIM_DEBUG_LOG;
		else process.env.ALPS_PI_ANIM_DEBUG_LOG = previousLog;
	}
});

test("message_update 绑定 animations ctx，turn_end 不停止动画且 agent_end 清理", () => {
	const harness = createHarness();
	const workingMessages: Array<string | undefined> = [];
	const indicators: Array<unknown> = [];
	const animCtx = {
		id: "anim-ctx",
		ui: {
			setWorkingIndicator: (indicator?: unknown) => indicators.push(indicator),
			setWorkingMessage: (message?: string) => workingMessages.push(message),
		},
	};
	configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "matrix3", width: "default" });
	harness.emit("message_update", animCtx, { message: { usage: {} } });

	const state = getAnimationsRuntimeState();
	assert.equal(state.currentCtx.id, "anim-ctx");
	assert.equal(state.animating, false);
	harness.emit("agent_start", animCtx);
	assert.equal(state.animating, true);
	assert.deepEqual(indicators.at(-1), { frames: [] });
	assert.equal(typeof workingMessages.at(-1), "string");
	assert.equal(state.currentCtx.id, "anim-ctx");
	harness.emit("message_update", animCtx, { assistantMessageEvent: { type: "thinking_delta" }, message: { usage: {} } });
	assert.equal(state.thinkingActive, true);
	harness.emit("message_end", animCtx);
	assert.equal(state.animating, true);
	assert.equal(state.thinkingActive, false);
	harness.emit("tool_execution_start", animCtx, { toolCallId: "tool-1" });
	assert.equal(state.toolCallIds.has("tool-1"), true);
	harness.emit("tool_execution_end", animCtx, { toolCallId: "tool-1" });
	assert.equal(state.toolCallIds.size, 0);
	harness.emit("turn_end", animCtx);
	assert.equal(state.currentCtx.id, "anim-ctx");
	assert.equal(state.animating, true);
	assert.notEqual(workingMessages.at(-1), undefined);
	harness.emit("agent_end", { ...animCtx, id: "agent-end" });
	assert.equal(state.currentCtx.id, "agent-end");
	assert.equal(state.animating, false);
	assert.equal(workingMessages.at(-1), undefined);
	assert.equal(indicators.at(-1), undefined);

	harness.emit("agent_start", animCtx);
	assert.equal(state.currentCtx.id, "anim-ctx");
	assert.equal(state.animating, true);
	const staleEndCtx = { id: "stale-agent-end", isCurrent: false, ui: animCtx.ui };
	harness.emit("agent_end", staleEndCtx);
	assert.equal(state.currentCtx.id, "anim-ctx");
	assert.equal(state.animating, false);
	assert.equal(workingMessages.at(-1), undefined);
	assert.equal(indicators.at(-1), undefined);
});

test("模型、thinking 与消息事件会刷新统一 runtime", () => {
	const harness = createHarness();

	harness.emit("model_select", { id: "model" });
	harness.emit("thinking_level_select", { id: "think" }, { level: "high" });
	harness.emit("before_agent_start", { id: "prompt" }, { prompt: "上一个问题" });
	harness.emit("agent_start", { id: "agent" });
	harness.emit("message_update", { id: "update" }, { message: { usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } });
	harness.emit("message_end", { id: "end" });
	harness.emit("turn_end", { id: "turn" });

	assert.deepEqual(harness.runtimeCalls.slice(2), [
		"bind:model",
		"render",
		"bind:think",
		"thinking:high",
		"bind:prompt",
		"prompt:上一个问题",
		"bind:agent",
		"streaming:true",
		"bind:update",
		"liveUsage",
		"bind:end",
		"clearLiveUsage",
		"bind:turn",
		"clearLiveUsage",
	]);
});

test("Alt+S shortcut 调用统一 runtime 暂存逻辑", async () => {
	const harness = createHarness();
	await harness.commands.get("shortcut:alt+s").handler({ id: "shortcut" });
	assert.equal(harness.runtimeCalls.includes("stash"), true);
});

test("命令层 fixed/beautified ops 使用入口创建的统一 runtime 并用命令 ctx 懒绑定 session", async () => {
	const harness = createHarness();
	const ctx = {
		id: "command-ctx",
		hasUI: true,
		ui: {
			custom(factory: any) {
				const component = factory({}, undefined, {}, () => {});
				component.handleInput("\x1b[B");
				component.handleInput("\x1b[B");
				component.handleInput("\x1b[B");
				component.handleInput("\x1b[B");
				component.handleInput(" ");
				component.handleInput("\x1b[B");
				component.handleInput(" ");
				component.handleInput("q");
				return Promise.resolve();
			},
			notify() {},
		},
	};

	await harness.commands.get("alps-pi").handler("", ctx);
	assert.equal(harness.runtimeCalls.includes("bind:command-ctx"), true);
	assert.equal(harness.runtimeCalls.includes("set:false"), true);
	assert.equal(harness.runtimeCalls.includes("beautified:false"), true);
});

test("美化输入框切换 fixed fail-closed 时保留 fixed 用户偏好", async () => {
	const harness = createHarness({ configureFailure: true });
	(globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled = true;
	const ctx = {
		id: "command-ctx",
		hasUI: true,
		ui: {
			custom(factory: any) {
				const component = factory({}, undefined, {}, () => {});
				for (let i = 0; i < 5; i++) component.handleInput("\x1b[B");
				component.handleInput(" ");
				return Promise.resolve();
			},
			notify() {},
		},
	};

	await harness.commands.get("alps-pi").handler("", ctx);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled, true);
	assert.equal(readPersistedFixedEnabled(), true);
});

test("显式打开 Fixed Input 失败时持久化用户偏好 true", async () => {
	const harness = createHarness({ configureFailure: true });
	(globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled = false;
	const ctx = {
		id: "command-ctx",
		hasUI: true,
		ui: {
			custom(factory: any) {
				const component = factory({}, undefined, {}, () => {});
				for (let i = 0; i < 4; i++) component.handleInput("\x1b[B");
				component.handleInput(" ");
				return Promise.resolve();
			},
			notify() {},
		},
	};

	await harness.commands.get("alps-pi").handler("", ctx);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled, true);
	assert.equal(readPersistedFixedEnabled(), true);
});

test("显式关闭 Fixed Input 持久化用户偏好 false", async () => {
	const harness = createHarness();
	(globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled = true;
	const ctx = {
		id: "command-ctx",
		hasUI: true,
		ui: {
			custom(factory: any) {
				const component = factory({}, undefined, {}, () => {});
				for (let i = 0; i < 4; i++) component.handleInput("\x1b[B");
				component.handleInput(" ");
				return Promise.resolve();
			},
			notify() {},
		},
	};

	await harness.commands.get("alps-pi").handler("", ctx);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled, false);
	assert.equal(readPersistedFixedEnabled(), false);
});

test("重启读取 fixed true 后即使上次失败也会重试安装", () => {
	const file = process.env.ALPS_PI_SETTINGS_PATH!;
	writeFileSync(file, JSON.stringify({ fixedBottomEditor: { enabled: true }, beautifiedInput: { enabled: true } }), "utf-8");
	const harness = createHarness({ configureFailure: true });

	harness.emit("session_start", { id: "retry" });

	assert.equal(harness.runtimeCalls.includes("set:true"), true);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled, true);
	assert.equal(readPersistedFixedEnabled(), true);
});

test("美化输入框切换不强行安装 fixed runtime", async () => {
	const harness = createHarness();
	(globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled = false;
	const ctx = {
		id: "command-ctx",
		hasUI: true,
		ui: {
			custom(factory: any) {
				const component = factory({}, undefined, {}, () => {});
				for (let i = 0; i < 5; i++) component.handleInput("\x1b[B");
				component.handleInput(" ");
				return Promise.resolve();
			},
			notify() {},
		},
	};

	await harness.commands.get("alps-pi").handler("", ctx);
	assert.deepEqual(harness.runtimeCalls, ["shortcuts", "beautified:true", "bind:command-ctx", "beautified:false", "set:false"]);
});
