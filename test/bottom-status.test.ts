/** 功能：验证 bottom-input 状态渲染与 Alt+S 暂存逻辑 实现者：alps 实现日期：2026-05-28 */

import assert from "node:assert/strict";
import { setImmediate as flushMicrotasks } from "node:timers/promises";
import test from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import {
	createBottomInputRuntime,
	renderBeautifiedEditorFrame,
	renderBottomInputEditorLines,
	renderBottomInputStatus,
	renderContextBar,
	splitNativeEditorRender,
} from "../src/features/bottom-input/index.ts";
import { sanitizeTerminalText } from "../src/terminal-sanitizer.ts";
import { isStashShortcutInput } from "../src/features/bottom-status/index.ts";
import { createFakeTheme, stripAnsi } from "./helpers.test.ts";

function createCtx(options: { footerData?: any } = {}) {
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	const inputHandlers: Array<(data: string) => { consume?: boolean; data?: string } | undefined> = [];
	let footerFactory: any;
	let editorFactory: any;
	let editorText = "";
	const ctx: any = {
		mode: "tui",
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
			getEditorComponent() {
				return editorFactory;
			},
			setEditorComponent(factory: any) {
				editorFactory = factory;
			},
			setFooter(factory: any) {
				footerFactory = factory;
			},
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
		instantiateEditor(tui: any = { mode: "regular", terminal: { columns: 40, rows: 12, write() {} }, requestRender() {}, hasOverlay: () => false }, theme: any = createFakeTheme()) {
			return editorFactory?.(tui, theme, { matches: () => false });
		},
		instantiateFooter(tui: any = { mode: "regular", terminal: { columns: 40, rows: 12, write() {} }, requestRender() {}, hasOverlay: () => false }, theme: any = createFakeTheme()) {
			return footerFactory?.(tui, theme, options.footerData ?? {});
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
		beautifiedInputEnabled: true,
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

test("线框状态显示模型、thinking、上下文进度条和会话耗时", () => {
	const { rendered } = renderStatus({ icons: { model: "󰚩", time: "◷" } });
	const frameText = stripAnsi(Object.values(rendered.frameStatus).filter(Boolean).join(" "));

	assert.deepEqual(rendered.topLines, []);
	assert.match(frameText, /GPT-5\.5/);
	assert.doesNotMatch(frameText, /󰚩/);
	assert.match(frameText, /med/);
	assert.doesNotMatch(frameText, /think:/);
	assert.match(frameText, /[━╸─]+ 69\.9%\/272k/);
	assert.doesNotMatch(frameText, /ctx|上下文|\[/);
	assert.match(rendered.frameStatus.context ?? "", /\x1b\[38;2;0;175;175m69\.9%\/272k/);
	assert.match(frameText, /◷ 1m26s/);
	assert.doesNotMatch(frameText, /host|⊛|\d{2}:\d{2}/i);
});

test("会话统计嵌入下边框右侧并使用最新缓存命中率", () => {
	const harness = createCtx();
	const entries = [
		{ type: "message", message: { role: "assistant", usage: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0 } } },
		{ type: "message", message: { role: "toolResult", usage: { input: 2000, output: 5, cacheRead: 0, cacheWrite: 0 } } },
		{ type: "compaction", usage: { input: 28000, output: 5, cacheRead: 0, cacheWrite: 0 } },
		{ type: "message", message: { role: "assistant", usage: { input: 7, output: 13, cacheRead: 993, cacheWrite: 0 } } },
	];
	harness.ctx.sessionManager.getEntries = () => entries;
	const footerData = { getExtensionStatuses: () => new Map([["codegraph", "CodeGraph synced"]]) };
	const { theme, rendered } = renderStatus({ ctx: harness.ctx, footerData, tokensPerSecond: 3.9 });
	const frame = renderBeautifiedEditorFrame({
		editorLines: ["> hello"],
		width: 80,
		theme,
		borderColor: (text) => `\x1b[31m${text}\x1b[39m`,
		status: rendered.frameStatus,
	});
	const bottom = frame.at(-1) ?? "";

	assert.equal(stripAnsi(rendered.secondaryLines[0] ?? ""), " CodeGraph synced ");
	assert.match(stripAnsi(bottom), /🚀3\.9 tok\/s · ↑31k ↓33 CH99\.3% · ◷ 1m26s/);
	assert.match(bottom, /\x1b\[31m · \x1b\[39m/);
	assert.equal(theme.calls.some((call) => call.token === "dimmed" && call.text === "🚀3.9 tok/s"), true);
	assert.equal(theme.calls.some((call) => call.token === "dimmed" && call.text === "↑31k ↓33 CH99.3%"), true);

	const previousCacheKey = rendered.cacheKey;
	entries.push({ type: "message", message: { role: "assistant", usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0 } } });
	const next = renderStatus({ ctx: harness.ctx, footerData, tokensPerSecond: 3.9 }).rendered;
	const nextBottom = renderBeautifiedEditorFrame({ editorLines: ["> hello"], width: 80, theme, status: next.frameStatus }).at(-1) ?? "";
	assert.notEqual(next.cacheKey, previousCacheKey);
	assert.match(stripAnsi(nextBottom), /🚀3\.9 tok\/s · ↑31k ↓34 CH0\.0% · ◷ 1m26s/);
});

test("下边框会话统计隐藏零值和无缓存活动的 CH", () => {
	const harness = createCtx();
	harness.ctx.sessionManager.getEntries = () => [
		{ type: "message", message: { role: "assistant", usage: { input: 999, output: 0, cacheRead: 0, cacheWrite: 0 } } },
	];
	const { theme, rendered } = renderStatus({ ctx: harness.ctx });
	const bottom = renderBeautifiedEditorFrame({ editorLines: ["> hello"], width: 40, theme, status: rendered.frameStatus }).at(-1) ?? "";
	const plain = stripAnsi(bottom);

	assert.deepEqual(rendered.secondaryLines, []);
	assert.match(plain, /↑999 · ◷ 1m26s/);
	assert.doesNotMatch(plain, /↓|CH/);
});

test("下边框会话统计在窄终端整项隐藏并优先保留耗时", () => {
	const harness = createCtx();
	harness.ctx.sessionManager.getEntries = () => [
		{ type: "message", message: { role: "assistant", usage: { input: 31000, output: 33, cacheRead: 31000, cacheWrite: 0 } } },
	];
	const { theme, rendered } = renderStatus({ ctx: harness.ctx });
	const medium = stripAnsi(renderBeautifiedEditorFrame({ editorLines: [">"], width: 25, theme, status: rendered.frameStatus }).at(-1) ?? "");
	const narrow = stripAnsi(renderBeautifiedEditorFrame({ editorLines: [">"], width: 15, theme, status: rendered.frameStatus }).at(-1) ?? "");

	assert.equal(medium, "╰─── ↑31k ↓33 · ◷ 1m26s ╯");
	assert.equal(narrow, "╰──── ◷ 1m26s ╯");
	assert.doesNotMatch(`${medium}\n${narrow}`, /CH|…/);
	assert.equal(visibleWidth(medium), 25);
	assert.equal(visibleWidth(narrow), 15);
});

test("会话统计先于 tok/s 隐藏且 tok/s 保持完整标签", () => {
	const harness = createCtx();
	harness.ctx.sessionManager.getEntries = () => [
		{ type: "message", message: { role: "assistant", usage: { input: 31000, output: 33, cacheRead: 31000, cacheWrite: 0 } } },
	];
	const { theme, rendered } = renderStatus({ ctx: harness.ctx, tokensPerSecond: 3.9 });
	const medium = stripAnsi(renderBeautifiedEditorFrame({ editorLines: [">"], width: 30, theme, status: rendered.frameStatus }).at(-1) ?? "");
	const narrow = stripAnsi(renderBeautifiedEditorFrame({ editorLines: [">"], width: 25, theme, status: rendered.frameStatus }).at(-1) ?? "");
	const tiny = stripAnsi(renderBeautifiedEditorFrame({ editorLines: [">"], width: 24, theme, status: rendered.frameStatus }).at(-1) ?? "");

	assert.equal(medium, "╰───── 🚀3.9 tok/s · ◷ 1m26s ╯");
	assert.equal(narrow, "╰ 🚀3.9 tok/s · ◷ 1m26s ╯");
	assert.equal(tiny, "╰───────────── ◷ 1m26s ╯");
	assert.doesNotMatch(`${medium}\n${narrow}\n${tiny}`, /…/);
	assert.equal(visibleWidth(medium), 30);
	assert.equal(visibleWidth(narrow), 25);
	assert.equal(visibleWidth(tiny), 24);
});

test("Alps 普通 thinking 标签颜色与输入边框 token 解耦", () => {
	const expectations = [
		{ level: "off", label: "off", ansi: "\x1b[38;2;255;255;255m" },
		{ level: "minimal", label: "min", ansi: "\x1b[38;2;106;111;150m" },
		{ level: "low", label: "low", ansi: "\x1b[38;2;103;150;230m" },
		{ level: "medium", label: "med", ansi: "\x1b[38;2;255;126;219m" },
	];

	for (const expectation of expectations) {
		const harness = createCtx();
		harness.ctx.getThinkingLevel = () => expectation.level;
		const theme = Object.assign(createFakeTheme(), { name: "alps" });
		const { rendered } = renderStatus({ ctx: harness.ctx, theme, now: 2000 });
		const rawThinking = rendered.frameStatus.thinking ?? "";

		assert.equal(stripAnsi(rawThinking), expectation.label);
		assert.equal(rawThinking.startsWith(expectation.ansi), true);
		assert.equal(theme.calls.some((call) => call.token.startsWith("thinking")), false);
	}
});

test("thinking high/xhigh 使用原版 rainbow 逐字符配色", () => {
	const harness = createCtx();
	harness.ctx.getThinkingLevel = () => "xhigh";
	const { rendered } = renderStatus({ ctx: harness.ctx, now: 2000 });
	const rawThinking = rendered.frameStatus.thinking ?? "";

	assert.match(stripAnsi(rawThinking), /xhigh/);
	assert.doesNotMatch(stripAnsi(rawThinking), /think:/);
	assert.match(rawThinking, /\x1b\[38;2;178;129;214mx/);
	assert.match(rawThinking, /\x1b\[38;2;215;135;175mh/);
	assert.doesNotMatch(rawThinking, /\x1b\[38;2;[0-9;]+m:/);
});

test("thinking max 使用独立高亮霓虹逐字符配色", () => {
	const harness = createCtx();
	harness.ctx.getThinkingLevel = () => "max";
	const { rendered } = renderStatus({ ctx: harness.ctx, now: 2000 });
	const rawThinking = rendered.frameStatus.thinking ?? "";

	assert.equal(stripAnsi(rawThinking), "max");
	assert.match(rawThinking, /\x1b\[38;2;240;110;207mm/);
	assert.match(rawThinking, /\x1b\[38;2;207;131;237ma/);
	assert.match(rawThinking, /\x1b\[38;2;169;147;255mx/);
	assert.match(rawThinking, /\x1b\[0m$/);
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
	const rawThinking = rendered.frameStatus.thinking ?? "";

	assert.match(stripAnsi(rawThinking), /high/);
	assert.doesNotMatch(stripAnsi(rawThinking), /think:/);
	assert.match(rawThinking, /\x1b\[38;2;178;129;214mh/);
});

test("上下文找不到 window 时只显示已用量", () => {
	const harness = createCtx();
	harness.ctx.getContextUsage = () => ({ tokens: 37000 });
	harness.ctx.model = { name: "GPT-5.5" };
	const { rendered } = renderStatus({ ctx: harness.ctx, now: 2000 });
	const line = stripAnsi(rendered.frameStatus.context ?? "");

	assert.match(line, /37k/);
	assert.doesNotMatch(line, /ctx|上下文|[█░━╸─]|%|\/272k/);
});

test("缺失数据直接省略对应 segment", () => {
	const harness = createCtx();
	harness.ctx.model = undefined;
	harness.ctx.getThinkingLevel = () => "";
	harness.ctx.getContextUsage = undefined;
	harness.ctx.sessionManager = { getBranch: () => [] };
	const { rendered } = renderStatus({ ctx: harness.ctx, now: 500, sessionStartTime: 500 });
	const line = stripAnsi(Object.values(rendered.frameStatus).filter(Boolean).join("\n"));

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

test("terminal sanitizer 剥离危险控制序列但保留 SGR", () => {
	const input = "ok\x1b]52;c;AAAA\x07\x1b[2J\x1b[31mred\x1b[0m\x1bPbad\x1b\\done";
	const output = sanitizeTerminalText(input, { preserveSgr: true });

	assert.equal(output, "ok\x1b[31mred\x1b[0mdone");
	assert.doesNotMatch(output, /\x1b\]52|\x1b\[2J|\x1bP/);
});

test("last prompt 和 extension statuses 会净化危险 terminal escape", () => {
	const footerData = {
		getExtensionStatuses: () => new Map([["evil", "ready\x1b]52;c;AAAA\x07\x1b[2Jdone"]]),
	};
	const { rendered } = renderStatus({
		footerData,
		lastPrompt: "hello\x1b[H\x1bPbad\x1b\\world",
		width: 80,
	});
	const output = `${rendered.secondaryLines.join("\n")}\n${rendered.lastPromptLines.join("\n")}`;

	assert.match(stripAnsi(output), /readydone/);
	assert.match(stripAnsi(output), /helloworld/);
	assert.doesNotMatch(output, /\x1b\]52|\x1b\[2J|\x1b\[H|\x1bP/);
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

test("streaming 时 live usage 不被 core context 覆盖", () => {
	const harness = createCtx();
	harness.ctx.getContextUsage = () => ({ tokens: 190000, contextWindow: 272000, percent: 69.9 });
	const { rendered } = renderStatus({
		ctx: harness.ctx,
		isStreaming: true,
		liveUsage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
		latestAssistantUsage: null,
	});
	const line = stripAnsi(rendered.frameStatus.context ?? "");

	assert.match(line, /0\.0%\/272k/);
	assert.doesNotMatch(line, /ctx/);
	assert.doesNotMatch(line, /69\.9%\/272k/);
});

test("美化输入框 ON 时单次状态渲染只读取一次 context usage", () => {
	const harness = createCtx();
	let readCount = 0;
	harness.ctx.getContextUsage = () => {
		readCount += 1;
		return { tokens: 190000, contextWindow: 272000, percent: 69.9 };
	};

	renderStatus({ ctx: harness.ctx, now: 2000 });

	assert.equal(readCount, 1);
});

test("状态渲染遇到 stale ctx getter 时 fail-soft", () => {
	const harness = createCtx();
	Object.defineProperty(harness.ctx, "model", {
		get() {
			throw new Error("stale ctx");
		},
	});
	Object.defineProperty(harness.ctx, "sessionManager", {
		get() {
			throw new Error("stale ctx");
		},
	});
	harness.ctx.getContextUsage = () => {
		throw new Error("stale ctx");
	};

	assert.doesNotThrow(() => renderStatus({ ctx: harness.ctx, liveUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, now: 2000 }));
	const { rendered } = renderStatus({ ctx: harness.ctx, liveUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, now: 2000 });
	const line = stripAnsi(Object.values(rendered.frameStatus).filter(Boolean).join("\n"));

	assert.doesNotMatch(line, /GPT-5\.5/);
	assert.match(line, /15/);
	assert.doesNotMatch(line, /ctx/);
});

test("runtime 按首个输出 delta 和最终 usage 计算平均 tok/s", () => {
	const harness = createCtx();
	let now = 0;
	const runtime = createBottomInputRuntime({ startClock: false, now: () => now });
	runtime.bindSession(harness.ctx);
	runtime.configure({ beautifiedInputEnabled: true });
	const tui = { mode: "regular", terminal: { columns: 80, rows: 20 }, requestRender() {}, hasOverlay: () => false };
	const editor = harness.instantiateEditor(tui, { borderColor: (text: string) => text, selectList: {} });

	runtime.setStreaming?.(true);
	now = 1_000;
	runtime.setLiveUsage({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, { type: "text_delta", delta: "a" });
	now = 6_000;
	runtime.setLiveUsage({ input: 1, output: 20, cacheRead: 0, cacheWrite: 0 }, { type: "thinking_delta", delta: "b" });
	now = 11_000;
	runtime.clearLiveUsage({ role: "assistant", stopReason: "stop", usage: { input: 1, output: 39, cacheRead: 0, cacheWrite: 0 } });
	assert.match(stripAnsi(editor.render(80).at(-1) ?? ""), /🚀3\.9 tok\/s/);

	runtime.setStreaming?.(true);
	now = 12_000;
	runtime.setLiveUsage({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, { type: "toolcall_delta", delta: "{" });
	now = 12_100;
	runtime.clearLiveUsage({ role: "assistant", stopReason: "stop", usage: { input: 1, output: 100, cacheRead: 0, cacheWrite: 0 } });
	assert.match(stripAnsi(editor.render(80).at(-1) ?? ""), /🚀3\.9 tok\/s/, "短响应不覆盖稳定值");

	runtime.setStreaming?.(true);
	now = 13_000;
	runtime.setLiveUsage({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, { type: "text_delta", delta: "c" });
	now = 23_000;
	runtime.clearLiveUsage({ role: "assistant", stopReason: "aborted", usage: { input: 1, output: 390, cacheRead: 0, cacheWrite: 0 } });
	assert.match(stripAnsi(editor.render(80).at(-1) ?? ""), /🚀3\.9 tok\/s/, "中止响应不覆盖稳定值");

	runtime.resetThroughput();
	assert.doesNotMatch(stripAnsi(editor.render(80).at(-1) ?? ""), /🚀|tok\/s/);
	runtime.dispose();
});

test("Alt+S 有输入时暂存并清空，空输入时恢复", () => {
	const harness = createCtx();
	const runtime = createBottomInputRuntime({ startClock: false });
	runtime.bindSession(harness.ctx);
	runtime.configure({ beautifiedInputEnabled: true });
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
	runtime.configure({ beautifiedInputEnabled: true });
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
	failingRuntime.configure({ beautifiedInputEnabled: true });
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
	runtime.configure({ beautifiedInputEnabled: true });
	assert.equal(harness.getInputHandlerCount(), 1);
	runtime.dispose();

	assert.equal(harness.getInputHandlerCount(), 0);
	assert.deepEqual(harness.statuses.at(-1), { key: "alps-pi-stash", value: undefined });
});

test("context bar 总宽度为 10", () => {
	assert.equal(visibleWidth(renderContextBar(59.5)), 10);
	assert.equal(stripAnsi(renderContextBar(59.5)).length, 10);
});



test("splitNativeEditorRender 剥离原生上下线并保留 popup", () => {
	const split = splitNativeEditorRender([
		"────────────────────",
		"> hello",
		"────────────────────",
		"/help  Show help",
	]);

	assert.deepEqual(split.editorLines, ["> hello"]);
	assert.deepEqual(split.popupLines, ["/help  Show help"]);
});

test("renderBottomInputEditorLines 美化普通 editor 且不保留原生上下线", () => {
	const lines = renderBottomInputEditorLines({
		lines: ["────────────────────", "> hello", "────────────────────", "/help  Show help"],
		width: 40,
		theme: createFakeTheme(),
		state: {
			beautifiedInputEnabled: true,
			getTheme: () => createFakeTheme(),
			getFrameStatus: () => ({ model: "GPT-5.5", thinking: "med", context: null, elapsed: "◷ 1s" }),
		},
	}).map(stripAnsi);

	assert.match(lines[0], /^╭ GPT-5\.5 · med/);
	assert.match(lines[1], /^│ > hello\s+│$/);
	assert.match(lines[2], /^╰.*◷ 1s .*╯$/);
	assert.equal(lines[3]?.trim(), "/help  Show help");
	assert.equal(lines.filter((line) => line === "────────────────────").length, 0);
});

test("美化输入框外框在原生着色异常时回退到主题边框色", () => {
	const theme = createFakeTheme();
	const lines = renderBeautifiedEditorFrame({
		editorLines: ["> hello"],
		width: 24,
		theme,
		borderColor: () => {
			throw new Error("broken editor border color");
		},
		status: { model: null, thinking: null, context: null, elapsed: null },
	});

	assert.match(lines[0], /\x1b\[38;5;11m╭/);
	assert.match(lines[1], /\x1b\[38;5;11m│/);
	assert.match(lines[2], /\x1b\[38;5;11m╰/);
	assert.ok(theme.calls.some((call) => call.kind === "fg" && call.token === "borderMuted"));
	assert.equal(theme.calls.some((call) => call.kind === "fg" && call.token === "mdCode"), false);
	assert.ok(lines.every((line) => visibleWidth(line) <= 24));
});



test("美化 editor 复用原生 editor 的动态边框颜色", () => {
	const footerData = { getExtensionStatuses: () => new Map() };
	const harness = createCtx({ footerData });
	const editorTheme = {
		borderColor: (text: string) => `\x1b[31m${text}\x1b[39m`,
		selectList: {},
	};
	const footerTheme = createFakeTheme();
	const runtime = createBottomInputRuntime({ startClock: false });

	runtime.bindSession(harness.ctx);
	runtime.setBeautifiedInputEnabled?.(true);
	const tui = { mode: "regular", terminal: { columns: 40, rows: 12, write() {} }, requestRender() {}, hasOverlay: () => false };
	const editor = harness.instantiateEditor(tui, editorTheme);
	harness.instantiateFooter(tui, footerTheme);
	const lines = editor.render(24);

	assert.match(lines[0], /\x1b\[31m╭/);
	assert.equal(footerTheme.calls.some((call) => call.kind === "fg" && call.token === "mdCode"), false);

	editor.borderColor = (text: string) => `\x1b[32m${text}\x1b[39m`;
	const updatedLines = editor.render(24);
	assert.match(updatedLines[0], /\x1b\[32m╭/);
});

test("线框边框裁剪 ANSI 状态时保持闭合且不泄漏转义文本", () => {
	const lines = renderBeautifiedEditorFrame({
		editorLines: ["> hello"],
		width: 24,
		theme: createFakeTheme(),
		status: {
			model: "\x1b[31mVeryLongModelNameThatMustClip\x1b[39m",
			thinking: "\x1b[32mxhigh\x1b[39m",
			context: "\x1b[36m━━━━━╸──── 59.5%/272k\x1b[39m",
			elapsed: "\x1b[2m◷ 6m17s\x1b[22m",
		},
	});
	const plain = lines.map(stripAnsi);

	assert.equal(plain[0]?.startsWith("╭"), true);
	assert.equal(plain[0]?.endsWith("╮"), true);
	assert.equal(plain.at(-1)?.startsWith("╰"), true);
	assert.equal(plain.at(-1)?.endsWith("╯"), true);
	assert.ok(lines.every((line) => visibleWidth(line) <= 24));
	assert.equal(plain.some((line) => /\x1b|\[31m|\[39m/.test(line)), false);
});

test("线框内容窄宽裁剪时保留 cursor marker", () => {
	const framed = renderBeautifiedEditorFrame({
		editorLines: [`0123456789${CURSOR_MARKER}abcdef`],
		width: 12,
		theme: createFakeTheme(),
		status: { model: null, thinking: null, context: null, elapsed: null },
	});

	assert.equal(framed[1].includes(CURSOR_MARKER), true);
	assert.ok(framed.every((line) => visibleWidth(line) <= 12));
});

test("线框内容裁剪不拆分 ANSI 与 emoji grapheme", () => {
	const marker = CURSOR_MARKER;
	const framed = renderBeautifiedEditorFrame({
		editorLines: [`👨‍👩‍👧‍👦abcdef\x1b[31m012345${marker}xyz\x1b[0m`],
		width: 14,
		theme: createFakeTheme(),
		status: { model: null, thinking: null, context: null, elapsed: null },
	});

	assert.equal(framed[1].includes(marker), true);
	assert.ok(visibleWidth(framed[1]) <= 14);
	assert.doesNotMatch(framed[1], /\x1b\[[^m]*$/);
});

test("线框内容裁剪会重置未闭合 SGR，避免输入颜色污染右边框", () => {
	const marker = CURSOR_MARKER;
	const framed = renderBeautifiedEditorFrame({
		editorLines: [`\x1b[31m0123456789${marker}abcdef\x1b[0m`],
		width: 12,
		theme: createFakeTheme(),
		status: { model: null, thinking: null, context: null, elapsed: null },
	});

	assert.match(framed[1], /\x1b\[31m[\s\S]*\x1b\[0m[\s\S]*\x1b\[38;5;11m│/);
	assert.ok(visibleWidth(framed[1]) <= 12);
});

test("美化输入框通过公开 editor/footer API 渲染状态与 last prompt", () => {
	const footerData = {
		getExtensionStatuses: () => new Map([["watcher", "CodeGraph watcher active"], ["stash", "stash"]]),
		onBranchChange: () => () => undefined,
	};
	const harness = createCtx({ footerData });
	const runtime = createBottomInputRuntime({
		startClock: false,
		now: (() => {
			let calls = 0;
			return () => calls++ < 2 ? 1_000 : 378_000;
		})(),
	});
	runtime.bindSession(harness.ctx);
	runtime.setLastPrompt("上一个问题");
	const status = runtime.configure({ beautifiedInputEnabled: true });
	const tui = { mode: "fullscreen", terminal: { columns: 80, rows: 20 }, requestRender() {}, hasOverlay: () => false };
	const editor = harness.instantiateEditor(tui, { borderColor: (text: string) => text, selectList: {} });
	const footer = harness.instantiateFooter(tui, createFakeTheme());
	editor.setText("hello");
	const editorLines = editor.render(80).map(stripAnsi);
	const footerLines = footer.render(80).map(stripAnsi);

	assert.equal(status.installed, true);
	assert.match(editorLines[0], /^╭/);
	assert.match(editorLines.at(-1) ?? "", /^╰/);
	assert.match(footerLines[0], /CodeGraph watcher active.*stash/);
	assert.match(footerLines[1], /↳ 上一个问题/);
});

test("美化输入框 OFF 时不安装自定义 editor/footer 且不读取 context usage", () => {
	const harness = createCtx();
	harness.ctx.getContextUsage = () => {
		throw new Error("should not read context usage");
	};
	const runtime = createBottomInputRuntime({ startClock: false });
	runtime.bindSession(harness.ctx);
	const status = runtime.configure({ beautifiedInputEnabled: false });

	assert.equal(status.enabled, false);
	assert.equal(status.installed, false);
	assert.equal(harness.instantiateEditor(), undefined);
	assert.equal(harness.instantiateFooter(), undefined);
});
