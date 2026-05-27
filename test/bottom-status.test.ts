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
		model: { name: "Claude Sonnet 4", reasoning: true },
		getThinkingLevel: () => "medium",
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
		instantiateWidget() {
			const widget = widgets.findLast((entry) => typeof entry.content === "function");
			assert.ok(widget);
			return widget.content(tui, createFakeTheme());
		},
	};
}

test("底部状态栏显示模型、thinking、总 token 和时间", () => {
	const harness = createCtx();
	const runtime = createBottomStatusRuntime({ startClock: false });

	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	const component = harness.instantiateWidget();
	const line = stripAnsi(component.render(80).join("\n"));

	assert.match(line, /Sonnet 4/);
	assert.match(line, /think:med/);
	assert.match(line, /⊛ 1\.8k/);
	assert.match(line, /◷ \d{2}:\d{2}/);
	assert.equal(harness.widgets.at(-1)?.options?.placement, "aboveEditor");
});

test("缺失数据直接省略对应 segment", () => {
	const harness = createCtx();
	harness.ctx.model = undefined;
	harness.ctx.getThinkingLevel = () => "off";
	harness.ctx.sessionManager = { getBranch: () => [] };
	const runtime = createBottomStatusRuntime({ startClock: false });

	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	const component = harness.instantiateWidget();
	const line = stripAnsi(component.render(80).join("\n"));

	assert.doesNotMatch(line, /unknown|no-model|think:off|⊛/i);
	assert.match(line, /◷ \d{2}:\d{2}/);
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

test("dispose 移除 widget、stash 状态和 input listener", () => {
	const harness = createCtx();
	const runtime = createBottomStatusRuntime({ startClock: false });

	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	assert.equal(harness.getInputHandlerCount(), 1);
	runtime.dispose();

	assert.equal(harness.getInputHandlerCount(), 0);
	assert.deepEqual(harness.widgets.at(-1), { key: "alps-pi-bottom-status", content: undefined, options: undefined });
	assert.deepEqual(harness.statuses.at(-1), { key: "alps-pi-stash", value: undefined });
});
