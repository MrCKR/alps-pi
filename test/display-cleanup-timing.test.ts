/** 功能：验证显示层清理的尾沿去抖行为（空闲不自激、活动结束清一次） 实现者：alps 实现日期：2026-11-10 */

import assert from "node:assert/strict";
import test from "node:test";
import { createBottomInputRuntime } from "../src/features/bottom-input/runtime.ts";

function createHarness() {
	let editorFactory: any;
	let footerFactory: any;
	const footerData = { getExtensionStatuses: () => new Map(), onBranchChange: () => () => undefined };
	const theme = { fg: (_t: string, text: string) => text, bg: (_t: string, text: string) => text, bold: (text: string) => text };
	const ui: any = {
		theme,
		setEditorComponent: (factory: any) => { editorFactory = factory; },
		getEditorComponent: () => editorFactory,
		setFooter: (factory: any) => { footerFactory = factory; },
		setStatus: () => undefined,
		getEditorText: () => "",
		setEditorText: () => undefined,
		notify: () => undefined,
		onTerminalInput: () => () => undefined,
	};
	const ctx: any = {
		mode: "tui",
		hasUI: true,
		ui,
		isCurrent: true,
		model: { name: "m", contextWindow: 1000 },
		getContextUsage: () => null,
		getThinkingLevel: () => null,
		sessionManager: { getBranch: () => [], getEntries: () => [] },
	};
	const tui = { mode: "fullscreen", terminal: { columns: 80, rows: 20 }, requestRender() {}, hasOverlay: () => false };
	const runtime = createBottomInputRuntime({ startClock: false });
	runtime.bindSession(ctx);
	runtime.configure({ beautifiedInputEnabled: true, footerEnabled: true });
	const footer = footerFactory(tui, theme, footerData);
	const editor = editorFactory(tui, { borderColor: (t: string) => t, selectList: {} }, {});
	return { runtime, footer, editor, tui, footerData };
}

test("空闲时不翻转标记（不受定时器驱动）", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { runtime, footer } = createHarness();
	const before = footer.render(80);
	t.mock.timers.tick(20_000);
	assert.deepEqual(footer.render(80), before, "没有外部活动就不应变化");
	runtime.dispose();
	t.mock.timers.reset();
});

test("活动结束后抖动一次，且不自激成周期循环", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const { runtime, footer } = createHarness();
	const initial = footer.render(80);

	// 模拟一串流式活动：每次都重置尾沿定时器
	for (let index = 0; index < 10; index += 1) {
		runtime.setLiveUsage({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, { type: "text_delta", delta: "x" });
		t.mock.timers.tick(50);
	}
	assert.deepEqual(footer.render(80), initial, "活动期间不清理");

	// 活动停止后越过去抖窗口
	t.mock.timers.tick(500);
	const afterCleanup = footer.render(80);
	assert.notDeepEqual(afterCleanup, initial, "静止后应清一次");
	assert.ok(afterCleanup.every((line: string) => line.endsWith("\x1b[0m")));

	// 再等很久也不应继续翻转（不自激）
	t.mock.timers.tick(20_000);
	assert.deepEqual(footer.render(80), afterCleanup, "清理自身不能再安排下一次");

	runtime.dispose();
	t.mock.timers.reset();
});

test("持续活动不超过最大等待时间才清理", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const { runtime, footer } = createHarness();
	const initial = footer.render(80);
	for (let index = 0; index < 100; index += 1) {
		runtime.setLiveUsage({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, { type: "text_delta", delta: "x" });
		t.mock.timers.tick(100);
	}
	assert.notDeepEqual(footer.render(80), initial, "持续活动也应在最大等待后清一次");
	runtime.dispose();
	t.mock.timers.reset();
});
