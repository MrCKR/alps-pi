/** 功能：验证扩展入口接入 fixed bottom editor runtime 生命周期 实现者：alps 实现日期：2026-05-27 */

import assert from "node:assert/strict";
import test from "node:test";
import { registerAlpsPiExtension } from "../index.ts";
import { createInitialPatchState, PATCH_KEY } from "../src/features/chrome-frame/patch.ts";
import type { FixedBottomEditorRuntime } from "../src/features/fixed-bottom-editor/runtime.ts";

function createHarness(options: { failEnable?: boolean } = {}) {
	const handlers = new Map<string, Function[]>();
	const commands = new Map<string, any>();
	const runtimeCalls: string[] = [];
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
	const pi = {
		registerCommand(name: string, options: any) {
			commands.set(name, options);
		},
		on(event: string, handler: Function) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};

	registerAlpsPiExtension(pi as any, { fixedBottomEditorRuntime: runtime });

	return {
		commands,
		disposePatchEnabledSnapshots,
		handlers,
		runtimeCalls,
		emit(event: string, ctx: any = { id: "ctx" }) {
			for (const handler of handlers.get(event) ?? []) {
				handler({}, ctx);
			}
		},
	};
}

test.beforeEach(() => {
	(globalThis as any)[PATCH_KEY] = createInitialPatchState();
});

test("extension load 后注册 session_start 和 session_shutdown", () => {
	const harness = createHarness();
	assert.ok(harness.commands.has("alps-pi"));
	assert.equal(harness.handlers.get("session_start")?.length, 1);
	assert.equal(harness.handlers.get("session_shutdown")?.length, 1);
});

test("session_start 调用 runtime.bindSession，默认 fixedBottomEditor false 时不安装", () => {
	const harness = createHarness();
	harness.emit("session_start", { id: "one" });

	assert.deepEqual(harness.runtimeCalls, ["bind:one"]);
});

test("若设置为 true，session_start 尝试安装 runtime", () => {
	const harness = createHarness();
	(globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled = true;

	harness.emit("session_start", { id: "two" });

	assert.deepEqual(harness.runtimeCalls, ["bind:two", "set:true"]);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled, true);
});

test("session_shutdown 先 dispose fixed runtime、重置 fixedBottomEditor，再 disablePatch", () => {
	const harness = createHarness();
	(globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled = true;
	assert.equal((globalThis as any)[PATCH_KEY].enabled, true);

	harness.emit("session_shutdown");

	assert.equal(harness.runtimeCalls[0], "dispose");
	assert.deepEqual(harness.disposePatchEnabledSnapshots, [true]);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled, false);
	assert.equal((globalThis as any)[PATCH_KEY].enabled, false);
});

test("shutdown 后下一次 session_start 不会自动重装 fixed editor", () => {
	const harness = createHarness();
	(globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled = true;

	harness.emit("session_shutdown");
	harness.emit("session_start", { id: "next" });

	assert.deepEqual(harness.runtimeCalls, ["dispose", "bind:next"]);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled, false);
});

test("session_start 安装失败时回写 fixedBottomEditor=false", () => {
	const harness = createHarness({ failEnable: true });
	(globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled = true;

	harness.emit("session_start", { id: "fail" });

	assert.deepEqual(harness.runtimeCalls, ["bind:fail", "set:true"]);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled, false);
});

test("命令层 fixed ops 使用入口创建的 runtime", async () => {
	const harness = createHarness();
	await harness.commands.get("alps-pi").handler("status", { ui: { notify() {} } });
	assert.deepEqual(harness.runtimeCalls, []);

	const ctx = {
		hasUI: true,
		ui: {
			custom(factory: any) {
				const component = factory({}, undefined, {}, () => {});
				component.handleInput("\x1b[B");
				component.handleInput("\x1b[B");
				component.handleInput(" ");
				component.handleInput("q");
				return Promise.resolve();
			},
			notify() {},
		},
	};

	await harness.commands.get("alps-pi").handler("", ctx);
	assert.deepEqual(harness.runtimeCalls, ["set:true"]);
});
