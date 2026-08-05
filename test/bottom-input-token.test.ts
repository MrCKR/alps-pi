import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderBeautifiedEditorFrame, renderBottomInputStatus, readSessionUsageTotals } from "../src/features/bottom-input/index.ts";
import { createFakeTheme, stripAnsi } from "./helpers.test.ts";

const assistant = (usage: any, stopReason?: string) => ({ type: "message", message: { role: "assistant", usage, stopReason } });
const compaction = (usage: any) => ({ type: "compaction", summary: "x", usage });

function createBranchCtx(branch: any[]) {
	const ctx: any = {
		hasUI: true,
		model: { name: "GPT-5.5", contextWindow: 272000 },
		sessionManager: { getBranch: () => branch },
		ui: {
			setEditorComponent() {},
			setFooter() {},
			notify() {},
			setStatus() {},
			onTerminalInput() {
				return () => {};
			},
			getEditorText: () => "",
			setEditorText() {},
		},
	};
	return ctx;
}

function renderStatus(overrides: Partial<Parameters<typeof renderBottomInputStatus>[0]> = {}) {
	const theme = createFakeTheme();
	const base = {
		ctx: createBranchCtx([]),
		footerData: undefined,
		theme,
		width: 80,
		beautifiedInputEnabled: true,
		isStreaming: false,
		liveUsage: null,
		latestAssistantUsage: null,
		currentThinkingLevel: null,
		sessionStartTime: 1000,
		now: 2000,
		lastPrompt: "",
		icons: { model: "", time: "◷" },
	};
	return { theme, rendered: renderBottomInputStatus({ ...base, ...overrides }) };
}

test("readSessionUsageTotals 累计全部 assistant 消息与 compaction", () => {
	const ctx = createBranchCtx([
		assistant({ input: 1000, output: 500, cacheRead: 200, cacheWrite: 50 }),
		compaction({ input: 300, output: 100, cacheRead: 0, cacheWrite: 0 }),
		assistant({ input: 2000, output: 1000, cacheRead: 400, cacheWrite: 100 }, "stop"),
	]);

	assert.deepEqual(readSessionUsageTotals(ctx), { input: 3300, output: 1600, cacheRead: 600, cacheWrite: 150 });
});

test("readSessionUsageTotals excludeLatest 跳过最后一条 assistant 消息", () => {
	const ctx = createBranchCtx([
		assistant({ input: 1000, output: 500, cacheRead: 200, cacheWrite: 50 }),
		compaction({ input: 300, output: 100, cacheRead: 0, cacheWrite: 0 }),
		assistant({ input: 2000, output: 1000, cacheRead: 400, cacheWrite: 100 }, "stop"),
	]);

	assert.deepEqual(readSessionUsageTotals(ctx, { excludeLatest: true }), { input: 1300, output: 600, cacheRead: 200, cacheWrite: 50 });
});

test("readSessionUsageTotals 跳过 error/aborted 消息", () => {
	const ctx = createBranchCtx([
		assistant({ input: 1234, output: 567, cacheRead: 200, cacheWrite: 0 }, "stop"),
		assistant({ input: 9999, output: 9999, cacheRead: 999, cacheWrite: 999 }, "error"),
		assistant({ input: 8888, output: 8888, cacheRead: 888, cacheWrite: 888 }, "aborted"),
	]);

	assert.deepEqual(readSessionUsageTotals(ctx), { input: 1234, output: 567, cacheRead: 200, cacheWrite: 0 });
});

test("readSessionUsageTotals 空会话返回全零", () => {
	const ctx = createBranchCtx([]);
	assert.deepEqual(readSessionUsageTotals(ctx), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(readSessionUsageTotals({}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("空闲时线框状态显示会话累计 token：↓输入 ↑输出 ⚡缓存命中", () => {
	const { rendered } = renderStatus({
		ctx: createBranchCtx([
			assistant({ input: 1000, output: 500, cacheRead: 200, cacheWrite: 50 }),
			compaction({ input: 300, output: 100, cacheRead: 0, cacheWrite: 0 }),
			assistant({ input: 2000, output: 1000, cacheRead: 400, cacheWrite: 100 }, "stop"),
		]),
	});
	const tokens = stripAnsi(rendered.frameStatus.tokens ?? "");

	assert.match(tokens, /↓3\.3k ↑1\.6k ⚡600/);
});

test("缓存命中为 0 时隐藏 ⚡ 段", () => {
	const { rendered } = renderStatus({
		ctx: createBranchCtx([assistant({ input: 1234, output: 567, cacheRead: 0, cacheWrite: 0 }, "stop")]),
	});
	const tokens = stripAnsi(rendered.frameStatus.tokens ?? "");

	assert.match(tokens, /↓1\.2k ↑567/);
	assert.doesNotMatch(tokens, /⚡/);
});

test("streaming 时历史累计叠加 liveUsage，且不双算最后一条", () => {
	const { rendered } = renderStatus({
		ctx: createBranchCtx([
			assistant({ input: 1000, output: 500, cacheRead: 200, cacheWrite: 50 }, "stop"),
			assistant({ input: 2000, output: 1000, cacheRead: 400, cacheWrite: 100 }, null),
		]),
		isStreaming: true,
		liveUsage: { input: 2500, output: 1200, cacheRead: 450, cacheWrite: 100 },
	});
	const tokens = stripAnsi(rendered.frameStatus.tokens ?? "");

	assert.match(tokens, /↓3\.5k ↑1\.7k ⚡650/);
});

test("无任何对话时 tokens 段为 null", () => {
	const { rendered } = renderStatus({ ctx: createBranchCtx([]) });

	assert.equal(rendered.frameStatus.tokens, null);
});

test("下边框左侧渲染累计 token、右侧渲染耗时", () => {
	const theme = createFakeTheme();
	const lines = renderBeautifiedEditorFrame({
		editorLines: ["> hello"],
		width: 60,
		theme,
		status: { model: "GPT-5.5", thinking: null, context: null, elapsed: "◷ 1m", tokens: "↓3.3k ↑1.6k ⚡600" },
	}).map(stripAnsi);

	assert.match(lines[0], /^╭ GPT-5\.5/);
	assert.match(lines[2], /^╰ ↓3\.3k ↑1\.6k ⚡600/);
	assert.match(lines[2], /◷ 1m/);
	assert.match(lines[2], /╯$/);
});

test("token 统计在线框窄宽裁剪下保持线框闭合", () => {
	const theme = createFakeTheme();
	const lines = renderBeautifiedEditorFrame({
		editorLines: ["> hello"],
		width: 16,
		theme,
		status: { model: "VeryLongModel", thinking: "xhigh", context: "━ 99%/272k", elapsed: "◷ 6m17s", tokens: "↓3.3k ↑1.6k ⚡600" },
	});
	const plain = lines.map(stripAnsi);

	assert.equal(plain[0]?.startsWith("╭"), true);
	assert.equal(plain[0]?.endsWith("╮"), true);
	assert.equal(plain.at(-1)?.startsWith("╰"), true);
	assert.equal(plain.at(-1)?.endsWith("╯"), true);
	assert.ok(lines.every((line) => visibleWidth(line) <= 16));
	assert.equal(plain.some((line) => /\x1b|\[31m|\[39m/.test(line)), false);
});
