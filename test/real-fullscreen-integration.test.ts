/** 功能：使用真实 TuiAltScreen 验证 Pi 原生 fullscreen dock/scroll/overlay 不被 Alps 接管。 */

import assert from "node:assert/strict";
import test from "node:test";
import { Container, ScrollView, Text, TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { createBottomInputRuntime } from "../src/features/bottom-input/runtime.ts";
import { createFakeTheme } from "./helpers.test.ts";

class FakeTerminal {
	columns = 60;
	rows = 12;
	kittyProtocolActive = false;
	writes: string[] = [];
	input?: (data: string) => void;
	start(onInput: (data: string) => void) { this.input = onInput; }
	stop() { this.input = undefined; }
	async drainInput() {}
	write(data: string) { this.writes.push(data); }
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
}

test("真实 TuiAltScreen clipboard failure 后仍可滚动、overlay 和正常 stop", async () => {
	const terminal = new FakeTerminal();
	let copyCalls = 0;
	const tui = new TuiAltScreen(terminal as any, false, undefined, {
		mouse: true,
		copyOnSelect: true,
		copySelection: async () => {
			copyCalls += 1;
			return false;
		},
	});
	const document = new Container();
	for (let index = 0; index < 30; index += 1) document.addChild(new Text(`line-${index}`, 0, 0));
	const scrollView = new ScrollView(document, { follow: "end", primary: true });
	tui.setLayoutRoot(new VStack([{ component: scrollView, basis: 0, grow: 1, minSize: 1 }]));
	try {
		tui.start();
		tui.renderNow(true);
		assert.equal(await (tui as any).copyTextToClipboard("selection"), false);
		assert.equal(copyCalls, 1);
		tui.scrollToTop();
		tui.scrollBy(3);
		assert.ok(tui.viewportTop > 0);
		const overlay = tui.showOverlay(new Text("still alive", 0, 0));
		assert.equal(tui.hasOverlay(), true);
		overlay.hide();
	} finally {
		tui.stop();
	}
	assert.equal(terminal.input, undefined);
});

test("真实 TuiAltScreen 保持原生 dock、scroll、overlay 与 selection API", () => {
	const terminal = new FakeTerminal();
	const tui = new TuiAltScreen(terminal as any, false, undefined, { mouse: true, copyOnSelect: false });
	const document = new Container();
	for (let index = 0; index < 40; index += 1) document.addChild(new Text(`transcript-${index}`, 0, 0));
	const scrollView = new ScrollView(document, { follow: "end", primary: true });
	const editorContainer = new Container();
	const footerContainer = new Container();
	const dock = new VStack([
		{ component: editorContainer, basis: "auto", minSize: 3 },
		{ component: footerContainer, basis: "auto", minSize: 1 },
	]);
	tui.setLayoutRoot(new VStack([
		{ component: scrollView, basis: 0, grow: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, minSize: 1 },
	]));
	const originalRender = tui.render;
	const originalDoRender = (tui as any).doRender;
	const originalWrite = terminal.write;
	const originalRows = Object.getOwnPropertyDescriptor(terminal, "rows");
	const originalSelection = tui.hasActiveSelection;
	const inputHandlers = new Set<Function>();
	let editorFactory: any;
	let footer: any;
	const theme = createFakeTheme();
	const ctx: any = {
		mode: "tui",
		hasUI: true,
		model: { name: "test", contextWindow: 1000 },
		getContextUsage: () => ({ tokens: 10, contextWindow: 1000, percent: 1 }),
		sessionManager: { getBranch: () => [] },
		ui: {
			theme,
			getEditorComponent: () => editorFactory,
			setEditorComponent(factory: any) {
				editorFactory = factory;
				editorContainer.clear();
				if (factory) editorContainer.addChild(factory(tui, { borderColor: (text: string) => text, selectList: {} }, {}));
			},
			setFooter(factory: any) {
				footer?.dispose?.();
				footerContainer.clear();
				footer = factory?.(tui, theme, { getExtensionStatuses: () => new Map(), onBranchChange: () => () => undefined });
				if (footer) footerContainer.addChild(footer);
			},
			onTerminalInput(handler: Function) {
				inputHandlers.add(handler);
				return () => inputHandlers.delete(handler);
			},
			setStatus() {},
			notify() {},
		},
	};
	const runtime = createBottomInputRuntime({ startClock: false });
	try {
		tui.start();
		runtime.bindSession(ctx);
		assert.equal(runtime.configure({ beautifiedInputEnabled: true }).installed, true);
		tui.renderNow(true);
		assert.equal(editorContainer.children.length, 1);
		assert.equal(footerContainer.children.length, 1);
		assert.equal(inputHandlers.size, 1);
		assert.equal(tui.render, originalRender);
		assert.equal((tui as any).doRender, originalDoRender);
		assert.equal(terminal.write, originalWrite);
		assert.deepEqual(Object.getOwnPropertyDescriptor(terminal, "rows"), originalRows);
		assert.equal(tui.hasActiveSelection, originalSelection);
		assert.equal(tui.hasActiveSelection(), false);

		tui.scrollToTop();
		const top = tui.viewportTop;
		tui.scrollBy(5);
		assert.ok(tui.viewportTop > top);
		const overlay = tui.showOverlay(new Text("overlay", 0, 0), { anchor: "center", width: 20 });
		assert.equal(tui.hasOverlay(), true);
		tui.renderNow();
		overlay.hide();
		assert.equal(tui.hasOverlay(), false);
	} finally {
		runtime.dispose();
		tui.stop();
	}
	assert.equal(inputHandlers.size, 0);
	assert.equal(editorContainer.children.length, 0);
	assert.equal(footerContainer.children.length, 0);
});
