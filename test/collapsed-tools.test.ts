import assert from "node:assert/strict";
import test from "node:test";
import {
	addContextContributions,
	contextContributionTokens,
	estimateContextContribution,
} from "../src/features/chrome-frame/contribution.ts";
import {
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

function directionalMetrics(lines: string[]): { upstream: number; downstream: number } {
	const match = plain(lines).match(/\[ [^\d]*(\d+) · [^\d]*(\d+) \]/);
	assert.ok(match, `expected directional metrics in the top border:\n${plain(lines)}`);
	return { upstream: Number(match[1]), downstream: Number(match[2]) };
}

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
	assert.equal(grouped?.current?.detail, "working detail");
});

test("Collapsed 用稳定 Tool 身份聚合并只让首项锚点出框", () => {
	const renderers = createRenderers();
	const user = new DialogueComponent("question", { timestamp: 1_000 });
	const first = new CollapsibleTool("tool-1", "pwsh", { command: "npm test" });
	const second = new CollapsibleTool("tool-2", "search_context", { query: "collapsed tools" });

	renderers.user.call(user, 72);
	recordChromeFrameLifecycleEvent("tool_execution_start", { toolCallId: first.toolCallId }, undefined, 2_000);
	const initialLines = renderers.tool.call(first, 72);
	assert.match(plain(initialLines), /Tools[\s\S]*×1[\s\S]*TOOL pwsh : command=npm test/);
	const coloredInitial = initialLines.join("\n");
	assert.match(coloredInitial, /\x1b\[38;2;122;162;247m↑/);
	assert.match(coloredInitial, /\x1b\[38;2;255;139;57m·/);
	assert.match(coloredInitial, /\x1b\[38;2;115;218;202m↓/);
	assert.equal(initialLines.length, 4);
	assertLinesWithin(initialLines, 72);
	recordChromeFrameLifecycleEvent("tool_execution_start", { toolCallId: second.toolCallId }, undefined, 3_000);
	assert.deepEqual(renderers.tool.call(second, 72), []);

	const groupedLines = renderers.tool.call(first, 72);
	const grouped = plain(groupedLines);
	assert.equal(groupedLines.length, 4);
	assertLinesWithin(groupedLines, 72);
	assert.match(grouped, /Tools/);
	assert.match(grouped, /×2/);
	assert.match(grouped, /TOOL search_context : query=collapsed tools/);
	assert.doesNotMatch(grouped, /TOOL pwsh/);
	const expected = contextContributionTokens(
		addContextContributions(
			estimateContextContribution("tool", first),
			estimateContextContribution("tool", second),
		),
	);
	assert.deepEqual(directionalMetrics(groupedLines), expected);

	for (let index = 0; index < 3; index += 1) renderers.tool.call(second, 72);
	const rerendered = renderers.tool.call(first, 72);
	assert.match(plain(rerendered), /×2/);
	assert.deepEqual(directionalMetrics(rerendered), expected);
});

test("parallel Tool 按生命周期确定 current，并在无事件重渲染时保持稳定", () => {
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
	assert.match(grouped, /TOOL edit : path=src\/b\.ts/);

	renderers.tool.call(first, 72);
	grouped = plain(renderers.tool.call(second, 72));
	assert.match(grouped, /TOOL edit : path=src\/b\.ts/);

	recordChromeFrameLifecycleEvent("tool_execution_update", { toolCallId: first.toolCallId }, undefined, 3_000);
	(first.args as { path: string }).path = "src/a-updated.ts";
	renderers.tool.call(first, 72);
	grouped = plain(renderers.tool.call(second, 72));
	assert.match(grouped, /TOOL read : path=src\/a-updated\.ts/);

	recordChromeFrameLifecycleEvent("tool_execution_end", { toolCallId: first.toolCallId }, undefined, 5_000);
	first.isPartial = false;
	first.result = { isError: false, content: [{ type: "text", text: "done" }] };
	renderers.tool.call(first, 72);
	renderers.tool.call(second, 72);
	grouped = plain(renderers.tool.call(second, 72));
	assert.match(grouped, /TOOL read ✓ : path=src\/a-updated\.ts/);

	assert.match(plain(renderers.assistant.call(assistant, 72)), /ASSISTANT/);
	grouped = plain(renderers.tool.call(second, 72));
	assert.match(grouped, /TOOL read ✓ : path=src\/a-updated\.ts/);
});

test("Collapsed 更新当前操作与失败数，不把重建的同一 Tool 计为新项", () => {
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
	assert.match(grouped, /×2 · 1 failed/);
	assert.match(grouped, /TOOL edit ✗ : path=src\/b\.ts/);
	assert.equal(failedBorderToken, pendingBorderToken);
	const narrowLines = renderers.tool.call(first, 20);
	const narrowBody = plain(narrowLines.slice(1, -1));
	assert.equal(narrowLines.length, 4);
	assertLinesWithin(narrowLines, 20);
	assert.match(narrowBody, /TOOL edit ✗/);
	assert.doesNotMatch(narrowBody, /src\/b\.ts|[↑↓]/);

	const rebuiltSecond = new CollapsibleTool("tool-stable-2", "edit", { path: "src/b.ts" });
	rebuiltSecond.isPartial = false;
	rebuiltSecond.result = second.result;
	assert.deepEqual(renderers.tool.call(rebuiltSecond, 72), []);
	grouped = plain(renderers.tool.call(first, 72));
	assert.match(grouped, /×2 · 1 failed/);
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
	const frozenContribution = directionalMetrics(firstGroupLines);

	assert.match(plain(renderers.thinking.call(thinking, 72)), /THINK/);
	assert.match(plain(renderers.tool.call(third, 72)), /Tools[\s\S]*×1[\s\S]*TOOL read : path=src\/c\.ts/);
	assert.match(plain(renderers.assistant.call(assistant, 72)), /ASSISTANT/);
	assert.match(plain(renderers.tool.call(fourth, 72)), /Tools[\s\S]*×1[\s\S]*TOOL read : path=src\/d\.ts/);
	assert.match(plain(renderers.user.call(closingUser, 72)), /USER/);
	assert.match(plain(renderers.tool.call(fifth, 72)), /Tools[\s\S]*×1[\s\S]*TOOL read : path=src\/e\.ts/);
	const closedGroupLines = renderers.tool.call(first, 72);
	assert.match(plain(closedGroupLines), /×2/);
	assert.deepEqual(directionalMetrics(closedGroupLines), frozenContribution);
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
	assert.match(body, /TOOL edit : src\/a\.ts/);
	assert.doesNotMatch(body, /second line|third line/);

	state.config.settings.chromeFrame.compactEditTool = true;
	body = plain(wrapped.call(instance, 60));
	assert.match(body, /TOOL edit : src\/a\.ts/);
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
