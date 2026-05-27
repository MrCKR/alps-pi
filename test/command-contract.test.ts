/** 功能：验证 /alps-pi 命令契约 实现者：alps 实现日期：2026-05-26 */

import assert from "node:assert/strict";
import test from "node:test";
import { createInitialPatchState, PATCH_KEY } from "../src/features/chrome-frame/patch.ts";
import { registerAlpsPiCommand } from "../src/commands.ts";

function createHarness() {
	const commands = new Map<string, any>();
	const notifications: Array<{ message: string; level: string }> = [];
	const customCalls: any[] = [];
	const customErrors: Error[] = [];
	let customResult: Promise<any> = Promise.resolve(undefined);
	let confirmResult = false;
	const patchCalls: string[] = [];
	const pi = {
		registerCommand(name: string, options: any) {
			commands.set(name, options);
		},
	};
	const ctx = {
		hasUI: true,
		ui: {
			theme: undefined as any,
			async confirm(title: string, message: string) {
				notifications.push({ message: `${title}\n${message}`, level: "confirm" });
				return confirmResult;
			},
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			async custom(factory: any, options?: any) {
				if (typeof factory !== "function") {
					throw new Error("factory is not a function");
				}
				let done!: (value?: any) => void;
				customResult = new Promise((resolve) => {
					done = resolve;
				});
				try {
					const component = await factory({}, ctx.ui.theme, {}, done);
					customCalls.push({ factory, options, component, done });
					return await customResult;
				} catch (error) {
					customErrors.push(error as Error);
					throw error;
				}
			},
		},
	};
	registerAlpsPiCommand(pi as any, {
		enable: () => {
			patchCalls.push("enable");
			const state = (globalThis as any)[PATCH_KEY];
			state.enabled = true;
			state.config.settings.chromeFrame.enabled = true;
			state.patched.add("UserMessageComponent");
			return state;
		},
		disable: () => {
			patchCalls.push("disable");
			const state = (globalThis as any)[PATCH_KEY];
			state.enabled = false;
			state.config.settings.chromeFrame.enabled = false;
			state.patched.clear();
			return state;
		},
		status: () => (globalThis as any)[PATCH_KEY],
	});
	return {
		commands,
		ctx,
		notifications,
		customCalls,
		customErrors,
		patchCalls,
		setConfirmResult(value: boolean) {
			confirmResult = value;
		},
	};
}

test.beforeEach(() => {
	(globalThis as any)[PATCH_KEY] = createInitialPatchState();
});

test("注册 /alps-pi 命令且描述为中文", () => {
	const harness = createHarness();
	assert.ok(harness.commands.has("alps-pi"));
	assert.match(harness.commands.get("alps-pi").description, /打开 Alps Pi 美化设置/);
});

test("status 在 disabled 时显示 disabled", async () => {
	const harness = createHarness();
	await harness.commands.get("alps-pi").handler("status", harness.ctx);
	assert.ok(harness.notifications.some((n) => /disabled/.test(n.message)));
});

test("status 在 enabled 时显示 patched components", async () => {
	const harness = createHarness();
	(globalThis as any)[PATCH_KEY].enabled = true;
	(globalThis as any)[PATCH_KEY].patched.add("AssistantMessageComponent");
	await harness.commands.get("alps-pi").handler("status", harness.ctx);
	assert.ok(harness.notifications.some((n) => /enabled/.test(n.message) && /AssistantMessageComponent/.test(n.message)));
});

test("无参数打开设置界面，可切换线框美化与正文线框", async () => {
	const harness = createHarness();
	const pending = harness.commands.get("alps-pi").handler("", harness.ctx);
	await Promise.resolve();
	assert.equal(harness.customCalls.length, 1);
	assert.equal(harness.customCalls[0].options.overlay, true);
	const component = harness.customCalls[0].component;
	assert.match(component.render(80).join("\n"), /线框美化/);
	component.handleInput(" ");
	assert.deepEqual(harness.patchCalls, ["enable"]);
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.chromeFrame.assistantFrame, false);
	component.handleInput("q");
	await pending;
});

test("preview 按真实 ctx.ui.custom factory API 调用并可关闭，且不调用 patch", async () => {
	const harness = createHarness();
	const pending = harness.commands.get("alps-pi").handler("preview", harness.ctx);
	await Promise.resolve();
	assert.equal(harness.customCalls.length, 1);
	assert.equal(typeof harness.customCalls[0].factory, "function");
	assert.equal(harness.customCalls[0].options.overlay, true);
	assert.equal(typeof harness.customCalls[0].component.render, "function");
	harness.customCalls[0].component.handleInput("q");
	await pending;
	assert.equal(harness.customErrors.length, 0);
	assert.deepEqual(harness.patchCalls, []);
});


test("preview custom rejection 被 await/catch 并通知错误", async () => {
	const harness = createHarness();
	harness.ctx.ui.custom = async () => {
		throw new Error("custom failed");
	};
	await harness.commands.get("alps-pi").handler("preview", harness.ctx);
	assert.ok(harness.notifications.some((n) => n.level === "error" && /Preview failed: custom failed/.test(n.message)));
});

test("enable/disable/config 已移除并返回帮助", async () => {
	for (const action of ["enable", "disable", "config"]) {
		const harness = createHarness();
		await harness.commands.get("alps-pi").handler(action, harness.ctx);
		assert.deepEqual(harness.patchCalls, []);
		assert.ok(harness.notifications.some((n) => /用法/.test(n.message) && /preview\/status/.test(n.message)), action);
	}
});

test("未知参数输出中文帮助信息", async () => {
	const harness = createHarness();
	await harness.commands.get("alps-pi").handler("wat", harness.ctx);
	assert.ok(harness.notifications.some((n) => /用法/.test(n.message) && /打开美化设置/.test(n.message)));
});
