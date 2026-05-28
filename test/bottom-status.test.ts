/** 功能：验证 bottom-input 状态渲染与 Alt+S 暂存逻辑 实现者：alps 实现日期：2026-05-28 */

import assert from "node:assert/strict";
import { setImmediate as flushMicrotasks } from "node:timers/promises";
import test from "node:test";
import { createBottomInputRuntime, renderBottomInputStatus } from "../src/features/bottom-input/index.ts";
import { isStashShortcutInput } from "../src/features/bottom-status/index.ts";
import { createFakeTheme, stripAnsi } from "./helpers.test.ts";

function createCtx() {
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	const inputHandlers: Array<(data: string) => { consume?: boolean; data?: string } | undefined> = [];
	let editorText = "";
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
			setEditorComponent() {},
			setFooter() {},
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			setStatus(key: string, value: string | undefined) {
				statuses.push({ key, value });
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
		statuses,
		input(data: string) {
			return inputHandlers.at(-1)?.(data);
		},
		getEditorText: () => editorText,
		getInputHandlerCount: () => inputHandlers.length,
		setEditorText(text: string) {
			editorText = text;
		},
	};
}

function renderStatus(overrides: Partial<Parameters<typeof renderBottomInputStatus>[0]> = {}) {
	const harness = createCtx();
	const theme = createFakeTheme();
	const base = {
		ctx: harness.ctx,
		footerData: undefined,
		theme,
		width: 80,
		bottomStatusEnabled: true,
		isStreaming: false,
		liveUsage: null,
		latestAssistantUsage: null,
		currentThinkingLevel: null,
		sessionStartTime: 1000,
		now: 87_000,
		lastPrompt: "",
		icons: { model: "", time: "◷" },
	};
	return { harness, theme, rendered: renderBottomInputStatus({ ...base, ...overrides }) };
}

test("上方状态栏显示模型、thinking、上下文进度条和会话耗时", () => {
	const { rendered } = renderStatus();
	const rawLine = rendered.topLines.join("\n");
	const line = stripAnsi(rawLine);

	assert.match(line, /GPT-5\.5/);
	assert.match(line, /think:med/);
	assert.match(line, /ctx [━╸─]+ 69\.9%\/272k/);
	assert.match(rawLine, /\x1b\[38;2;0;175;175m69\.9%\/272k/);
	assert.match(line, /◷ 1m26s/);
	assert.doesNotMatch(line, /host|⊛|\d{2}:\d{2}/i);
});

test("thinking high/xhigh 使用原版 rainbow 逐字符配色", () => {
	const harness = createCtx();
	harness.ctx.getThinkingLevel = () => "xhigh";
	const { rendered } = renderStatus({ ctx: harness.ctx, now: 2000 });
	const rawLine = rendered.topLines.join("\n");

	assert.match(stripAnsi(rawLine), /think:xhigh/);
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
	const { rendered } = renderStatus({ ctx: harness.ctx, now: 2000 });
	const rawLine = rendered.topLines.join("\n");

	assert.match(stripAnsi(rawLine), /think:high/);
	assert.match(rawLine, /\x1b\[38;2;178;129;214mt/);
});

test("上下文找不到 window 时只显示已用量", () => {
	const harness = createCtx();
	harness.ctx.getContextUsage = () => ({ tokens: 37000 });
	harness.ctx.model = { name: "GPT-5.5" };
	const { rendered } = renderStatus({ ctx: harness.ctx, now: 2000 });
	const line = stripAnsi(rendered.topLines.join("\n"));

	assert.match(line, /ctx 37k/);
	assert.doesNotMatch(line, /[█░━╸─]|%|\/272k/);
});

test("缺失数据直接省略对应 segment", () => {
	const harness = createCtx();
	harness.ctx.model = undefined;
	harness.ctx.getThinkingLevel = () => "";
	harness.ctx.getContextUsage = undefined;
	harness.ctx.sessionManager = { getBranch: () => [] };
	const { rendered } = renderStatus({ ctx: harness.ctx, now: 500, sessionStartTime: 500 });
	const line = stripAnsi(rendered.topLines.join("\n"));

	assert.equal(line, "");
	assert.doesNotMatch(line, /unknown|no-model|think|ctx|NaN|undefined|◷/i);
});

test("下方 last prompt 显示上一个问题并压缩截断", () => {
	const { rendered } = renderStatus({ lastPrompt: "第一行 第二行 第三行很长很长很长", width: 24, now: 2000 });
	const line = stripAnsi(rendered.lastPromptLines.join("\n"));

	assert.match(line, /^ ↳ 第一行 第二行/);
	assert.match(line, /…$/);
	assert.doesNotMatch(line, /\n|\t/);
});

test("last prompt 缺失时下方状态行隐藏", () => {
	const { rendered } = renderStatus({ lastPrompt: "", now: 2000 });

	assert.deepEqual(rendered.lastPromptLines, []);
});

test("extension statuses 聚合过滤 notification、空值和内部 key", () => {
	const footerData = {
		getExtensionStatuses: () => new Map([
			["ok", "ready"],
			["notice", "[提示]"],
			["empty", "   "],
			["alps-pi-bottom-status", "internal"],
			["next", "sync"],
		]),
	};
	const { rendered } = renderStatus({ footerData });
	const line = stripAnsi(rendered.secondaryLines.join("\n"));

	assert.match(line, /ready/);
	assert.match(line, /sync/);
	assert.doesNotMatch(line, /提示|internal/);
});

test("streaming 时 live usage 不被旧 core context 覆盖", () => {
	const harness = createCtx();
	harness.ctx.getContextUsage = () => ({ tokens: 190000, contextWindow: 272000, percent: 69.9 });
	const { rendered } = renderStatus({
		ctx: harness.ctx,
		isStreaming: true,
		liveUsage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
		latestAssistantUsage: null,
	});
	const line = stripAnsi(rendered.topLines.join("\n"));

	assert.match(line, /0\.0%\/272k/);
	assert.doesNotMatch(line, /69\.9%\/272k/);
});

test("Alt+S 有输入时暂存并清空，空输入时恢复", () => {
	const harness = createCtx();
	const runtime = createBottomInputRuntime({ startClock: false });
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

test("copy/cut editor 等待异步剪贴板成功，失败时 cut 不清空输入", async () => {
	const harness = createCtx();
	const copied: string[] = [];
	const runtime = createBottomInputRuntime({
		startClock: false,
		copyToClipboard: async (text) => {
			copied.push(text);
		},
	});
	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	harness.setEditorText("copy me");

	runtime.copyEditorText?.();
	await flushMicrotasks();
	assert.deepEqual(copied, ["copy me"]);
	assert.equal(harness.getEditorText(), "copy me");
	assert.match(harness.notifications.at(-1)?.message ?? "", /Copied editor text/);

	runtime.cutEditorText?.();
	await flushMicrotasks();
	assert.deepEqual(copied, ["copy me", "copy me"]);
	assert.equal(harness.getEditorText(), "");
	assert.match(harness.notifications.at(-1)?.message ?? "", /Cut editor text/);

	const failingRuntime = createBottomInputRuntime({
		startClock: false,
		copyToClipboard: async () => {
			throw new Error("no clipboard");
		},
	});
	failingRuntime.bindSession(harness.ctx);
	failingRuntime.setEnabled(true);
	harness.setEditorText("keep me");
	failingRuntime.cutEditorText?.();
	await flushMicrotasks();
	assert.equal(harness.getEditorText(), "keep me");
	assert.match(harness.notifications.at(-1)?.message ?? "", /Cut failed/);
});

test("dispose 移除 input listener 并清理 stash 状态", () => {
	const harness = createCtx();
	const runtime = createBottomInputRuntime({ startClock: false });

	runtime.bindSession(harness.ctx);
	runtime.setEnabled(true);
	assert.equal(harness.getInputHandlerCount(), 1);
	runtime.dispose();

	assert.equal(harness.getInputHandlerCount(), 0);
	assert.deepEqual(harness.statuses.at(-1), { key: "alps-pi-stash", value: undefined });
});
