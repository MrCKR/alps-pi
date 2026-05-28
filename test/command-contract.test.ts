/** 功能：验证 /alps-pi 命令契约 实现者：alps 实现日期：2026-05-26 */

import assert from "node:assert/strict";
import test from "node:test";
import { createInitialPatchState, PATCH_KEY } from "../src/features/chrome-frame/patch.ts";
import { registerAlpsPiCommand } from "../src/commands.ts";

function createHarness(options: { fixedFailure?: string } = {}) {
	const commands = new Map<string, any>();
	const notifications: Array<{ message: string; level: string }> = [];
	const customCalls: any[] = [];
	const customErrors: Error[] = [];
	const overlayHandles: any[] = [];
	let focusedComponent: any;
	let customResult: Promise<any> = Promise.resolve(undefined);
	const patchCalls: string[] = [];
	const fixedCalls: boolean[] = [];
	const bottomStatusCalls: boolean[] = [];
	const settingsChangedCalls: any[] = [];
	let fixedInstalled = false;
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
				return false;
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
					const fakeTui: any = {
						overlayStack: [],
						get focusedComponent() {
							return focusedComponent;
						},
					};
					const component = await factory(fakeTui, ctx.ui.theme, {}, done);
					focusedComponent = component;
					const handle = {
						focusCalls: 0,
						focus() {
							this.focusCalls += 1;
							focusedComponent = component;
						},
					};
					if (options?.overlay) {
						fakeTui.overlayStack.push({ component, preFocus: undefined });
						options?.onHandle?.(handle);
						overlayHandles.push(handle);
					}
					customCalls.push({ factory, options, component, done, fakeTui });
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
		setFixedBottomEditorEnabled: (enabled: boolean) => {
			fixedCalls.push(enabled);
			const state = (globalThis as any)[PATCH_KEY];
			if (options.fixedFailure && enabled) {
				fixedInstalled = false;
				state.config.settings.fixedBottomEditor.enabled = false;
				return { enabled: false, installed: false, failure: options.fixedFailure };
			}
			fixedInstalled = enabled;
			state.config.settings.fixedBottomEditor.enabled = enabled;
			return { enabled, installed: fixedInstalled };
		},
		setBottomStatusEnabled: (enabled: boolean) => {
			bottomStatusCalls.push(enabled);
			(globalThis as any)[PATCH_KEY].config.settings.bottomStatus.enabled = enabled;
		},
		onSettingsChanged: (settings: any) => {
			settingsChangedCalls.push({
				chromeFrame: { ...settings.chromeFrame },
				fixedBottomEditor: { ...settings.fixedBottomEditor },
				bottomStatus: { ...settings.bottomStatus },
			});
		},
	});
	return {
		commands,
		ctx,
		notifications,
		customCalls,
		customErrors,
		overlayHandles,
		patchCalls,
		fixedCalls,
		bottomStatusCalls,
		settingsChangedCalls,
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

test("无参数打开设置界面，可切换线框美化与正文线框", async () => {
	const harness = createHarness();
	const pending = harness.commands.get("alps-pi").handler("", harness.ctx);
	await Promise.resolve();
	assert.equal(harness.customCalls.length, 1);
	assert.equal(harness.customCalls[0].options, undefined);
	const component = harness.customCalls[0].component;
	assert.match(component.render(80).join("\n"), /线框美化/);
	component.handleInput(" ");
	assert.deepEqual(harness.patchCalls, ["enable"]);
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.chromeFrame.assistantFrame, false);
	assert.equal(harness.settingsChangedCalls.length, 2);
	component.handleInput("q");
	await pending;
});

test("设置界面切换固定输入框调用 fixed op 且不调用 message patch", async () => {
	const harness = createHarness();
	const pending = harness.commands.get("alps-pi").handler("", harness.ctx);
	await Promise.resolve();
	const component = harness.customCalls[0].component;
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.deepEqual(harness.fixedCalls, [false]);
	assert.deepEqual(harness.patchCalls, []);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled, false);
	component.handleInput("q");
	await pending;
});

test("设置界面切换底部状态栏调用 bottom status op", async () => {
	const harness = createHarness();
	const pending = harness.commands.get("alps-pi").handler("", harness.ctx);
	await Promise.resolve();
	const component = harness.customCalls[0].component;
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.deepEqual(harness.bottomStatusCalls, [true]);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.bottomStatus.enabled, true);
	component.handleInput("q");
	await pending;
});

test("设置界面使用 non-overlay custom，不再注册 overlay handle 或焦点恢复 hack", async () => {
	const harness = createHarness();
	const pending = harness.commands.get("alps-pi").handler("", harness.ctx);
	await Promise.resolve();
	const component = harness.customCalls[0].component;
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput(" ");

	assert.equal(harness.customCalls[0].options, undefined);
	assert.deepEqual(harness.overlayHandles, []);
	component.handleInput("q");
	await pending;
});

test("设置界面 fixed op 返回 failure 时回滚为 OFF", async () => {
	const harness = createHarness({ fixedFailure: "boom" });
	(globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled = false;
	const pending = harness.commands.get("alps-pi").handler("", harness.ctx);
	await Promise.resolve();
	const component = harness.customCalls[0].component;
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput(" ");

	assert.deepEqual(harness.fixedCalls, [true]);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.fixedBottomEditor.enabled, false);
	assert.match(component.render(80).join("\n"), /固定输入框\s+OFF/);
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

test("enable/disable/config/config-ui/settings/status 已移除并返回帮助", async () => {
	for (const action of ["enable", "disable", "config", "config-ui", "settings", "status"]) {
		const harness = createHarness();
		await harness.commands.get("alps-pi").handler(action, harness.ctx);
		assert.deepEqual(harness.patchCalls, []);
		assert.deepEqual(harness.fixedCalls, []);
		assert.deepEqual(harness.bottomStatusCalls, []);
		assert.ok(harness.notifications.some((n) => /用法/.test(n.message) && /可选参数 preview/.test(n.message)), action);
	}
});

test("未知参数输出中文帮助信息", async () => {
	const harness = createHarness();
	await harness.commands.get("alps-pi").handler("wat", harness.ctx);
	assert.ok(harness.notifications.some((n) => /用法/.test(n.message) && /打开美化设置/.test(n.message)));
});
