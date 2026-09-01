/** 功能：验证 regular/fullscreen 均只通过 Pi 公开 UI API 安装 Alps input。 */

import assert from "node:assert/strict";
import test from "node:test";
import { createBottomInputRuntime } from "../src/features/bottom-input/runtime.ts";
import { createInitialPatchState, disablePatch, enablePatch, PATCH_KEY } from "../src/features/chrome-frame/patch.ts";
import { createFakeTheme } from "./helpers.test.ts";

function createRenderer(mode: "regular" | "fullscreen") {
	return {
		mode,
		terminal: { columns: 80, rows: 24, write() {} },
		children: [],
		viewportTop: 0,
		renders: 0,
		scrolls: [] as number[],
		render() { return ["root"]; },
		doRender() {},
		requestRender() { this.renders += 1; },
		hasOverlay() { return false; },
		scrollBy(lines: number) { this.scrolls.push(lines); },
		scrollToBottom() { this.scrolls.push(Number.POSITIVE_INFINITY); },
	};
}

function stableReference(getRenderer: () => ReturnType<typeof createRenderer>) {
	return new Proxy({}, {
		get: (_target, property) => {
			let renderer = getRenderer();
			let value = Reflect.get(renderer, property, renderer);
			if (typeof value !== "function") return value;
			return (...args: any[]) => {
				renderer = getRenderer();
				value = Reflect.get(renderer, property, renderer);
				return Reflect.apply(value, renderer, args);
			};
		},
		set: (_target, property, value) => Reflect.set(getRenderer(), property, value, getRenderer()),
		has: (_target, property) => Reflect.has(getRenderer(), property),
		getPrototypeOf: () => Reflect.getPrototypeOf(getRenderer()),
	});
}

test("regular/fullscreen mode switch 保持单一公开 editor/footer owner 且不修改 terminal/renderer", async () => {
	(globalThis as any)[PATCH_KEY] = createInitialPatchState();
	const chromeState = enablePatch();
	let renderer = createRenderer("regular");
	const reference = stableReference(() => renderer);
	const originalRegularRender = renderer.render;
	const originalRegularDoRender = renderer.doRender;
	const originalRegularWrite = renderer.terminal.write;
	const originalRegularRows = Object.getOwnPropertyDescriptor(renderer.terminal, "rows");
	let editorFactory: any;
	let footerFactory: any;
	let editor: any;
	let footer: any;
	let editorInstallCount = 0;
	let footerInstallCount = 0;
	const inputHandlers: Function[] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		model: { name: "test", contextWindow: 1000 },
		getContextUsage: () => ({ tokens: 10, contextWindow: 1000, percent: 1 }),
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: createFakeTheme(),
			getEditorComponent: () => editorFactory,
			setEditorComponent(factory: any) {
				editorFactory = factory;
				if (factory) {
					editorInstallCount += 1;
					editor = factory(reference, { borderColor: (text: string) => text, selectList: {} }, {});
				}
			},
			setFooter(factory: any) {
				footerFactory = factory;
				if (factory) {
					footerInstallCount += 1;
					footer = factory(reference, createFakeTheme(), { getExtensionStatuses: () => new Map(), onBranchChange: () => () => undefined });
				}
			},
			onTerminalInput(handler: Function) {
				inputHandlers.push(handler);
				return () => inputHandlers.splice(inputHandlers.indexOf(handler), 1);
			},
			setStatus() {},
		},
	};
	const runtime = createBottomInputRuntime({ startClock: false });
	runtime.bindSession(ctx);
	const status = runtime.configure({ beautifiedInputEnabled: true });
	assert.equal(status.installed, true);
	assert.equal(editorInstallCount, 1);
	assert.equal(footerInstallCount, 1);
	assert.equal(inputHandlers.length, 1);
	assert.ok(editor.render(80).length > 0);
	assert.ok(Array.isArray(footer.render(80)));
	assert.equal(renderer.render, originalRegularRender);
	assert.equal(renderer.doRender, originalRegularDoRender);
	assert.equal(renderer.terminal.write, originalRegularWrite);
	assert.deepEqual(Object.getOwnPropertyDescriptor(renderer.terminal, "rows"), originalRegularRows);

	renderer = createRenderer("fullscreen");
	const originalFullscreenRender = renderer.render;
	const originalFullscreenDoRender = renderer.doRender;
	const originalFullscreenWrite = renderer.terminal.write;
	runtime.configure({ beautifiedInputEnabled: true });
	runtime.requestRender({ full: true });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(editorInstallCount, 1);
	assert.equal(footerInstallCount, 1);
	assert.equal(inputHandlers.length, 1);
	assert.ok(renderer.renders > 0);
	assert.equal(renderer.render, originalFullscreenRender);
	assert.equal(renderer.doRender, originalFullscreenDoRender);
	assert.equal(renderer.terminal.write, originalFullscreenWrite);

	const originalEditor = editor;
	runtime.setStreaming?.(true);
	renderer = createRenderer("regular");
	const secondRegularRender = renderer.render;
	const secondRegularDoRender = renderer.doRender;
	runtime.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 50));
	runtime.setStreaming?.(false);
	assert.equal(editor, originalEditor);
	assert.equal(editorInstallCount, 1);
	assert.equal(footerInstallCount, 1);
	assert.equal(inputHandlers.length, 1);
	assert.equal(renderer.render, secondRegularRender);
	assert.equal(renderer.doRender, secondRegularDoRender);
	assert.deepEqual(renderer.scrolls, [], "Pi must retain transcript scrolling ownership");

	(renderer as any).mode = "transitioning";
	runtime.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(runtime.getStatus().installed, false);
	assert.equal(runtime.getStatus().failure, "unsupported Pi TUI renderer mode");
	assert.equal(chromeState.enabled, true, "mode-specific input failure must not disable chrome-frame");
	assert.equal(inputHandlers.length, 0);
	assert.equal(editorFactory, undefined);
	assert.equal(footerFactory, undefined);

	runtime.dispose();
	disablePatch();
	(globalThis as any)[PATCH_KEY] = createInitialPatchState();
});
