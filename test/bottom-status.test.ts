/** 功能：验证底部状态栏与 Alt+S 暂存逻辑 实现者：alps 实现日期：2026-05-27 */

import assert from "node:assert/strict";
import test from "node:test";
import { createBottomStatusRuntime, isStashShortcutInput } from "../src/features/bottom-status/index.ts";
import { createFakeTheme, stripAnsi } from "./helpers.test.ts";

function createCtx() {
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	const widgets: Array<{ key: string; content: any; options?: any }> = [];
	const inputHandlers: Array<(data: string) => { consume?: boolean; data?: string } | undefined> = [];
	const renderCalls: number[] = [];
	let editorText = "";
	const tui = {
		requestRender() {
			renderCalls.push(1);
		},
	};
	const ctx: any = {
		hasUI: true,
		model: { name: "GPT-5.5", reasoning: true, contextWindow: 272000 },
		getThinkingLevel: () => "medium",
		getContextUsage: () => ({ tokens: 190000, contextWindow: 272000, percent: 69.9 }),
		sessionManager: {
			getBranch: () => [
				{ type: "message", message: { role: "assistant", usage: { input: 1000, output: 500, cacheRead: 250, cacheWrite: 0, cost: { total: 0 } } } },
			],
		},
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			setStatus(key: string, value: string | undefined) {
				statuses.push({ key, value });
			},
			setWidget(key: string, content: any, options?: any) {
				widgets.push({ key, content, options });
			},
			onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined) {
				inputHandlers.push(handler);
				return () => {
					const index = inputHandlers.indexOf(handler);
					if (index >= 0) inputHandlers.splice(index, 1);
				};
			},
			getEditorText() {
				return editorText;
			},
			setEditorText(text: string) {
				editorText = text;
			},
		},
	};
	return {
		ctx,
		notifications,
		renderCalls,
		statuses,
		widgets,
		input(data: string) {
			return inputHandlers.at(-1)?.(data);
		},
		getEditorText: () => editorText,
		getInputHandlerCount: () => inputHandlers.length,
		setEditorText(text: string) {
			editorText = text;
		},
		instantiateWidget(key = "alps-pi-bottom-status") {
			const widget = widgets.findLast((entry) => entry.key === key && typeof entry.content === "function");
			assert.ok(widget);
			return widget.content(tui, createFakeTheme());
		},
	};
}

test("上方状态栏显示模型、thinking、上下文进度条和会话耗时", () => {
	let now = 1000;
	const harness = createCtx();
	const runtime = createBottomStatusRuntime({ startClock: false, now: () => now });

	runtime.bindSession(harness.ctx);
	runtime.resetSessionStartTime();
	now = 87_000;
	runtime.setEnabled(true);
	const component = harness.instantiateWidget();
	const line = stripAnsi(component.render(80).join("\n"));

	assert.match(line, /GPT-5\.5/);
	assert.match(line, /think:med/);
	assert.match(line, /ctx [━╸─]+ 69\.9%\/272k/);
	assert.match(component.render(80).join("\n"), /\x1b\[38;2;0;175;175m69\.9%\/272k/);
	assert.match(line, /◷ 1m26s/);
	assert.doesNotMatch(line, /host|⊛|\d{2}:\d{2}/i);
	assert.equal(harness.widgets.find((entry) => entry.key === "alps-pi-bottom-status")?.options?.placement, "aboveEditor");
});

test("thinking high/xhigh 使用原版 rainbow 逐字符配色", () => {
	const harness = createCtx();
	harness.ctx.getThinkingLevel = () => "xhigh";
	const runtime = createBottomStatusRuntime({ startClock: false, now: () => 2000 });

	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	const component = harness.instantiateWidget();
	const rawLine = component.render(80).join("\n");
	const line = stripAnsi(rawLine);

	assert.match(line, /think:xhigh/);
	assert.match(rawLine, /\x1b\[38;2;178;129;214mt/);
	assert.match(rawLine, /\x1b\[38;2;215;135;175mh/);
	assert.doesNotMatch(rawLine, /\x1b\[38;2;[0-9;]+m:/);
});

test("thinking 可从 session thinking_level_change 回退读取", () => {
	const harness = createCtx();
	harness.ctx.getThinkingLevel = undefined;
	harness.ctx.sessionManager = {
		getBranch: () => [
			{ type: "thinking_level_change", thinkingLevel: "high" },
			{ type: "message", message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } },
		],
	};
	const runtime = createBottomStatusRuntime({ startClock: false, now: () => 2000 });

	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	const component = harness.instantiateWidget();
	const rawLine = component.render(80).join("\n");

	assert.match(stripAnsi(rawLine), /think:high/);
	assert.match(rawLine, /\x1b\[38;2;178;129;214mt/);
});

test("上下文找不到 window 时只显示已用量", () => {
	const harness = createCtx();
	harness.ctx.getContextUsage = () => ({ tokens: 37000 });
	harness.ctx.model = { name: "GPT-5.5" };
	const runtime = createBottomStatusRuntime({ startClock: false, now: () => 2000 });

	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	const component = harness.instantiateWidget();
	const line = stripAnsi(component.render(80).join("\n"));

	assert.match(line, /ctx 37k/);
	assert.doesNotMatch(line, /[█░━╸─]|%|\/272k/);
});

test("缺失数据直接省略对应 segment", () => {
	const harness = createCtx();
	harness.ctx.model = undefined;
	harness.ctx.getThinkingLevel = () => "";
	harness.ctx.getContextUsage = undefined;
	harness.ctx.sessionManager = { getBranch: () => [] };
	const runtime = createBottomStatusRuntime({ startClock: false, now: () => 500 });

	runtime.bindSession(harness.ctx);
	runtime.resetSessionStartTime();
	runtime.setEnabled(true);
	const component = harness.instantiateWidget();
	const line = stripAnsi(component.render(80).join("\n"));

	assert.equal(line, "");
	assert.doesNotMatch(line, /unknown|no-model|think|ctx|NaN|undefined|◷/i);
});

test("下方 last prompt 显示上一个问题并压缩截断", () => {
	const harness = createCtx();
	const runtime = createBottomStatusRuntime({ startClock: false, now: () => 2000 });

	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	runtime.setLastPrompt("第一行\n   第二行\t第三行很长很长很长");
	const component = harness.instantiateWidget("alps-pi-last-prompt");
	const line = stripAnsi(component.render(24).join("\n"));

	assert.match(line, /^ ↳ 第一行 第二行/);
	assert.match(line, /…$/);
	assert.doesNotMatch(line, /\n|\t/);
	assert.equal(harness.widgets.find((entry) => entry.key === "alps-pi-last-prompt")?.options?.placement, "belowEditor");
});

test("last prompt 缺失时下方 widget 隐藏", () => {
	const harness = createCtx();
	const runtime = createBottomStatusRuntime({ startClock: false, now: () => 2000 });

	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	const component = harness.instantiateWidget("alps-pi-last-prompt");

	assert.deepEqual(component.render(80), []);
});

test("Alt+S 有输入时暂存并清空，空输入时恢复", () => {
	const harness = createCtx();
	const runtime = createBottomStatusRuntime({ startClock: false });
	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	harness.setEditorText("hello");

	assert.deepEqual(harness.input("\x1bs"), { consume: true });
	assert.equal(harness.getEditorText(), "");
	assert.deepEqual(harness.statuses.at(-1), { key: "alps-pi-stash", value: "stash" });
	assert.match(harness.notifications.at(-1)?.message ?? "", /Text stashed/);

	assert.deepEqual(harness.input("\x1bs"), { consume: true });
	assert.equal(harness.getEditorText(), "hello");
	assert.deepEqual(harness.statuses.at(-1), { key: "alps-pi-stash", value: undefined });
	assert.match(harness.notifications.at(-1)?.message ?? "", /Stash restored/);
});

test("Alt+S 多种终端编码与原版一致", () => {
	for (const input of ["ß", "\x1bs", "\x1bS", "\x1b[115;3u", "\x1b[27;3;115~", "\x1b[27;3;83~"]) {
		assert.equal(isStashShortcutInput(input), true, JSON.stringify(input));
	}
	assert.equal(isStashShortcutInput("s"), false);
});

test("dispose 移除上下 widget、stash 状态和 input listener", () => {
	const harness = createCtx();
	const runtime = createBottomStatusRuntime({ startClock: false });

	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	assert.equal(harness.getInputHandlerCount(), 1);
	runtime.dispose();

	assert.equal(harness.getInputHandlerCount(), 0);
	assert.deepEqual(harness.widgets.at(-2), { key: "alps-pi-bottom-status", content: undefined, options: undefined });
	assert.deepEqual(harness.widgets.at(-1), { key: "alps-pi-last-prompt", content: undefined, options: undefined });
	assert.deepEqual(harness.statuses.at(-1), { key: "alps-pi-stash", value: undefined });
});
