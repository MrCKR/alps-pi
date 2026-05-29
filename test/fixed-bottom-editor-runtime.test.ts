/** 功能：验证 fixed bottom editor runtime 生命周期 实现者：alps 实现日期：2026-05-27 */

import assert from "node:assert/strict";
import test from "node:test";
import { createFixedBottomEditorRuntime } from "../src/features/fixed-bottom-editor/runtime.ts";
import type { FixedEditorTerminal } from "../src/features/fixed-bottom-editor/compositor.ts";
import { stripAnsi } from "./helpers.test.ts";

function createTui(options: { terminal?: any } = {}) {
	const writes: string[] = [];
	const terminal: FixedEditorTerminal = options.terminal ?? {
		columns: 40,
		rows: 12,
		write(data: string) {
			writes.push(data);
		},
	};
	const tui: any = {
		terminal,
		children: [],
		render(width: number) {
			return this.children.flatMap((child: any) => child.render(width));
		},
		doRender() {},
		setFocus() {},
		requestRenderCalls: [] as boolean[],
		requestRender(force?: boolean) {
			this.requestRenderCalls.push(Boolean(force));
		},
	};
	return { terminal, tui, writes };
}

function createStaticContainer(prefix: string) {
	return {
		render(width: number) {
			return [`${prefix}:${width}`];
		},
	};
}

function createCtx(options: { terminal?: any; autoInstantiate?: boolean; hasUI?: boolean; attachEditorContainer?: boolean; attachAdjacentContainers?: boolean } = {}) {
	const { tui, writes } = createTui({ terminal: options.terminal });
	const calls: Array<{ type: "editor" | "footer"; value: any }> = [];
	let editorFactory: any;
	let footerFactory: any;
	let editorInstance: any;
	let footerInstance: any;
	const editorContainer = {
		children: [] as any[],
		addChild(child: any) {
			this.children.push(child);
		},
		render(width: number) {
			return this.children.flatMap((child: any) => child.render(width));
		},
	};
	const statusContainer = createStaticContainer("status");
	const widgetContainerAbove = createStaticContainer("above");
	const widgetContainerBelow = createStaticContainer("below");
	if (options.attachEditorContainer !== false) {
		if (options.attachAdjacentContainers) {
			tui.children.push(statusContainer, widgetContainerAbove, editorContainer, widgetContainerBelow);
		} else {
			tui.children.push(editorContainer);
		}
	}

	let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let removedInputListeners = 0;
	const statusCalls: Array<{ key: string; value: string | undefined }> = [];
	const ctx: any = {
		hasUI: options.hasUI ?? true,
		ui: {
			onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
				inputHandler = handler;
				return () => {
					removedInputListeners += 1;
					if (inputHandler === handler) inputHandler = undefined;
				};
			},
			setStatus(key: string, value: string | undefined) {
				statusCalls.push({ key, value });
			},
			setEditorComponent(factory: any) {
				calls.push({ type: "editor", value: factory });
				editorFactory = factory;
				if (factory && options.autoInstantiate) {
					editorContainer.children = [];
					editorInstance = factory(tui, undefined, { matches: () => false });
					editorContainer.addChild(editorInstance);
				}
				if (!factory) {
					editorFactory = undefined;
					editorInstance = undefined;
					editorContainer.children = [];
				}
			},
			setFooter(factory: any) {
				calls.push({ type: "footer", value: factory });
				if (footerInstance?.dispose) {
					footerInstance.dispose();
				}
				footerFactory = factory;
				footerInstance = factory && options.autoInstantiate ? factory(tui, undefined, {}) : undefined;
			},
		},
	};

	return {
		calls,
		ctx,
		editorContainer,
		statusContainer,
		tui,
		widgetContainerAbove,
		widgetContainerBelow,
		writes,
		getEditorFactory: () => editorFactory,
		getFooterFactory: () => footerFactory,
		getEditorInstance: () => editorInstance,
		getFooterInstance: () => footerInstance,
		getInputHandler: () => inputHandler,
		getRemovedInputListeners: () => removedInputListeners,
		statusCalls,
		instantiateEditor() {
			editorContainer.children = [];
			editorInstance = editorFactory(tui, undefined, { matches: () => false });
			editorContainer.addChild(editorInstance);
			return editorInstance;
		},
		instantiateFooter() {
			footerInstance = footerFactory(tui, undefined, {});
			return footerInstance;
		},
	};
}

/** 断言已经恢复 editor/footer factory，避免留下半安装 layout。 */
function assertLayoutRestored(harness: ReturnType<typeof createCtx>) {
	assert.equal(harness.calls.some((call) => call.type === "editor" && call.value === undefined), true);
	assert.equal(harness.calls.some((call) => call.type === "footer" && call.value === undefined), true);
	assert.equal(harness.getEditorFactory(), undefined);
	assert.equal(harness.getFooterFactory(), undefined);
	assert.equal(harness.getEditorInstance(), undefined);
	assert.equal(harness.getFooterInstance(), undefined);
	assert.equal(harness.editorContainer.children.length, 0);
}

test("未 bind session 时 setEnabled(true) fail closed", () => {
	const runtime = createFixedBottomEditorRuntime();
	const status = runtime.setEnabled(true);

	assert.equal(status.enabled, false);
	assert.equal(status.installed, false);
	assert.match(status.failure ?? "", /bound UI session/);
});

test("无 UI session 能力时 setEnabled(true) fail closed", () => {
	for (const ctx of [{ hasUI: false, ui: {} }, { hasUI: true }, { hasUI: true, ui: undefined }]) {
		const runtime = createFixedBottomEditorRuntime();
		runtime.bindSession(ctx);

		const status = runtime.setEnabled(true);

		assert.equal(status.enabled, false);
		assert.equal(status.installed, false);
		assert.match(status.failure ?? "", /bound UI session/);
	}
});

test("缺 setEditorComponent 时 fail closed 且不调用 setFooter", () => {
	const footerCalls: any[] = [];
	const runtime = createFixedBottomEditorRuntime();
	runtime.bindSession({
		hasUI: true,
		ui: {
			setFooter(factory: any) {
				footerCalls.push(factory);
			},
		},
	});

	const status = runtime.setEnabled(true);

	assert.equal(status.enabled, false);
	assert.equal(status.installed, false);
	assert.match(status.failure ?? "", /setEditorComponent/);
	assert.deepEqual(footerCalls, []);
});

test("缺 setFooter 时 fail closed 且不调用 setEditorComponent", () => {
	const editorCalls: any[] = [];
	const runtime = createFixedBottomEditorRuntime();
	runtime.bindSession({
		hasUI: true,
		ui: {
			setEditorComponent(factory: any) {
				editorCalls.push(factory);
			},
		},
	});

	const status = runtime.setEnabled(true);

	assert.equal(status.enabled, false);
	assert.equal(status.installed, false);
	assert.match(status.failure ?? "", /setFooter/);
	assert.deepEqual(editorCalls, []);
});

test("bind 后 setEnabled(true) 调用 setEditorComponent/setFooter", () => {
	const harness = createCtx();
	const runtime = createFixedBottomEditorRuntime();

	runtime.bindSession(harness.ctx);
	const status = runtime.setEnabled(true);

	assert.equal(status.enabled, true);
	assert.equal(status.installed, false);
	assert.equal(harness.calls.length, 2);
	assert.equal(harness.calls[0]?.type, "editor");
	assert.equal(typeof harness.calls[0]?.value, "function");
	assert.equal(harness.calls[1]?.type, "footer");
	assert.equal(typeof harness.calls[1]?.value, "function");
});



test("beautified ON 且 fixed OFF 时安装 custom editor/footer 但不安装 compositor", () => {
	const harness = createCtx({ autoInstantiate: true });
	let compositorCreated = false;
	const runtime = createFixedBottomEditorRuntime({
		createCompositor() {
			compositorCreated = true;
			throw new Error("should not install fixed compositor");
		},
	});

	runtime.bindSession(harness.ctx);
	runtime.setBeautifiedInputEnabled?.(true);

	assert.equal(runtime.getStatus().enabled, false);
	assert.equal(runtime.getStatus().installed, false);
	assert.equal(typeof harness.getEditorFactory(), "function");
	assert.equal(typeof harness.getFooterFactory(), "function");
	assert.equal(compositorCreated, false);
	assert.ok(stripAnsi(harness.getEditorInstance().render(24).join("\n")).includes("╭"));
});

test("beautified ON 且 fixed OFF 时 footer 渲染下方附属信息", () => {
	const harness = createCtx({ autoInstantiate: true });
	let compositorCreated = false;
	const runtime = createFixedBottomEditorRuntime({
		startClock: false,
		createCompositor() {
			compositorCreated = true;
			throw new Error("should not install fixed compositor");
		},
	});

	runtime.bindSession(harness.ctx);
	runtime.setLastPrompt("上一个问题");
	runtime.setBeautifiedInputEnabled?.(true);
	const footerData = { getExtensionStatuses: () => new Map([["watcher", "CodeGraph watcher active"]]) };
	const footer = harness.getFooterFactory()({ terminal: { columns: 40, rows: 12, write() {} } }, { fg: (_token: string, text: string) => text }, footerData);
	const lines = footer.render(40).map(stripAnsi);

	assert.equal(compositorCreated, false);
	assert.deepEqual(lines, [" CodeGraph watcher active ", " ↳ 上一个问题"]);
});

test("fixed 模式下 editor 输入会主动请求底部重绘", async () => {
	const harness = createCtx({ autoInstantiate: true });
	const { runtime, getRepaintCalls } = createCountingRuntime();
	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	harness.tui.requestRenderCalls.length = 0;

	harness.getEditorInstance().handleInput("a");
	await new Promise((resolve) => setTimeout(resolve, 40));

	assert.equal(harness.getEditorInstance().getText(), "a");
	assert.equal(getRepaintCalls(), 1);
	assert.deepEqual(harness.tui.requestRenderCalls, []);
});

test("fixed 模式下程序化写入 editor 也会主动请求底部重绘", async () => {
	const harness = createCtx({ autoInstantiate: true });
	const { runtime, getRepaintCalls } = createCountingRuntime();
	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);

	harness.getEditorInstance().setText("hello");
	harness.getEditorInstance().insertTextAtCursor(" world");
	await new Promise((resolve) => setTimeout(resolve, 40));

	assert.equal(harness.getEditorInstance().getText(), "hello world");
	assert.equal(getRepaintCalls(), 1);
});

test("beautified OFF 且 fixed OFF 时恢复原生 editor/footer", () => {
	const harness = createCtx({ autoInstantiate: true });
	const runtime = createFixedBottomEditorRuntime();

	runtime.bindSession(harness.ctx);
	runtime.setBeautifiedInputEnabled?.(true);
	runtime.setBeautifiedInputEnabled?.(false);

	assertLayoutRestored(harness);
	assert.equal(runtime.getStatus().enabled, false);
	assert.equal(runtime.getStatus().installed, false);
});

test("footer factory 传入 fake tui 后安装 compositor", () => {
	const harness = createCtx();
	const runtime = createFixedBottomEditorRuntime();

	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	harness.instantiateEditor();
	harness.instantiateFooter();

	const status = runtime.getStatus();
	assert.equal(status.enabled, true);
	assert.equal(status.installed, true);
	assert.notEqual(harness.tui.render(40), []);
	assert.equal(harness.tui.requestRenderCalls.at(-1), true);
});

test("安装 compositor 时把原生 status 与 widget 容器纳入底部固定 cluster", () => {
	const harness = createCtx({ autoInstantiate: true, attachAdjacentContainers: true });
	const runtime = createFixedBottomEditorRuntime();

	runtime.bindSession(harness.ctx);
	const status = runtime.setEnabled(true);
	harness.tui.terminal.write("paint");

	assert.equal(status.installed, true);
	assert.deepEqual(harness.statusContainer.render(40), []);
	assert.deepEqual(harness.widgetContainerAbove.render(40), []);
	assert.deepEqual(harness.widgetContainerBelow.render(40), []);
	assert.ok(harness.writes.at(-1)?.includes("above:40"));
	assert.ok(harness.writes.at(-1)?.includes("status:40"));
	assert.ok(harness.writes.at(-1)?.includes("below:40"));
});

test("缺 terminal.write 时失败且不半安装", () => {
	const harness = createCtx({ terminal: { columns: 40, rows: 12 }, autoInstantiate: true });
	const runtime = createFixedBottomEditorRuntime();

	runtime.bindSession(harness.ctx);
	const status = runtime.setEnabled(true);

	assert.equal(status.enabled, false);
	assert.equal(status.installed, false);
	assert.match(status.failure ?? "", /terminal\.write/);
	assertLayoutRestored(harness);
	assert.equal(runtime.getStatus().installed, false);
});

test("找不到 editor container 时 fail closed", () => {
	const harness = createCtx({ autoInstantiate: true, attachEditorContainer: false });
	const runtime = createFixedBottomEditorRuntime();

	runtime.bindSession(harness.ctx);
	const status = runtime.setEnabled(true);

	assert.equal(status.enabled, false);
	assert.equal(status.installed, false);
	assert.match(status.failure ?? "", /editor container/);
	assertLayoutRestored(harness);
});

test("compositor hideRenderable 抛错时 fail closed 并释放已创建 compositor", () => {
	const harness = createCtx({ autoInstantiate: true });
	const calls: string[] = [];
	const runtime = createFixedBottomEditorRuntime({
		createCompositor() {
			return {
				install() {
					calls.push("install");
				},
				dispose() {
					calls.push("dispose");
				},
				hideRenderable() {
					calls.push("hideRenderable");
					throw new Error("hide failed");
				},
				renderHidden() {
					return [];
				},
				requestRepaint() {},
			};
		},
	});

	runtime.bindSession(harness.ctx);
	const status = runtime.setEnabled(true);

	assert.equal(status.enabled, false);
	assert.equal(status.installed, false);
	assert.match(status.failure ?? "", /hide failed/);
	assert.deepEqual(calls, ["hideRenderable", "dispose"]);
	assertLayoutRestored(harness);
});

test("compositor install 抛错时 fail closed 并释放已创建 compositor", () => {
	const harness = createCtx({ autoInstantiate: true });
	const calls: string[] = [];
	const runtime = createFixedBottomEditorRuntime({
		createCompositor() {
			return {
				install() {
					calls.push("install");
					throw new Error("install failed");
				},
				dispose() {
					calls.push("dispose");
				},
				hideRenderable() {
					calls.push("hideRenderable");
				},
				renderHidden() {
					return [];
				},
				requestRepaint() {},
			};
		},
	});

	runtime.bindSession(harness.ctx);
	const status = runtime.setEnabled(true);

	assert.equal(status.enabled, false);
	assert.equal(status.installed, false);
	assert.match(status.failure ?? "", /install failed/);
	assert.deepEqual(calls, ["hideRenderable", "install", "dispose"]);
	assertLayoutRestored(harness);
});

test("失败后修复 ctx 再启用可成功安装", () => {
	const badTerminal = { columns: 40, rows: 12 };
	const harness = createCtx({ terminal: badTerminal, autoInstantiate: true });
	const runtime = createFixedBottomEditorRuntime();

	runtime.bindSession(harness.ctx);
	const failed = runtime.setEnabled(true);
	(badTerminal as any).write = (data: string) => harness.writes.push(data);
	const installed = runtime.setEnabled(true);

	assert.equal(failed.enabled, false);
	assert.equal(failed.installed, false);
	assert.match(failed.failure ?? "", /terminal\.write/);
	assert.equal(installed.enabled, true);
	assert.equal(installed.installed, true);
	assert.equal(installed.failure, undefined);
	assert.equal(runtime.getStatus().installed, true);
});

test("已安装后 bindSession(newCtx) 会先释放旧 session layout/compositor", () => {
	const oldHarness = createCtx({ autoInstantiate: true });
	const newHarness = createCtx({ autoInstantiate: true });
	const runtime = createFixedBottomEditorRuntime();

	runtime.bindSession(oldHarness.ctx);
	const installed = runtime.setEnabled(true);
	const oldWrite = oldHarness.tui.terminal.write;
	runtime.bindSession(newHarness.ctx);

	assert.equal(installed.installed, true);
	assert.notEqual(oldHarness.tui.terminal.write, oldWrite);
	assertLayoutRestored(oldHarness);
	assert.equal(runtime.getStatus().enabled, false);
	assert.equal(runtime.getStatus().installed, false);
});

test("重复启用不重复安装", () => {
	const harness = createCtx({ autoInstantiate: true });
	const runtime = createFixedBottomEditorRuntime();

	runtime.bindSession(harness.ctx);
	const first = runtime.setEnabled(true);
	const callCount = harness.calls.length;
	const second = runtime.setEnabled(true);

	assert.equal(first.installed, true);
	assert.equal(second.installed, true);
	assert.equal(harness.calls.length, callCount);
});

test("setEnabled(false) 只关闭 fixed layer 并保留美化 editor/footer", () => {
	const harness = createCtx({ autoInstantiate: true });
	const runtime = createFixedBottomEditorRuntime();

	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	const installedWrite = harness.tui.terminal.write;
	harness.tui.terminal.write("before-disable");
	assert.ok(harness.writes.at(-1)?.includes("before-disable"));

	const disabled = runtime.setEnabled(false);
	const disabledAgain = runtime.setEnabled(false);

	assert.equal(disabled.enabled, false);
	assert.equal(disabled.installed, false);
	assert.equal(disabledAgain.enabled, false);
	assert.equal(disabledAgain.installed, false);
	assert.notEqual(harness.tui.terminal.write, installedWrite);
	assert.equal(typeof harness.getEditorFactory(), "function");
	assert.equal(typeof harness.getFooterFactory(), "function");
	assert.equal(harness.calls.some((call) => call.type === "editor" && call.value === undefined), false);
	assert.equal(harness.calls.some((call) => call.type === "footer" && call.value === undefined), false);
});

test("dispose 幂等并清理 session 引用", () => {
	const harness = createCtx({ autoInstantiate: true });
	const runtime = createFixedBottomEditorRuntime();

	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	assert.doesNotThrow(() => runtime.dispose());
	assert.doesNotThrow(() => runtime.dispose());

	const status = runtime.setEnabled(true);
	assert.equal(status.enabled, false);
	assert.equal(status.installed, false);
	assert.match(status.failure ?? "", /bound UI session/);
});

function createCountingRuntime() {
	let repaintCalls = 0;
	const runtime = createFixedBottomEditorRuntime({
		createCompositor() {
			return {
				install() {},
				dispose() {},
				hideRenderable() {},
				renderHidden() {
					return [];
				},
				requestRepaint() {
					repaintCalls += 1;
				},
				setKeyboardScrollShortcuts() {},
				jumpToPreviousRootTarget() {
					return false;
				},
				jumpToNextRootTarget() {
					return false;
				},
				jumpToRootBottom() {
					return false;
				},
			};
		},
	});
	return { runtime, getRepaintCalls: () => repaintCalls };
}


test("美化输入框开启时 fixed cluster 渲染已由 custom editor 按内框宽度处理的输出", () => {
	const harness = createCtx({ autoInstantiate: true });
	const renderWidths: number[] = [];
	let capturedRenderCluster: ((width: number, terminalRows: number) => any) | undefined;
	const runtime = createFixedBottomEditorRuntime({
		createCompositor(options) {
			capturedRenderCluster = options.renderCluster;
			return {
				install() {},
				dispose() {},
				hideRenderable() {},
				renderHidden(_container: any, width: number) {
					renderWidths.push(width);
					return ["x".repeat(width)];
				},
				requestRepaint() {},
				setKeyboardScrollShortcuts() {},
				jumpToPreviousRootTarget() { return false; },
				jumpToNextRootTarget() { return false; },
				jumpToRootBottom() { return false; },
			};
		},
	});
	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	runtime.setBeautifiedInputEnabled?.(true);

	const cluster = capturedRenderCluster?.(20, 10);

	assert.equal(renderWidths[0], 20);
	assert.ok(cluster?.lines.length);
});

test("美化输入框切换只请求 bottom cluster repaint，不触发 full render", async () => {
	const harness = createCtx({ autoInstantiate: true });
	const { runtime, getRepaintCalls } = createCountingRuntime();
	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	harness.tui.requestRenderCalls.length = 0;

	runtime.setBeautifiedInputEnabled?.(false);
	await new Promise((resolve) => setTimeout(resolve, 40));

	assert.deepEqual(harness.tui.requestRenderCalls, []);
	assert.equal(getRepaintCalls(), 1);
});

test("full render 请求会升级已排队的普通 repaint", async () => {
	const harness = createCtx({ autoInstantiate: true });
	const { runtime, getRepaintCalls } = createCountingRuntime();
	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	harness.tui.requestRenderCalls.length = 0;

	runtime.requestRender();
	runtime.requestRender({ full: true });
	await new Promise((resolve) => setTimeout(resolve, 40));

	assert.deepEqual(harness.tui.requestRenderCalls, [false]);
	assert.equal(getRepaintCalls(), 0);
});

test("dispose 会让 pending render 失效且不再 repaint", async () => {
	const harness = createCtx({ autoInstantiate: true });
	const { runtime, getRepaintCalls } = createCountingRuntime();
	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	harness.tui.requestRenderCalls.length = 0;

	runtime.requestRender();
	runtime.dispose();
	await new Promise((resolve) => setTimeout(resolve, 40));

	assert.deepEqual(harness.tui.requestRenderCalls, []);
	assert.equal(getRepaintCalls(), 0);
});

test("dispose 使用已缓存 UI 恢复 layout，不重新读取 stale ctx.ui", () => {
	const harness = createCtx({ autoInstantiate: true });
	const runtime = createFixedBottomEditorRuntime();
	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	Object.defineProperty(harness.ctx, "ui", {
		get() {
			throw new Error("stale ctx");
		},
	});

	assert.doesNotThrow(() => runtime.dispose());
	assertLayoutRestored(harness);
	assert.equal(harness.statusCalls.at(-1)?.key, "alps-pi-stash");
	assert.equal(harness.statusCalls.at(-1)?.value, undefined);
});

test("旧 input listener 在重新 bind session 后不会消费输入", () => {
	const oldHarness = createCtx({ autoInstantiate: true });
	const newHarness = createCtx({ autoInstantiate: true });
	const runtime = createFixedBottomEditorRuntime();
	runtime.bindSession(oldHarness.ctx);
	runtime.setEnabled(true);
	const oldHandler = oldHarness.getInputHandler();

	runtime.bindSession(newHarness.ctx);
	runtime.setEnabled(true);

	assert.equal(oldHarness.getRemovedInputListeners(), 1);
	assert.equal(oldHandler?.("\u001bs"), undefined);
});
