import assert from "node:assert/strict";
import test from "node:test";
import {
	addContextContributions,
	contextContributionTokens,
	contextContributionTotalTokens,
	estimateContextContribution,
} from "../src/features/chrome-frame/contribution.ts";
import {
	configureCollapsedRenderRequest,
	getCollapsedRegistryStats,
	observeCollapsedFrame,
	resetCollapsedRegistry,
	synchronizeCollapsedMode,
} from "../src/features/chrome-frame/collapsed.ts";
import {
	createInitialPatchState,
	createWrappedRender,
	PATCH_KEY,
	recordChromeFrameLifecycleEvent,
} from "../src/features/chrome-frame/patch.ts";
import { assertLinesWithin, createFakeTheme, stripAnsi } from "./helpers.test.ts";

test.beforeEach(() => {
	configureCollapsedRenderRequest(undefined);
	(globalThis as any)[PATCH_KEY] = createInitialPatchState();
	(globalThis as any)[PATCH_KEY].config.settings.chromeFrame.toolCompactMode = "collapsed";
});

test("Collapsed aggregates mixed retained-context sources once per stable entry", () => {
	resetCollapsedRegistry();
	synchronizeCollapsedMode(true);
	const observe = (
		identity: string,
		kind: "tool" | "custom" | "compaction",
		upstreamChars: number,
		downstreamChars: number,
	) =>
		observeCollapsedFrame({
			instance: {},
			identity,
			kind,
			visible: true,
			contribution: { upstreamChars, downstreamChars },
			signature: `${identity}:${upstreamChars}:${downstreamChars}`,
		});

	observe("tool:1", "tool", 9, 5);
	observe("custom:1", "custom", 4, 0);
	let snapshot = observe("compaction:1", "compaction", 7, 0);
	assert.deepEqual(snapshot?.contribution, { upstreamChars: 20, downstreamChars: 5 });
	assert.deepEqual(snapshot && contextContributionTokens(snapshot.contribution), { upstream: 5, downstream: 2 });

	snapshot = observe("tool:1", "tool", 13, 5);
	assert.equal(snapshot?.count, 3);
	assert.deepEqual(snapshot?.contribution, { upstreamChars: 24, downstreamChars: 5 });
});

test("Thinking 贡献只计算完整原始 thinking block 且不受展示设置影响", () => {
	const raw = "**alpha**\n被两行摘要隐藏的中间内容\nomega";
	const instance = {
		lastMessage: {
			content: [
				{ type: "thinking", thinking: raw },
				{ type: "text", text: "assistant body must not enter the Thinking metric" },
			],
		},
	};
	const expected = { upstreamChars: 0, downstreamChars: raw.length };
	assert.deepEqual(estimateContextContribution("thinking", instance), expected);
	assert.deepEqual(estimateContextContribution("thinking", {
		message: { content: [{ type: "thinking", text: raw }] },
	}), expected);

	const state = (globalThis as any)[PATCH_KEY];
	for (const collapseThinking of [false, true]) {
		state.config.settings.chromeFrame.collapseThinking = collapseThinking;
		assert.deepEqual(estimateContextContribution("thinking", instance), expected);
	}
});

test("Thinking 流式替换、组件重建与历史恢复只保留最终原文贡献", () => {
	const boundary = { instance: {}, identity: "thinking-metric-user", kind: "user" as const, visible: true, signature: "user" };
	const identity = "thinking-metric-entry";
	const input = (instance: object & { lastMessage: { content: unknown[] } }) => ({
		instance,
		identity,
		kind: "thinking" as const,
		visible: true,
		contentLines: [(instance.lastMessage.content[0] as any).thinking],
		contribution: estimateContextContribution("thinking", instance),
		signature: JSON.stringify(instance.lastMessage.content),
	});
	const finalText = "first\nmiddle content hidden from the summary\nlast";

	resetCollapsedRegistry();
	synchronizeCollapsedMode(true);
	observeCollapsedFrame(boundary);
	const liveInstance = { lastMessage: { content: [{ type: "thinking", thinking: "first" }] } };
	observeCollapsedFrame(input(liveInstance));
	liveInstance.lastMessage.content = [{ type: "thinking", thinking: finalText }];
	let live = observeCollapsedFrame(input(liveInstance));
	assert.deepEqual(live?.contribution, { upstreamChars: 0, downstreamChars: finalText.length });
	const rebuilt = { lastMessage: { content: [{ type: "thinking", thinking: finalText }] } };
	live = observeCollapsedFrame(input(rebuilt));
	assert.deepEqual(live?.contribution, { upstreamChars: 0, downstreamChars: finalText.length });

	resetCollapsedRegistry();
	synchronizeCollapsedMode(true);
	observeCollapsedFrame({ ...boundary, instance: {} });
	const restored = observeCollapsedFrame(input(rebuilt));
	assert.deepEqual(restored?.contribution, live?.contribution);
});

class DialogueComponent {
	readonly text: string;
	readonly message: { timestamp: number; content?: unknown[] };

	constructor(text: string, message: { timestamp: number; content?: unknown[] }) {
		this.text = text;
		this.message = message;
	}

	render(_width: number) {
		return this.text ? [this.text] : [];
	}
}

class AssistantDialogueComponent {
	text: string;
	readonly lastMessage: {
		role: "assistant";
		timestamp: number;
		content: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string }>;
		usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	};

	constructor(
		text: string,
		timestamp: number,
		content: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string }>,
		usage?: { input: number; output: number; cacheRead: number; cacheWrite: number },
	) {
		this.text = text;
		this.lastMessage = { role: "assistant", timestamp, content, usage };
	}

	render(_width: number) {
		return this.text ? [this.text] : [];
	}
}

class CollapsibleTool {
	isPartial = true;
	result: any;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args: Record<string, unknown>;

	constructor(toolCallId: string, toolName: string, args: Record<string, unknown>) {
		this.toolCallId = toolCallId;
		this.toolName = toolName;
		this.args = args;
	}

	render(_width: number) {
		return [`${this.toolName} ${Object.entries(this.args).map(([key, value]) => `${key}=${String(value)}`).join(" ")}`];
	}
}

function createRenderers() {
	const theme = createFakeTheme();
	return {
		theme,
		user: createWrappedRender("CollapsedUser", "user", DialogueComponent.prototype.render, () => theme),
		assistant: createWrappedRender("CollapsedAssistant", "assistant", DialogueComponent.prototype.render, () => theme),
		thinking: createWrappedRender("CollapsedThinking", "thinking", DialogueComponent.prototype.render, () => theme),
		tool: createWrappedRender("CollapsedTool", "tool", CollapsibleTool.prototype.render, () => theme),
	};
}

function plain(lines: string[]): string {
	return lines.map(stripAnsi).join("\n");
}

function estimatedContextMetric(lines: string[]): number {
	const title = stripAnsi(lines[0] ?? "");
	const matches = [...title.matchAll(/\[ (\d+) \]/g)];
	assert.equal(matches.length, 1, `expected one estimated context metric in the top border:\n${plain(lines)}`);
	assert.doesNotMatch(title, /[↑↓]|\bin\b|\bout\b|·/i);
	return Number(matches[0]![1]);
}

test("Tools 贡献只汇总实际参数和已送模成功、错误、命令结果", () => {
	const read = new CollapsibleTool("metric-read", "read", { path: "package.json" });
	const grepError = new CollapsibleTool("metric-grep", "grep", { query: "missing" });
	const bash = new CollapsibleTool("metric-bash", "bash", { command: "npm test" });
	const pendingRead = estimateContextContribution("tool", read)!;
	assert.deepEqual(pendingRead, {
		upstreamChars: 0,
		downstreamChars: "read".length + JSON.stringify(read.args).length,
	});

	read.isPartial = false;
	read.result = {
		isError: false,
		content: [{ type: "text", text: "package contents" }],
		fullOutput: "not sent ".repeat(1_000),
		truncationResult: { truncated: true },
	};
	grepError.isPartial = false;
	grepError.result = { isError: true, content: [{ type: "text", text: "permission denied" }] };
	bash.isPartial = false;
	bash.result = { isError: false, content: [{ type: "text", text: "30 tests passed" }] };

	assert.deepEqual(estimateContextContribution("tool", read), {
		upstreamChars: "package contents".length,
		downstreamChars: "read".length + JSON.stringify(read.args).length,
	});
	assert.deepEqual(estimateContextContribution("tool", grepError), {
		upstreamChars: "permission denied".length,
		downstreamChars: "grep".length + JSON.stringify(grepError.args).length,
	});
	assert.deepEqual(estimateContextContribution("tool", bash), {
		upstreamChars: "30 tests passed".length,
		downstreamChars: "bash".length + JSON.stringify(bash.args).length,
	});
});

test("Tools 贡献随实际结果替换且不受摘要宽度、重复 render 或组件重建影响", () => {
	const renderers = createRenderers();
	const user = new DialogueComponent("question", { timestamp: 1_000 });
	const tool = new CollapsibleTool("metric-stream", "read", { path: "src/a.ts" });
	renderers.user.call(user, 96);
	let lines = renderers.tool.call(tool, 96);
	const pendingMetric = estimatedContextMetric(lines);
	assert.equal(pendingMetric, contextContributionTotalTokens(estimateContextContribution("tool", tool)!));

	tool.isPartial = false;
	tool.result = { isError: false, content: [{ type: "text", text: "short returned content" }] };
	(tool as any).fullOutput = "not returned ".repeat(1_000);
	renderers.tool.call(tool, 96);
	lines = renderers.tool.call(tool, 96);
	const completedMetric = contextContributionTotalTokens(estimateContextContribution("tool", tool)!);
	assert.equal(estimatedContextMetric(lines), completedMetric);
	assert.ok(completedMetric > pendingMetric);
	assert.equal(estimatedContextMetric(renderers.tool.call(tool, 40)), completedMetric);

	(tool.args as { path: string }).path = "src/renamed.ts";
	tool.result = { isError: false, content: [{ type: "text", text: "replacement" }] };
	renderers.tool.call(tool, 96);
	const replacedMetric = contextContributionTotalTokens(estimateContextContribution("tool", tool)!);
	assert.equal(estimatedContextMetric(renderers.tool.call(tool, 96)), replacedMetric);

	const rebuilt = new CollapsibleTool("metric-stream", "read", { path: "src/renamed.ts" });
	rebuilt.isPartial = false;
	rebuilt.result = tool.result;
	assert.equal(estimatedContextMetric(renderers.tool.call(rebuilt, 96)), replacedMetric);
	assert.equal(estimatedContextMetric(renderers.tool.call(tool, 96)), replacedMetric);
});

test("所有非对话 kind 连续聚合到单一首项锚框", () => {
	resetCollapsedRegistry();
	synchronizeCollapsedMode(true);
	const kinds = ["tool", "toolPending", "toolSuccess", "toolError", "bash", "skill", "custom", "compaction", "branch", "working"] as const;
	const instances = kinds.map(() => ({}));

	for (const [index, kind] of kinds.entries()) {
		const snapshot = observeCollapsedFrame({
			instance: instances[index],
			identity: `kind-${kind}`,
			kind,
			visible: true,
			detail: `${kind} detail`,
			signature: `${kind}-signature`,
		});
		assert.equal(snapshot?.isAnchor, index === 0);
	}

	const grouped = observeCollapsedFrame({
		instance: instances[0],
		identity: "kind-tool",
		kind: "tool",
		visible: true,
		detail: "tool detail",
		signature: "tool-signature",
	});
	assert.equal(grouped?.count, kinds.length);
	assert.deepEqual(grouped?.items?.map((item) => item.detail), kinds.map((kind) => `${kind} detail`));
});

test("Collapsed 用稳定 Tool 身份聚合并只让首项锚点出框", () => {
	const renderers = createRenderers();
	const user = new DialogueComponent("question", { timestamp: 1_000 });
	const first = new CollapsibleTool("tool-1", "pwsh", { command: "npm test" });
	const second = new CollapsibleTool("tool-2", "search_context", { query: "collapsed tools" });

	renderers.user.call(user, 72);
	recordChromeFrameLifecycleEvent("tool_execution_start", { toolCallId: first.toolCallId }, undefined, 2_000);
	const initialLines = renderers.tool.call(first, 72);
	assert.match(plain(initialLines), /Tools[\s\S]*×1[\s\S]*│ ● Pwsh command=npm test/);
	const coloredInitial = initialLines.join("\n");
	assert.match(coloredInitial, /\x1b\[38;2;122;162;247m\d+/);
	assert.doesNotMatch(plain(initialLines), /[↑↓]/);
	assert.equal(initialLines.length, 3);
	assertLinesWithin(initialLines, 72);
	recordChromeFrameLifecycleEvent("tool_execution_start", { toolCallId: second.toolCallId }, undefined, 3_000);
	assert.deepEqual(renderers.tool.call(second, 72), []);

	const groupedLines = renderers.tool.call(first, 72);
	const grouped = plain(groupedLines);
	assert.equal(groupedLines.length, 4);
	assertLinesWithin(groupedLines, 72);
	const groupedBodyLines = groupedLines.slice(1, -1).map(stripAnsi);
	assert.ok(groupedBodyLines.every((line) => /^│ ● /.test(line)));
	assert.ok(groupedBodyLines.every((line) => !/^│  ● /.test(line)));
	assert.match(grouped, /Tools/);
	assert.match(grouped, /×2/);
	assert.match(grouped, /│ ● Pwsh command=npm test[\s\S]*│ ● Search Context query=collapsed tools/);
	const expected = contextContributionTotalTokens(
		addContextContributions(
			estimateContextContribution("tool", first),
			estimateContextContribution("tool", second),
		),
	);
	assert.equal(estimatedContextMetric(groupedLines), expected);

	for (let index = 0; index < 3; index += 1) renderers.tool.call(second, 72);
	const rerendered = renderers.tool.call(first, 72);
	assert.match(plain(rerendered), /×2/);
	assert.equal(estimatedContextMetric(rerendered), expected);
});

test("parallel Tool 每次保留一行，并在更新和无事件重渲染时保持首次观察顺序", () => {
	const renderers = createRenderers();
	const user = new DialogueComponent("question", { timestamp: 1_000 });
	const first = new CollapsibleTool("tool-parallel-1", "read", { path: "src/a.ts" });
	const second = new CollapsibleTool("tool-parallel-2", "edit", { path: "src/b.ts" });
	const assistant = new DialogueComponent("answer", { timestamp: 6_000, content: [{ type: "text", text: "answer" }] });

	renderers.user.call(user, 72);
	recordChromeFrameLifecycleEvent("tool_execution_start", { toolCallId: first.toolCallId }, undefined, 3_000);
	recordChromeFrameLifecycleEvent("tool_execution_start", { toolCallId: second.toolCallId }, undefined, 3_000);
	renderers.tool.call(second, 72);
	assert.deepEqual(renderers.tool.call(first, 72), []);
	let grouped = plain(renderers.tool.call(second, 72));
	assert.match(grouped, /│ ● Edit path=src\/b\.ts[\s\S]*│ ● Read path=src\/a\.ts/);

	renderers.tool.call(first, 72);
	grouped = plain(renderers.tool.call(second, 72));
	assert.match(grouped, /│ ● Edit path=src\/b\.ts[\s\S]*│ ● Read path=src\/a\.ts/);

	recordChromeFrameLifecycleEvent("tool_execution_update", { toolCallId: first.toolCallId }, undefined, 3_000);
	(first.args as { path: string }).path = "src/a-updated.ts";
	renderers.tool.call(first, 72);
	grouped = plain(renderers.tool.call(second, 72));
	assert.match(grouped, /Read path=src\/a-updated\.ts/);

	recordChromeFrameLifecycleEvent("tool_execution_end", { toolCallId: first.toolCallId }, undefined, 5_000);
	first.isPartial = false;
	first.result = { isError: false, content: [{ type: "text", text: "done" }] };
	renderers.tool.call(first, 72);
	renderers.tool.call(second, 72);
	grouped = plain(renderers.tool.call(second, 72));
	assert.match(grouped, /Read path=src\/a-updated\.ts/);

	assert.match(plain(renderers.assistant.call(assistant, 72)), /ASSISTANT/);
	grouped = plain(renderers.tool.call(second, 72));
	assert.match(grouped, /Read path=src\/a-updated\.ts/);
});

test("Collapsed 更新对应调用的状态且不把重建的同一 Tool 计为新行", () => {
	const renderers = createRenderers();
	const user = new DialogueComponent("question", { timestamp: 1_000 });
	const first = new CollapsibleTool("tool-stable-1", "read", { path: "src/a.ts" });
	const second = new CollapsibleTool("tool-stable-2", "edit", { path: "src/b.ts" });

	renderers.user.call(user, 72);
	renderers.tool.call(first, 72);
	renderers.tool.call(second, 72);
	const pending = plain(renderers.tool.call(first, 72));
	const pendingBorderToken = renderers.theme.calls.filter((call) => call.kind === "fg" && call.text.includes("╭")).at(-1)?.token;
	assert.match(pending, /×2/);
	assert.doesNotMatch(pending, /failed/);
	second.isPartial = false;
	second.result = { isError: true, content: [{ type: "text", text: "failed" }] };
	renderers.tool.call(second, 72);

	let grouped = plain(renderers.tool.call(first, 72));
	const failedBorderToken = renderers.theme.calls.filter((call) => call.kind === "fg" && call.text.includes("╭")).at(-1)?.token;
	assert.match(grouped, /Tools ×2/);
	assert.match(grouped, /│ ● Read path=src\/a\.ts[\s\S]*│ ● Edit path=src\/b\.ts/);
	assert.ok(renderers.theme.calls.some((call) => call.kind === "fg" && call.text === "●" && call.token === "error"));
	assert.equal(failedBorderToken, pendingBorderToken);
	const narrowLines = renderers.tool.call(first, 20);
	const narrowBody = plain(narrowLines.slice(1, -1));
	assert.equal(narrowLines.length, 4);
	assertLinesWithin(narrowLines, 20);
	assert.match(narrowBody, /Edit path(?:=[^\n]*)?\.\.\./);
	assert.doesNotMatch(narrowBody, /src\/b\.ts|\+ctx/);

	const rebuiltSecond = new CollapsibleTool("tool-stable-2", "edit", { path: "src/b.ts" });
	rebuiltSecond.isPartial = false;
	rebuiltSecond.result = second.result;
	assert.deepEqual(renderers.tool.call(rebuiltSecond, 72), []);
	grouped = plain(renderers.tool.call(first, 72));
	assert.match(grouped, /Tools ×2/);
	assert.equal((grouped.match(/Edit path=src\/b\.ts/g) ?? []).length, 1);
});

test("可见 User、Assistant、Thinking 切组，空内容不切组", () => {
	const renderers = createRenderers();
	const user = new DialogueComponent("question", { timestamp: 1_000 });
	const first = new CollapsibleTool("tool-boundary-1", "read", { path: "src/a.ts" });
	const toolCallOnly = new DialogueComponent("", {
		timestamp: 3_000,
		content: [{ type: "toolCall", id: "tool-boundary-2", name: "write" }],
	});
	const emptyUser = new DialogueComponent("", { timestamp: 3_500 });
	const emptyThinking = new DialogueComponent("", { timestamp: 3_750 });
	const second = new CollapsibleTool("tool-boundary-2", "write", { path: "src/b.ts" });
	const thinking = new DialogueComponent("reasoning", { timestamp: 5_000, content: [{ type: "text", text: "reasoning" }] });
	const third = new CollapsibleTool("tool-boundary-3", "read", { path: "src/c.ts" });
	const assistant = new DialogueComponent("answer", { timestamp: 7_000, content: [{ type: "text", text: "answer" }] });
	const fourth = new CollapsibleTool("tool-boundary-4", "read", { path: "src/d.ts" });
	const closingUser = new DialogueComponent("next question", { timestamp: 9_000 });
	const fifth = new CollapsibleTool("tool-boundary-5", "read", { path: "src/e.ts" });

	renderers.user.call(user, 72);
	renderers.tool.call(first, 72);
	assert.equal(
		observeCollapsedFrame({ instance: {}, identity: "hidden-assistant", kind: "assistant", visible: false, signature: "hidden-assistant" }),
		undefined,
	);
	assert.deepEqual(renderers.assistant.call(toolCallOnly, 72), []);
	assert.deepEqual(renderers.user.call(emptyUser, 72), []);
	assert.deepEqual(renderers.thinking.call(emptyThinking, 72), []);
	assert.deepEqual(renderers.tool.call(second, 72), []);
	const firstGroupLines = renderers.tool.call(first, 72);
	assert.match(plain(firstGroupLines), /×2/);
	const frozenContribution = estimatedContextMetric(firstGroupLines);

	assert.match(plain(renderers.thinking.call(thinking, 72)), /Thinking/);
	assert.match(plain(renderers.tool.call(third, 72)), /Tools[\s\S]*×1[\s\S]*│ ● Read path=src\/c\.ts/);
	assert.match(plain(renderers.assistant.call(assistant, 72)), /ASSISTANT/);
	assert.match(plain(renderers.tool.call(fourth, 72)), /Tools[\s\S]*×1[\s\S]*│ ● Read path=src\/d\.ts/);
	assert.match(plain(renderers.user.call(closingUser, 72)), /USER/);
	assert.match(plain(renderers.tool.call(fifth, 72)), /Tools[\s\S]*×1[\s\S]*│ ● Read path=src\/e\.ts/);
	const closedGroupLines = renderers.tool.call(first, 72);
	assert.match(plain(closedGroupLines), /×2/);
	assert.equal(estimatedContextMetric(closedGroupLines), frozenContribution);
});

test("assistantFrame 开关不改变 Thinking 与正文的 Collapsed 分组边界", () => {
	for (const assistantFrame of [true, false]) {
		resetCollapsedRegistry();
		const state = (globalThis as any)[PATCH_KEY];
		state.config.settings.chromeFrame.toolCompactMode = "collapsed";
		state.config.settings.chromeFrame.assistantFrame = assistantFrame;
		const renderers = createRenderers();
		const user = new DialogueComponent("question", { timestamp: 1_000 });
		const firstThinking = new AssistantDialogueComponent("thinking one", 2_000, [
			{ type: "thinking", thinking: "thinking one" },
		]);
		const toolCallOnly = new AssistantDialogueComponent("", 3_500, [
			{ type: "toolCall", id: "tool-sequence-2", name: "read" },
		]);
		const emptyAssistant = new AssistantDialogueComponent("", 4_000, []);
		const emptyThinking = new AssistantDialogueComponent("", 4_500, [
			{ type: "thinking", thinking: "" },
		]);
		const secondThinking = new AssistantDialogueComponent("thinking two", 6_000, [
			{ type: "thinking", thinking: "thinking two" },
		]);
		const body = new AssistantDialogueComponent("answer", 9_000, [
			{ type: "text", text: "answer" },
		]);
		const tools = [
			new CollapsibleTool("tool-sequence-1", "read", { path: "src/a.ts" }),
			new CollapsibleTool("tool-sequence-2", "read", { path: "src/b.ts" }),
			new CollapsibleTool("tool-sequence-3", "read", { path: "src/c.ts" }),
			new CollapsibleTool("tool-sequence-4", "read", { path: "src/d.ts" }),
			new CollapsibleTool("tool-sequence-5", "read", { path: "src/e.ts" }),
		];
		const renderTimeline = () => [
			...renderers.user.call(user, 72),
			...renderers.assistant.call(firstThinking, 72),
			...renderers.tool.call(tools[0], 72),
			...renderers.assistant.call(toolCallOnly, 72),
			...renderers.tool.call(tools[1], 72),
			...renderers.assistant.call(emptyAssistant, 72),
			...renderers.assistant.call(emptyThinking, 72),
			...renderers.tool.call(tools[2], 72),
			...renderers.assistant.call(secondThinking, 72),
			...renderers.tool.call(tools[3], 72),
			...renderers.tool.call(tools[4], 72),
			...renderers.assistant.call(body, 72),
		];

		renderTimeline();
		const output = plain(renderTimeline());
		assert.match(output, /thinking one[\s\S]*Tools[\s\S]*×3[\s\S]*thinking two[\s\S]*Tools[\s\S]*×2[\s\S]*answer/);
		assert.doesNotMatch(output, /×5/);
	}
});

test("连续 Thinking 独立成组，摘要开关控制完整内容或稳定首尾两行", () => {
	for (const collapseThinking of [false, true]) {
		resetCollapsedRegistry();
		const state = (globalThis as any)[PATCH_KEY];
		state.config.settings.chromeFrame.assistantFrame = false;
		state.config.settings.chromeFrame.collapseThinking = collapseThinking;
		const renderers = createRenderers();
		const user = new DialogueComponent("question", { timestamp: 1_000 });
		const first = new AssistantDialogueComponent("first thought", 2_000, [
			{ type: "thinking", thinking: "first thought" },
		]);
		const second = new AssistantDialogueComponent("alpha\nmiddle\nomega", 3_000, [
			{ type: "thinking", thinking: "alpha\nmiddle\nomega" },
		]);
		const tool = new CollapsibleTool("thinking-group-tool", "read", { path: "src/a.ts" });
		const last = new AssistantDialogueComponent("final thought", 5_000, [
			{ type: "thinking", thinking: "final thought" },
		]);
		const body = new AssistantDialogueComponent("answer", 6_000, [{ type: "text", text: "answer" }]);

		renderers.user.call(user, 72);
		renderers.assistant.call(first, 72);
		assert.deepEqual(renderers.assistant.call(second, 72), []);
		renderers.tool.call(tool, 72);
		const firstGroup = renderers.assistant.call(first, 72);
		const firstPlain = plain(firstGroup);
		assert.match(firstPlain, /Thinking/);
		assert.equal((firstPlain.match(/Thinking/g) ?? []).length, 1);
		if (collapseThinking) {
			assert.equal(firstGroup.length, 4);
			assert.match(firstPlain, /first thought/);
			assert.match(firstPlain, /omega/);
			assert.doesNotMatch(firstPlain, /alpha|middle/);
		} else {
			assert.equal(firstGroup.length, 6);
			assert.match(firstPlain, /first thought[\s\S]*alpha[\s\S]*middle[\s\S]*omega/);
		}

		const lastGroup = renderers.assistant.call(last, 72);
		assert.equal(lastGroup.length, 3);
		assert.match(plain(lastGroup), /Thinking[\s\S]*final thought/);
		assert.match(plain(renderers.assistant.call(body, 72)), /answer/);
	}
});

test("Collapsed Thinking 摘要去除 Markdown、使用工具正文色并按宽度稳定省略", () => {
	resetCollapsedRegistry();
	const state = (globalThis as any)[PATCH_KEY];
	state.config.settings.chromeFrame.collapseThinking = true;
	const renderers = createRenderers();
	const user = new DialogueComponent("question", { timestamp: 1_000 });
	const first = new AssistantDialogueComponent(
		"fallback",
		2_000,
		[{ type: "thinking", thinking: "\x1b[1m**粗体** *斜体* _强调_ [链接](https://example.com) `代码` ~~删除~~ 第一段包含非常长的中文内容\x1b[0m" }],
	);
	const second = new AssistantDialogueComponent(
		"fallback",
		3_000,
		[{ type: "thinking", thinking: "# 中间内容\n> 最后一段也非常长用于验证流式摘要稳定更新" }],
	);

	renderers.user.call(user, 34);
	renderers.assistant.call(first, 34);
	assert.deepEqual(renderers.assistant.call(second, 34), []);
	const firstRender = renderers.assistant.call(first, 34);
	const secondRender = renderers.assistant.call(first, 34);
	const output = plain(firstRender);
	const body = plain(firstRender.slice(1, -1));
	assert.deepEqual(secondRender, firstRender);
	assert.equal(firstRender.length, 4);
	assertLinesWithin(firstRender, 34);
	assert.doesNotMatch(body, /[*_`]|~~|https?:|# 中间内容|\x1b\[1m/);
	assert.match(body, /粗体 斜体 强调 链接 代码(?: 删)?\.\.\./);
	assert.match(output, /最后一段也非常长用于验证(?:流)?\.\.\./);
	assert.equal((output.match(/\.\.\./g) ?? []).length, 2);
	assert.ok(renderers.theme.calls.some((call) =>
		call.kind === "fg" && call.token === "toolOutput" && call.text.includes("粗体")));
	assert.equal(renderers.theme.calls.filter((call) => call.kind === "bold").length, 0);
});

test("Collapsed Thinking 标题仅显示完整原文的单一估算贡献", () => {
	resetCollapsedRegistry();
	const renderers = createRenderers();
	const user = new DialogueComponent("question", { timestamp: 1_000 });
	const first = new AssistantDialogueComponent(
		"first thought",
		2_000,
		[{ type: "thinking", thinking: "first thought" }],
		{ input: 3, output: 4, cacheRead: 40, cacheWrite: 2 },
	);
	const second = new AssistantDialogueComponent(
		"second thought",
		3_000,
		[{ type: "thinking", thinking: "second thought" }],
		{ input: 7, output: 8, cacheRead: 50, cacheWrite: 1 },
	);

	renderers.user.call(user, 72);
	renderers.assistant.call(first, 72);
	assert.deepEqual(renderers.assistant.call(second, 72), []);
	assert.equal(estimatedContextMetric(renderers.assistant.call(first, 72)), 7);

	second.lastMessage.usage = { input: 10, output: 10, cacheRead: 60, cacheWrite: 2 };
	assert.deepEqual(renderers.assistant.call(second, 72), []);
	const liveLines = renderers.assistant.call(first, 72);
	const live = plain(liveLines);
	assert.equal(estimatedContextMetric(liveLines), 7);
	assert.doesNotMatch(live, /[↑↓]/);

	resetCollapsedRegistry();
	const restoredRenderers = createRenderers();
	const restoredFirst = new AssistantDialogueComponent(
		"first thought",
		2_000,
		[{ type: "thinking", thinking: "first thought" }],
		{ input: 3, output: 4, cacheRead: 40, cacheWrite: 2 },
	);
	const restoredSecond = new AssistantDialogueComponent(
		"second thought",
		3_000,
		[{ type: "thinking", thinking: "second thought" }],
		{ input: 10, output: 10, cacheRead: 60, cacheWrite: 2 },
	);
	restoredRenderers.user.call(new DialogueComponent("question", { timestamp: 1_000 }), 72);
	restoredRenderers.assistant.call(restoredFirst, 72);
	assert.deepEqual(restoredRenderers.assistant.call(restoredSecond, 72), []);
	assert.equal(estimatedContextMetric(restoredRenderers.assistant.call(restoredFirst, 72)), 7);
});

test("Thinking 与 Tools 交替时形成独立组，流式更新和历史恢复收敛", () => {
	const boundary = { instance: {}, identity: "thinking-restore-user", kind: "user" as const, visible: true, signature: "user" };
	const first = (instance: object, lines: string[]) => ({
		instance,
		identity: "thinking-restore-1",
		kind: "thinking" as const,
		visible: true,
		contentLines: lines,
		signature: lines.join("|"),
	});
	const second = (instance: object) => ({
		instance,
		identity: "thinking-restore-2",
		kind: "thinking" as const,
		visible: true,
		contentLines: ["tail"],
		signature: "tail",
	});
	const tool = { instance: {}, identity: "thinking-restore-tool", kind: "tool" as const, visible: true, signature: "tool" };

	resetCollapsedRegistry();
	synchronizeCollapsedMode(true);
	observeCollapsedFrame(boundary);
	const liveInstance = {};
	observeCollapsedFrame(first(liveInstance, ["draft"]));
	observeCollapsedFrame(first(liveInstance, ["first", "middle", "last"]));
	assert.equal(observeCollapsedFrame(second({}))?.isAnchor, false);
	assert.equal(observeCollapsedFrame(tool)?.kind, "tools");
	const live = observeCollapsedFrame(first(liveInstance, ["first", "middle", "last"]));
	assert.deepEqual(live?.contentLines, ["first", "middle", "last", "tail"]);

	resetCollapsedRegistry();
	synchronizeCollapsedMode(true);
	observeCollapsedFrame({ ...boundary, instance: {} });
	const restoredFirst = first({}, ["first", "middle", "last"]);
	observeCollapsedFrame(restoredFirst);
	observeCollapsedFrame(second({}));
	assert.equal(observeCollapsedFrame({ ...tool, instance: {} })?.kind, "tools");
	const restored = observeCollapsedFrame(restoredFirst);
	assert.deepEqual(restored?.contentLines, live?.contentLines);
	assert.equal(restored?.kind, "thinking");
});

test("assistantFrame 关闭时 ignored Assistant 转为可见 Thinking 后会重新切组", () => {
	const state = (globalThis as any)[PATCH_KEY];
	state.config.settings.chromeFrame.assistantFrame = false;
	const renderers = createRenderers();
	const user = new DialogueComponent("question", { timestamp: 1_000 });
	const first = new CollapsibleTool("tool-transition-1", "read", { path: "src/a.ts" });
	const second = new CollapsibleTool("tool-transition-2", "read", { path: "src/b.ts" });
	const evolving = new AssistantDialogueComponent("", 4_000, []);
	const third = new CollapsibleTool("tool-transition-3", "read", { path: "src/c.ts" });
	const fourth = new CollapsibleTool("tool-transition-4", "read", { path: "src/d.ts" });

	renderers.user.call(user, 72);
	renderers.tool.call(first, 72);
	renderers.tool.call(second, 72);
	renderers.assistant.call(evolving, 72);
	renderers.tool.call(third, 72);
	renderers.tool.call(fourth, 72);
	evolving.text = "late thinking";
	evolving.lastMessage.content = [{ type: "thinking", thinking: "late thinking" }];
	const thinkingLines = renderers.assistant.call(evolving, 72);
	assert.match(plain(thinkingLines), /Thinking[\s\S]*late thinking/);

	assert.match(plain(renderers.tool.call(first, 72)), /×2/);
	assert.match(plain(renderers.tool.call(third, 72)), /×2/);
});

test("ignored、boundary、member 的结构角色互转会正确重建既有分组", () => {
	type TestRole = "ignored" | "boundary" | "member";
	const evolvingInput = (role: TestRole, instance: object) => ({
		instance,
		identity: "role-evolving",
		kind: role === "member" ? "tool" as const : "assistant" as const,
		visible: role !== "ignored",
		detail: role === "member" ? "evolving tool" : undefined,
		signature: `role-${role}`,
	});
	const transitions: Array<{ from: TestRole; to: TestRole; counts: [number, number] }> = [
		{ from: "ignored", to: "boundary", counts: [1, 1] },
		{ from: "ignored", to: "member", counts: [3, 3] },
		{ from: "boundary", to: "ignored", counts: [2, 2] },
		{ from: "boundary", to: "member", counts: [3, 3] },
		{ from: "member", to: "ignored", counts: [2, 2] },
		{ from: "member", to: "boundary", counts: [1, 1] },
	];

	for (const transition of transitions) {
		resetCollapsedRegistry();
		synchronizeCollapsedMode(true);
		const first = {
			instance: {}, identity: "role-first", kind: "tool" as const, visible: true, detail: "first", signature: "role-first",
		};
		const last = {
			instance: {}, identity: "role-last", kind: "tool" as const, visible: true, detail: "last", signature: "role-last",
		};
		const evolving = {};
		observeCollapsedFrame(first);
		observeCollapsedFrame(evolvingInput(transition.from, evolving));
		observeCollapsedFrame(last);
		observeCollapsedFrame(evolvingInput(transition.to, evolving));

		assert.equal(observeCollapsedFrame(first)?.count, transition.counts[0], `${transition.from}->${transition.to} first`);
		assert.equal(observeCollapsedFrame(last)?.count, transition.counts[1], `${transition.from}->${transition.to} last`);
		assert.equal(getCollapsedRegistryStats().structuralRebuilds, 1);
	}
});

test("大连续工具组的常规追加和成员查询保持有界增长", () => {
	resetCollapsedRegistry();
	synchronizeCollapsedMode(true);
	const memberCount = 2_000;
	const boundary = {
		instance: {},
		identity: "linear-boundary",
		kind: "assistant" as const,
		visible: true,
		signature: "linear-boundary",
	};
	const members = Array.from({ length: memberCount }, (_, index) => ({
		instance: {},
		identity: `linear-tool-${index}`,
		kind: "tool" as const,
		visible: true,
		status: "success" as const,
		detail: `tool ${index}`,
		contribution: { upstreamChars: index, downstreamChars: 1 },
		signature: `linear-tool-${index}`,
		timing: { lastUpdatedAt: index + 1, active: false },
	}));

	observeCollapsedFrame(boundary);
	for (const member of members) observeCollapsedFrame(member);
	const afterAppend = getCollapsedRegistryStats();
	for (const member of members) observeCollapsedFrame(member);
	const stable = getCollapsedRegistryStats();
	const snapshot = observeCollapsedFrame(members[0]!);

	assert.equal(snapshot?.count, memberCount);
	assert.equal(afterAppend.structuralRebuilds, 0);
	assert.equal(afterAppend.rebuiltEntries, 0);
	assert.equal(afterAppend.heapPushes, memberCount);
	assert.equal(stable.heapPushes, afterAppend.heapPushes);
	assert.equal(stable.entryUpdates, 0);
	assert.equal(stable.snapshotReads, memberCount * 2);
});

test("2000 个不同类型与 Thinking 成员只在锚点按版本线性构建聚合快照", () => {
	for (const kind of ["tool", "thinking"] as const) {
		resetCollapsedRegistry();
		synchronizeCollapsedMode(true);
		const members = Array.from({ length: 2_000 }, (_, index) => ({
			instance: {},
			identity: `aggregate-linear-${kind}-${index}`,
			kind,
			visible: true,
			displayName: kind === "tool" ? `Type ${index}` : undefined,
			contentLines: kind === "thinking" ? [`thought ${index}`] : undefined,
			signature: `${kind}-${index}`,
		}));
		for (const member of members) observeCollapsedFrame(member);
		const beforeAnchor = getCollapsedRegistryStats();
		const snapshot = observeCollapsedFrame(members[0]!);
		const afterAnchor = getCollapsedRegistryStats();
		observeCollapsedFrame(members[0]!);
		const stable = getCollapsedRegistryStats();

		assert.equal(snapshot?.count, members.length);
		assert.ok(afterAnchor.aggregateItemsRead - beforeAnchor.aggregateItemsRead <= members.length);
		assert.equal(stable.aggregateItemsRead, afterAnchor.aggregateItemsRead);
		assert.equal(afterAnchor.structuralRebuilds, 0);
	}
});

test("首次 Collapsed 聚合只请求一次合并刷新并在完整快照后稳定", async () => {
	resetCollapsedRegistry();
	synchronizeCollapsedMode(true);
	let renderRequests = 0;
	configureCollapsedRenderRequest(() => {
		renderRequests += 1;
	});
	const boundary = {
		instance: {}, identity: "settle-boundary", kind: "assistant" as const, visible: true, signature: "settle-boundary",
	};
	const members = Array.from({ length: 20 }, (_, index) => ({
		instance: {},
		identity: `settle-tool-${index}`,
		kind: "tool" as const,
		visible: true,
		detail: `tool ${index}`,
		signature: `settle-tool-${index}`,
	}));

	observeCollapsedFrame(boundary);
	assert.equal(observeCollapsedFrame(members[0]!)?.count, 1);
	for (const member of members.slice(1)) observeCollapsedFrame(member);
	assert.equal(renderRequests, 0);
	await Promise.resolve();
	assert.equal(renderRequests, 1);

	let stableSnapshot;
	for (const member of members) stableSnapshot = observeCollapsedFrame(member);
	assert.equal(observeCollapsedFrame(members[0]!)?.count, members.length);
	assert.equal(stableSnapshot?.count, members.length);
	await Promise.resolve();
	assert.equal(renderRequests, 1);
	assert.equal(getCollapsedRegistryStats().renderRequests, 1);
});

test("流式更新、组件重建与历史重放收敛到同一聚合快照", () => {
	const boundary = (instance: object) => ({
		instance,
		identity: "restore-boundary",
		kind: "assistant" as const,
		visible: true,
		signature: "restore-boundary",
		timing: { lastUpdatedAt: 100, active: false },
	});
	const first = (instance: object, final: boolean) => ({
		instance,
		identity: "restore-tool-1",
		kind: "tool" as const,
		visible: true,
		status: final ? "error" as const : "pending" as const,
		detail: final ? "first failed" : "first running",
		contribution: final ? { upstreamChars: 40, downstreamChars: 4 } : { upstreamChars: 0, downstreamChars: 4 },
		signature: final ? "restore-tool-1:failed" : "restore-tool-1:pending",
		timing: { lastUpdatedAt: final ? 400 : 200, activityOrder: final ? 4 : 2, active: !final },
	});
	const second = (instance: object) => ({
		instance,
		identity: "restore-tool-2",
		kind: "tool" as const,
		visible: true,
		status: "success" as const,
		detail: "second done",
		contribution: { upstreamChars: 20, downstreamChars: 2 },
		signature: "restore-tool-2:done",
		timing: { lastUpdatedAt: 300, activityOrder: 3, active: false },
	});
	const comparable = (snapshot: ReturnType<typeof observeCollapsedFrame>) => snapshot && ({
		kind: snapshot.kind,
		count: snapshot.count,
		failedCount: snapshot.failedCount,
		active: snapshot.active,
		items: snapshot.items,
		contribution: snapshot.contribution,
		elapsedMs: snapshot.elapsedMs,
	});

	resetCollapsedRegistry();
	synchronizeCollapsedMode(true);
	observeCollapsedFrame(boundary({}));
	observeCollapsedFrame(first({}, false), 500);
	observeCollapsedFrame(second({}), 500);
	observeCollapsedFrame(first({}, true), 500);
	observeCollapsedFrame(second({}), 500);
	const live = comparable(observeCollapsedFrame(first({}, true), 500));
	const liveStats = getCollapsedRegistryStats();
	assert.equal(liveStats.appendedEntries, 3);
	assert.equal(liveStats.entryUpdates, 1);
	assert.deepEqual(live, {
		kind: "tools",
		count: 2,
		failedCount: 1,
		active: false,
		items: [
			{ kind: "tool", status: "error", name: "Tool", detail: "first failed" },
			{ kind: "tool", status: "success", name: "Tool", detail: "second done" },
		],
		contribution: { upstreamChars: 60, downstreamChars: 6 },
		elapsedMs: 300,
	});

	resetCollapsedRegistry();
	synchronizeCollapsedMode(true);
	observeCollapsedFrame(boundary({}));
	observeCollapsedFrame(first({}, true), 500);
	observeCollapsedFrame(second({}), 500);
	const restored = comparable(observeCollapsedFrame(first({}, true), 500));
	assert.deepEqual(restored, live);
});

test("Tools 按原始顺序逐调用显示，完成状态不会移除调用行", () => {
	const renderers = createRenderers();
	const user = new DialogueComponent("question", { timestamp: 1_000 });
	const readSuccess = new CollapsibleTool("aggregate-read-1", "functions.read", { path: "src/a.ts" });
	const skillSuccess = new CollapsibleTool("aggregate-skill", "skill", { name: "research" });
	const readFailure = new CollapsibleTool("aggregate-read-2", "READ", { path: "src/b.ts" });
	const grepPending = new CollapsibleTool("aggregate-grep", "grep", { query: "TODO" });
	for (const tool of [readSuccess, skillSuccess]) {
		tool.isPartial = false;
		tool.result = { isError: false, content: [{ type: "text", text: "done" }] };
	}
	readFailure.isPartial = false;
	readFailure.result = { isError: true, content: [{ type: "text", text: "failed" }] };

	renderers.user.call(user, 72);
	renderers.tool.call(readSuccess, 72);
	renderers.tool.call(skillSuccess, 72);
	renderers.tool.call(readFailure, 72);
	renderers.tool.call(grepPending, 72);
	let lines = renderers.tool.call(readSuccess, 72);
	let output = plain(lines);
	assert.match(output, /Tools ×4/);
	assert.match(output, /│ ● Read path=src\/a\.ts[\s\S]*│ ● Skill name=research[\s\S]*│ ● READ path=src\/b\.ts[\s\S]*│ ● Grep query=TODO/);
	assert.doesNotMatch(output, /[├└]/);
	assert.equal((output.match(/path=src\/[ab]\.ts/g) ?? []).length, 2);
	assert.deepEqual(
		new Set(renderers.theme.calls.filter((call) => call.kind === "fg" && call.text === "●").map((call) => call.token)),
		new Set(["accent", "error", "success"]),
	);

	grepPending.isPartial = false;
	grepPending.result = { isError: false, content: [{ type: "text", text: "done" }] };
	renderers.tool.call(grepPending, 72);
	lines = renderers.tool.call(readSuccess, 72);
	output = plain(lines);
	assert.match(output, /Tools ×4/);
	assert.match(output, /│ ● Grep query=TODO/);
	assert.equal(lines.length, 6);
});

test("Tools 不设行数上限并保留 Read、Grep、Bash、Edit 摘要与原序", () => {
	const renderers = createRenderers();
	const user = new DialogueComponent("question", { timestamp: 1_000 });
	const tools = [
		new CollapsibleTool("unbounded-read", "read", { path: "package.json" }),
		new CollapsibleTool("unbounded-grep", "grep", { query: "collapsed", path: "src/" }),
		new CollapsibleTool("unbounded-bash", "bash", { command: "npm test" }),
		new CollapsibleTool("unbounded-edit", "edit", { path: "src/features/chrome-frame/patch.ts" }),
		...Array.from({ length: 8 }, (_, index) =>
			new CollapsibleTool(`unbounded-extra-${index}`, "read", { path: `src/extra-${index}.ts` })),
	];

	renderers.user.call(user, 96);
	for (const tool of tools) renderers.tool.call(tool, 96);
	const lines = renderers.tool.call(tools[0], 96);
	const output = plain(lines);
	assert.equal(lines.length, tools.length + 2);
	assertLinesWithin(lines, 96);
	assert.match(output, /Tools ×12/);
	assert.match(output, /│ ● Read path=package\.json[\s\S]*│ ● Grep query=collapsed path=src\/[\s\S]*│ ● Bash command=npm test[\s\S]*│ ● Edit path=src\/features\/chrome-frame\/patch\.ts/);
	assert.doesNotMatch(output, /[├└]/);
	assert.match(output, /│ ● Read path=src\/extra-7\.ts/);
	for (const [index, tool] of tools.entries()) {
		const expected = index < 4 ? undefined : `src/extra-${index - 4}.ts`;
		if (expected) assert.equal((output.match(new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 1);
		assert.ok(tool.toolCallId);
	}
});

test("单一 Tool 调用行的 pending 状态点复用 User label token，完成和失败使用状态 token", () => {
	for (const status of ["pending", "success", "error"] as const) {
		resetCollapsedRegistry();
		const state = (globalThis as any)[PATCH_KEY];
		state.config.settings.chromeFrame.toolCompactMode = "collapsed";
		const theme = createFakeTheme();
		const wrapped = createWrappedRender(`Aggregate-status-${status}`, "tool", CollapsibleTool.prototype.render, () => theme);
		const tool = new CollapsibleTool(`aggregate-status-${status}`, "read", { path: "src/a.ts" });
		if (status !== "pending") {
			tool.isPartial = false;
			tool.result = { isError: status === "error", content: [{ type: "text", text: status }] };
		}
		const output = plain(wrapped.call(tool, 72));
		assert.match(output, /│ ● Read path=src\/a\.ts/);
		const expectedToken = status === "pending" ? "accent" : status;
		assert.ok(theme.calls.some((call) => call.kind === "fg" && call.text === "●" && call.token === expectedToken));
	}
});

test("Collapsed 仅为 pending 状态点增加 User label token，其他 frame token 与 Compact 一致", () => {
	const renderTokens = (mode: "compact" | "collapsed", status: "pending" | "success" | "error") => {
		resetCollapsedRegistry();
		const state = (globalThis as any)[PATCH_KEY];
		state.config.settings.chromeFrame.toolCompactMode = mode;
		const theme = createFakeTheme();
		const wrapped = createWrappedRender(`Token-${mode}-${status}`, "tool", CollapsibleTool.prototype.render, () => theme);
		const instance = new CollapsibleTool(`token-${mode}-${status}`, "read", { path: "src/a.ts" });
		if (status !== "pending") {
			instance.isPartial = false;
			instance.result = { isError: status === "error", content: [{ type: "text", text: status }] };
		}
		wrapped.call(instance, 72);
		return [...new Set(theme.calls
			.filter((call) => call.kind !== "bold")
			.map((call) => `${call.kind}:${call.token}`))].sort();
	};
	const expected = {
		pending: ["fg:borderAccent", "fg:toolOutput", "fg:toolTitle"],
		success: ["fg:success", "fg:toolOutput", "fg:toolTitle"],
		error: ["fg:error", "fg:toolOutput", "fg:toolTitle"],
	};

	for (const status of ["pending", "success", "error"] as const) {
		const compact = renderTokens("compact", status);
		const collapsed = renderTokens("collapsed", status);
		assert.deepEqual(compact, expected[status]);
		assert.deepEqual(
			collapsed,
			status === "pending" ? [...expected.pending, "fg:accent"].sort() : compact,
		);
	}
});

test("Collapsed 始终复用 Compact 摘要且不读取 Compact Edit", () => {
	class MultiLineEdit extends CollapsibleTool {
		render(_width: number) {
			return ["edit src/a.ts", "second line", "third line"];
		}
	}
	const state = (globalThis as any)[PATCH_KEY];
	state.config.settings.chromeFrame.compactEditTool = false;
	const theme = createFakeTheme();
	const wrapped = createWrappedRender("CollapsedEdit", "tool", MultiLineEdit.prototype.render, () => theme);
	const instance = new MultiLineEdit("tool-edit", "edit", { path: "src/a.ts" });

	let body = plain(wrapped.call(instance, 60));
	assert.match(body, /│ ● Edit src\/a\.ts/);
	assert.doesNotMatch(body, /second line|third line|[├└]/);

	state.config.settings.chromeFrame.compactEditTool = true;
	body = plain(wrapped.call(instance, 60));
	assert.match(body, /│ ● Edit src\/a\.ts/);
	assert.doesNotMatch(body, /second line|third line/);
});

test("Collapsed 组耗时从前一可见 frame 起算，并在边界出现后冻结", () => {
	const originalNow = Date.now;
	const renderers = createRenderers();
	const user = new DialogueComponent("question", { timestamp: 1_000 });
	const tool = new CollapsibleTool("tool-timing", "pwsh", { command: "npm test" });
	const assistant = new DialogueComponent("answer", { timestamp: 9_000, content: [{ type: "text", text: "answer" }] });
	try {
		Date.now = () => 1_000;
		renderers.user.call(user, 72);
		recordChromeFrameLifecycleEvent("tool_execution_start", { toolCallId: tool.toolCallId }, undefined, 3_000);
		recordChromeFrameLifecycleEvent("tool_execution_update", { toolCallId: tool.toolCallId }, undefined, 6_000);
		Date.now = () => 7_000;
		assert.match(plain(renderers.tool.call(tool, 72)), /6s ╯$/m);
		assert.ok(renderers.theme.calls.some((call) => call.kind === "fg" && call.token === "success" && call.text === "6s"));

		recordChromeFrameLifecycleEvent("tool_execution_end", { toolCallId: tool.toolCallId }, undefined, 8_000);
		tool.isPartial = false;
		tool.result = { isError: false, content: [{ type: "text", text: "ok" }] };
		Date.now = () => 9_000;
		renderers.tool.call(tool, 72);
		const boundaryLines = renderers.assistant.call(assistant, 72);
		assert.match(plain(boundaryLines), /1s ╯$/m);
		recordChromeFrameLifecycleEvent("tool_execution_update", { toolCallId: tool.toolCallId }, undefined, 15_000);
		Date.now = () => 20_000;
		assert.match(plain(renderers.tool.call(tool, 72)), /7s ╯$/m);
		assert.match(plain(renderers.assistant.call(assistant, 72)), /1s ╯$/m);
	} finally {
		Date.now = originalNow;
	}
});

test("Thinking、Tools、Assistant 按各 frame 最后更新时间连续计时", () => {
	const originalNow = Date.now;
	const renderers = createRenderers();
	const user = new DialogueComponent("question", { timestamp: 1_000 });
	const thinking = new AssistantDialogueComponent("reasoning", 2_000, [
		{ type: "thinking", thinking: "reasoning" },
	]);
	const tool = new CollapsibleTool("tool-frame-timing", "read", { path: "src/a.ts" });
	const assistant = new DialogueComponent("answer", { timestamp: 15_000, content: [{ type: "text", text: "answer" }] });
	try {
		Date.now = () => 1_000;
		renderers.user.call(user, 72);
		recordChromeFrameLifecycleEvent("message_update", { message: thinking.lastMessage }, undefined, 4_000);
		Date.now = () => 5_000;
		assert.match(plain(renderers.assistant.call(thinking, 72)), /4s ╯$/m);

		recordChromeFrameLifecycleEvent("message_end", { message: thinking.lastMessage }, undefined, 6_000);
		Date.now = () => 7_000;
		assert.match(plain(renderers.assistant.call(thinking, 72)), /5s ╯$/m);
		recordChromeFrameLifecycleEvent("tool_execution_start", { toolCallId: tool.toolCallId }, undefined, 8_000);
		Date.now = () => 10_000;
		assert.match(plain(renderers.tool.call(tool, 72)), /4s ╯$/m);

		recordChromeFrameLifecycleEvent("tool_execution_end", { toolCallId: tool.toolCallId }, undefined, 12_000);
		tool.isPartial = false;
		tool.result = { isError: false, timestamp: 12_000, content: [{ type: "text", text: "ok" }] };
		Date.now = () => 15_000;
		renderers.tool.call(tool, 72);
		assert.match(plain(renderers.assistant.call(assistant, 72)), /3s ╯$/m);
	} finally {
		Date.now = originalNow;
	}
});

test("Collapsed 后继 frame 从并行 Tools 全组最晚更新时间起算", () => {
	const originalNow = Date.now;
	const renderers = createRenderers();
	const user = new DialogueComponent("question", { timestamp: 1_000 });
	const slowFirst = new CollapsibleTool("tool-parallel-slow", "read", { path: "src/a.ts" });
	const fastLast = new CollapsibleTool("tool-parallel-fast", "grep", { query: "timing" });
	const assistant = new DialogueComponent("answer", { timestamp: 14_000, content: [{ type: "text", text: "answer" }] });
	try {
		Date.now = () => 1_000;
		renderers.user.call(user, 72);
		for (const [tool, start, end] of [[slowFirst, 2_000, 10_000], [fastLast, 3_000, 6_000]] as const) {
			recordChromeFrameLifecycleEvent("tool_execution_start", { toolCallId: tool.toolCallId }, undefined, start);
			recordChromeFrameLifecycleEvent("tool_execution_end", { toolCallId: tool.toolCallId }, undefined, end);
			tool.isPartial = false;
			tool.result = { isError: false, timestamp: end, content: [{ type: "text", text: "ok" }] };
			renderers.tool.call(tool, 72);
		}
		Date.now = () => 14_000;
		assert.match(plain(renderers.assistant.call(assistant, 72)), /4s ╯$/m);
	} finally {
		Date.now = originalNow;
	}
});

test("assistantFrame 关闭时正文只切组，不进入实际线框计时链", () => {
	const originalNow = Date.now;
	const state = (globalThis as any)[PATCH_KEY];
	state.config.settings.chromeFrame.assistantFrame = false;
	const renderers = createRenderers();
	const user = new DialogueComponent("question", { timestamp: 1_000 });
	const unframedAssistant = new DialogueComponent("plain answer", { timestamp: 4_000, content: [{ type: "text", text: "plain answer" }] });
	const tool = new CollapsibleTool("tool-after-unframed", "read", { path: "src/a.ts" });
	try {
		Date.now = () => 1_000;
		renderers.user.call(user, 72);
		assert.deepEqual(renderers.assistant.call(unframedAssistant, 72), ["plain answer"]);
		recordChromeFrameLifecycleEvent("tool_execution_end", { toolCallId: tool.toolCallId }, undefined, 9_000);
		tool.isPartial = false;
		tool.result = { isError: false, timestamp: 9_000, content: [{ type: "text", text: "ok" }] };
		Date.now = () => 10_000;
		assert.match(plain(renderers.tool.call(tool, 72)), /8s ╯$/m);
	} finally {
		Date.now = originalNow;
	}
});
