/** 功能：验证扩展入口接入 fixed bottom editor runtime 生命周期 实现者：alps 实现日期：2026-05-27 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerAlpsPiExtension } from "../index.ts";
import { createInitialPatchState, PATCH_KEY } from "../src/features/chrome-frame/patch.ts";
import type { BottomStatusRuntime } from "../src/features/bottom-status/index.ts";
import type { FixedBottomEditorRuntime } from "../src/features/fixed-bottom-editor/runtime.ts";

function createHarness(options: { failEnable?: boolean } = {}) {
	const handlers = new Map<string, Function[]>();
	const commands = new Map<string, any>();
	const runtimeCalls: string[] = [];
	const bottomStatusCalls: string[] = [];
	const disposePatchEnabledSnapshots: boolean[] = [];
	let enabled = false;
	const runtime: FixedBottomEditorRuntime = {
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
	};
	const bottomStatusRuntime: BottomStatusRuntime = {
		bindSession(ctx: any) {
			bottomStatusCalls.push(`bind:${ctx.id}`);
		},
		setEnabled(nextEnabled: boolean) {
			bottomStatusCalls.push(`set:${nextEnabled}`);
		},
		dispose() {
			bottomStatusCalls.push("dispose");
		},
		setThinkingLevel(level: unknown) {
			bottomStatusCalls.push(`thinking:${String(level)}`);
		},
		setLiveUsage() {
			bottomStatusCalls.push("liveUsage");
		},
		clearLiveUsage() {
			bottomStatusCalls.push("clearLiveUsage");
		},
		requestRender() {
			bottomStatusCalls.push("render");
		},
		stashOrRestoreEditorText() {
			bottomStatusCalls.push("stash");
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

	registerAlpsPiExtension(pi as any, { fixedBottomEditorRuntime: runtime, bottomStatusRuntime });

	return {
		commands,
		disposePatchEnabledSnapshots,
		handlers,
		runtimeCalls,
		bottomStatusCalls,
		emit(event: string, ctx: any = { id: "ctx" }, payload: any = {}) {
			for (const handler of handlers.get(event) ?? []) {
				handler(payload, ctx);
			}
		},
	};
}

const settingsDirs: string[] = [];

test.beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "alps-pi-entry-"));
	settingsDirs.push(dir);
	process.env.ALPS_PI_SETTINGS_PATH = join(dir, "settings.json");
	(globalThis as any)[PATCH_KEY] = createInitialPatchState();
});

test.afterEach(() => {
	delete process.env.ALPS_PI_SETTINGS_PATH;
	for (const dir of settingsDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("extension load 后注册 session_start 和 session_shutdown", () => {
	const harness = createHarness();
	assert.ok(harness.commands.has("alps-pi"));
	assert.equal(harness.handlers.get("session_start")?.length, 1);
	assert.equal(harness.handlers.get("session_shutdown")?.length, 1);
	assert.ok(harness.commands.has("shortcut:alt+s"));
});

test("session_start 调用 runtime.bindSession，并按默认设置安装 fixed editor", () => {
	const harness = createHarness();
	harness.emit("session_start", { id: "one" });

	assert.deepEqual(harness.runtimeCalls, ["bind:one", "set:true"]);
	assert.deepEqual(harness.bottomStatusCalls, ["bind:one", "set:false"]);
});

test("若设置为 true，session_start 尝试安装 runtime", () => {
	const harness = createHarness();
	(globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled = true;

	harness.emit("session_start", { id: "two" });

	assert.deepEqual(harness.runtimeCalls, ["bind:two", "set:true"]);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled, true);
});

test("session_shutdown 先 dispose runtimes、保留 fixedBottomEditor/bottomStatus 设置，再 disablePatch", () => {
	const harness = createHarness();
	(globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled = true;
	(globalThis as any)[PATCH_KEY].config.settings.bottomStatus.enabled = true;
	assert.equal((globalThis as any)[PATCH_KEY].enabled, true);

	harness.emit("session_shutdown");

	assert.equal(harness.runtimeCalls[0], "dispose");
	assert.deepEqual(harness.bottomStatusCalls, ["dispose"]);
	assert.deepEqual(harness.disposePatchEnabledSnapshots, [true]);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled, true);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.bottomStatus.enabled, true);
	assert.equal((globalThis as any)[PATCH_KEY].enabled, false);
});

test("shutdown 后下一次 session_start 会按持久化设置恢复 fixed editor 和 bottom status", () => {
	const harness = createHarness();
	(globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled = true;
	(globalThis as any)[PATCH_KEY].config.settings.bottomStatus.enabled = true;

	harness.emit("session_shutdown");
	harness.emit("session_start", { id: "next" });

	assert.deepEqual(harness.runtimeCalls, ["dispose", "bind:next", "set:true"]);
	assert.deepEqual(harness.bottomStatusCalls, ["dispose", "bind:next", "set:true"]);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled, true);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.bottomStatus.enabled, true);
});

test("session_start 会按设置安装 bottom status", () => {
	const harness = createHarness();
	(globalThis as any)[PATCH_KEY].config.settings.bottomStatus.enabled = true;

	harness.emit("session_start", { id: "bottom" });

	assert.deepEqual(harness.bottomStatusCalls, ["bind:bottom", "set:true"]);
});

test("session_start 安装失败时回写 fixedBottomEditor=false", () => {
	const harness = createHarness({ failEnable: true });
	(globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled = true;

	harness.emit("session_start", { id: "fail" });

	assert.deepEqual(harness.runtimeCalls, ["bind:fail", "set:true"]);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled, false);
});

test("扩展启动时读取持久化设置", () => {
	const file = process.env.ALPS_PI_SETTINGS_PATH!;
	writeFileSync(file, JSON.stringify({
		chromeFrame: { enabled: false, assistantFrame: false },
		fixedBottomEditor: { enabled: false },
		bottomStatus: { enabled: true },
	}), "utf-8");

	const harness = createHarness();
	harness.emit("session_start", { id: "persisted" });

	const settings = (globalThis as any)[PATCH_KEY].config.settings;
	assert.equal(settings.chromeFrame.enabled, false);
	assert.equal(settings.chromeFrame.assistantFrame, false);
	assert.equal(settings.fixedBottomEditor.enabled, false);
	assert.equal(settings.bottomStatus.enabled, true);
	assert.deepEqual(harness.runtimeCalls, ["bind:persisted"]);
	assert.deepEqual(harness.bottomStatusCalls, ["bind:persisted", "set:true"]);
});

test("模型、thinking 与消息事件会刷新 bottom status runtime", () => {
	const harness = createHarness();

	harness.emit("model_select", { id: "model" });
	harness.emit("thinking_level_select", { id: "think" }, { level: "high" });
	harness.emit("message_update", { id: "update" }, { message: { usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } });
	harness.emit("message_end", { id: "end" });
	harness.emit("turn_end", { id: "turn" });

	assert.deepEqual(harness.bottomStatusCalls, [
		"bind:model",
		"render",
		"bind:think",
		"thinking:high",
		"bind:update",
		"liveUsage",
		"bind:end",
		"clearLiveUsage",
		"bind:turn",
		"clearLiveUsage",
	]);
});

test("Alt+S shortcut 调用 bottom status 暂存逻辑", async () => {
	const harness = createHarness();
	await harness.commands.get("shortcut:alt+s").handler({ id: "shortcut" });
	assert.deepEqual(harness.bottomStatusCalls, ["stash"]);
});

test("命令层 fixed/bottom ops 使用入口创建的 runtime 并用命令 ctx 懒绑定 session", async () => {
	const harness = createHarness();
	await harness.commands.get("alps-pi").handler("status", { ui: { notify() {} } });
	assert.deepEqual(harness.runtimeCalls, []);

	const ctx = {
		id: "command-ctx",
		hasUI: true,
		ui: {
			custom(factory: any) {
				const component = factory({}, undefined, {}, () => {});
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
	assert.deepEqual(harness.runtimeCalls, ["bind:command-ctx", "set:false"]);
	assert.deepEqual(harness.bottomStatusCalls, ["bind:command-ctx", "set:true"]);
});
