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
	const overlayHandles: any[] = [];
	const currentEditor = { handleInput() {}, getText: () => "", setText() {} };
	const previousEditor = { handleInput() {}, getText: () => "", setText() {} };
	let focusedComponent: any = previousEditor;
	let customResult: Promise<any> = Promise.resolve(undefined);
	const patchCalls: string[] = [];
	const beautifiedInputCalls: boolean[] = [];
	const settingsChangedCalls: any[] = [];
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
						editorContainer: { children: [currentEditor] },
						children: [{ children: [currentEditor] }],
						requestRenderCalls: [] as boolean[],
						get focusedComponent() {
							return focusedComponent;
						},
						setFocus(component: any) {
							focusedComponent = component;
						},
						requestRender(force?: boolean) {
							this.requestRenderCalls.push(Boolean(force));
						},
						hasOverlay() {
							return this.overlayStack.some((entry: any) => entry?.hidden !== true);
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
						fakeTui.overlayStack.push({ component, preFocus: previousEditor });
						options?.onHandle?.(handle);
						overlayHandles.push(handle);
					}
					customCalls.push({ factory, options, component, done, fakeTui });
					const result = await customResult;
					if (options?.overlay) {
						fakeTui.overlayStack.pop();
						fakeTui.setFocus(previousEditor);
						fakeTui.requestRender();
					}
					return result;
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
		setBeautifiedInputEnabled: (enabled: boolean) => {
			beautifiedInputCalls.push(enabled);
			(globalThis as any)[PATCH_KEY].config.settings.beautifiedInput.enabled = enabled;
		},
		onSettingsChanged: (settings: any) => {
			settingsChangedCalls.push({
				chromeFrame: { ...settings.chromeFrame },
				beautifiedInput: { ...settings.beautifiedInput },
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
		beautifiedInputCalls,
		settingsChangedCalls,
		currentEditor,
		previousEditor,
		getFocusedComponent: () => focusedComponent,
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

test("无参数打开 overlay 设置界面，可切换 Master Switch 与 Assistant Frame", async () => {
	const harness = createHarness();
	const pending = harness.commands.get("alps-pi").handler("", harness.ctx);
	await Promise.resolve();
	assert.equal(harness.customCalls.length, 1);
	assert.equal(harness.customCalls[0].options.overlay, true);
	assert.equal(harness.customCalls[0].options.overlayOptions.anchor, "center");
	const component = harness.customCalls[0].component;
	assert.match(component.render(80).join("\n"), /Master Switch/);
	component.handleInput(" ");
	assert.deepEqual(harness.patchCalls, ["disable"]);
	assert.equal(harness.settingsChangedCalls[0]?.chromeFrame.enabled, false);
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.chromeFrame.assistantFrame, false);
	assert.equal(harness.settingsChangedCalls.length, 2);
	component.handleInput("q");
	await pending;
});

test("设置界面切换美化输入框调用 beautified input op", async () => {
	const harness = createHarness();
	const pending = harness.commands.get("alps-pi").handler("", harness.ctx);
	await Promise.resolve();
	const component = harness.customCalls[0].component;
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.deepEqual(harness.beautifiedInputCalls, [false]);
	assert.equal((globalThis as any)[PATCH_KEY].config.settings.beautifiedInput.enabled, false);
	component.handleInput("q");
	await pending;
});

test("设置界面使用 overlay custom 并在切换后恢复 overlay 焦点", async () => {
	const harness = createHarness();
	const pending = harness.commands.get("alps-pi").handler("", harness.ctx);
	await Promise.resolve();
	const component = harness.customCalls[0].component;
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput(" ");

	assert.equal(harness.customCalls[0].options.overlay, true);
	assert.equal(harness.overlayHandles.length, 1);
	await Promise.resolve();
	assert.equal(harness.overlayHandles[0].focusCalls, 1);
	component.handleInput("q");
	await pending;
});

test("设置页关闭后显式恢复当前 editor 焦点，避免回到已替换实例", async () => {
	const harness = createHarness();
	const pending = harness.commands.get("alps-pi").handler("", harness.ctx);
	await Promise.resolve();
	const component = harness.customCalls[0].component;

	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	component.handleInput("q");
	await pending;

	assert.equal(harness.getFocusedComponent(), harness.currentEditor);
	assert.deepEqual(harness.customCalls[0].fakeTui.requestRenderCalls.at(-2), false);
	assert.deepEqual(harness.customCalls[0].fakeTui.requestRenderCalls.at(-1), true);
});

test("设置页内 Animations Preview 使用 overlay tui.requestRender 驱动动态刷新", async () => {
	const harness = createHarness();
	const pending = harness.commands.get("alps-pi").handler("", harness.ctx);
	await Promise.resolve();
	const component = harness.customCalls[0].component;
	for (let i = 0; i < 7; i++) component.handleInput("\x1b[B");
	component.handleInput(" ");
	for (let i = 0; i < 7; i++) component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.match(component.render(90).join("\n"), /Animation Preview/);
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.ok(harness.customCalls[0].fakeTui.requestRenderCalls.length > 0);
	component.handleInput("q");
	component.handleInput("q");
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
		assert.deepEqual(harness.beautifiedInputCalls, []);
		assert.ok(harness.notifications.some((n) => /用法/.test(n.message) && /可选参数 preview/.test(n.message)), action);
	}
});

test("未知参数输出中文帮助信息", async () => {
	const harness = createHarness();
	await harness.commands.get("alps-pi").handler("wat", harness.ctx);
	assert.ok(harness.notifications.some((n) => /用法/.test(n.message) && /打开美化设置/.test(n.message)));
});
