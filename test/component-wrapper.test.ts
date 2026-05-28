/** 功能：验证各组件 wrapper 的 label、宽度与回退 实现者：alps 实现日期：2026-05-26 */

import assert from "node:assert/strict";
import test from "node:test";
import { createInitialPatchState, createWrappedRender, disablePatch, formatElapsedDuration, PATCH_KEY } from "../src/features/chrome-frame/patch.ts";
import { createFakeTheme, assertLinesWithin, stripAnsi } from "./helpers.test.ts";

test.beforeEach(() => {
	(globalThis as any)[PATCH_KEY] = createInitialPatchState();
});

class FakeComponent {
	seenWidth = 0;
	render(width: number) {
		this.seenWidth = width;
		return ["hello"];
	}
}

function renderKind(kind: any, width = 32, extra: Record<string, unknown> = {}) {
	const original = FakeComponent.prototype.render;
	const theme = createFakeTheme();
	const wrapped = createWrappedRender("Fake", kind, original, () => theme, extra);
	const instance = Object.assign(new FakeComponent(), extra);
	return { lines: wrapped.call(instance, width), instance, theme };
}

for (const [kind, label] of [
	["user", "USER"],
	["assistant", "ASSISTANT"],
	["custom", "CUSTOM"],
	["skill", "SKILL"],
	["compaction", "COMPACT"],
	["branch", "BRANCH"],
	["bash", "BASH"],
	["working", "WORKING"],
] as const) {
	test(`${kind} kind 生成 ${label} label`, () => {
		const { lines } = renderKind(kind);
		assert.match(stripAnsi(lines[0]!), new RegExp(label));
		assertLinesWithin(lines, 32);
	});
}

test("tool pending / success / error kind 生成状态 label", () => {
	let result = renderKind("tool", 36, { toolName: "read", isPartial: true });
	assert.match(stripAnsi(result.lines[0]!), /TOOL read(?! ✓| ✗)/);
	result = renderKind("tool", 36, { toolName: "read", isPartial: false, result: { isError: false } });
	assert.match(stripAnsi(result.lines[0]!), /TOOL read ✓/);
	result = renderKind("tool", 36, { toolName: "read", isPartial: false, result: { isError: true } });
	assert.match(stripAnsi(result.lines[0]!), /TOOL read ✗/);
});


test("bash status 映射 pending/success/error 样式 token", () => {
	let result = renderKind("bash", 36, { status: "running" });
	assert.ok(result.theme.calls.some((call) => call.kind === "fg" && call.token === "borderAccent"));

	result = renderKind("bash", 36, { status: "complete" });
	assert.ok(result.theme.calls.some((call) => call.kind === "fg" && call.token === "success"));

	result = renderKind("bash", 36, { exitCode: 1 });
	assert.ok(result.theme.calls.some((call) => call.kind === "fg" && call.token === "error"));

	result = renderKind("bash", 36, { status: "cancelled" });
	assert.ok(result.theme.calls.some((call) => call.kind === "fg" && call.token === "error"));
});

test("wrapper 会把 inner width 减小，避免外框超宽", () => {
	const { lines, instance } = renderKind("assistant", 30);
	assert.equal(instance.seenWidth, 26);
	assertLinesWithin(lines, 30);
});

test("wrapper 对相同内容命中实例级缓存，避免重复 box 外框计算", () => {
	const original = FakeComponent.prototype.render;
	const theme = createFakeTheme();
	const wrapped = createWrappedRender("Fake", "assistant", original, () => theme);
	const instance = new FakeComponent();

	const first = wrapped.call(instance, 32);
	const callsAfterFirst = theme.calls.length;
	const second = wrapped.call(instance, 32);

	assert.equal(second, first);
	assert.equal(theme.calls.length, callsAfterFirst);
});

test("wrapper 缓存会随 width 变化失效", () => {
	const original = FakeComponent.prototype.render;
	const theme = createFakeTheme();
	const wrapped = createWrappedRender("Fake", "assistant", original, () => theme);
	const instance = new FakeComponent();

	const first = wrapped.call(instance, 32);
	const callsAfterFirst = theme.calls.length;
	const second = wrapped.call(instance, 40);

	assert.notEqual(second, first);
	assert.ok(theme.calls.length > callsAfterFirst);
});

test("线框间隔格式最小为 1s 且不保留小数", () => {
	assert.equal(formatElapsedDuration(0), "1s");
	assert.equal(formatElapsedDuration(1), "1s");
	assert.equal(formatElapsedDuration(999), "1s");
	assert.equal(formatElapsedDuration(1000), "1s");
	assert.equal(formatElapsedDuration(61_000), "1m01s");
	assert.equal(formatElapsedDuration(3_660_000), "1h01m");
});

test("第二个线框右下角显示相对上一条的秒级间隔", () => {
	const originalNow = Date.now;
	const original = FakeComponent.prototype.render;
	const theme = createFakeTheme();
	const wrapped = createWrappedRender("Fake", "assistant", original, () => theme);
	const first = new FakeComponent();
	const second = new FakeComponent();
	try {
		Date.now = () => 1_000;
		wrapped.call(first, 36);
		Date.now = () => 3_200;
		const lines = wrapped.call(second, 36);

		assert.match(stripAnsi(lines.at(-1)!), /3s ╯$/);
	} finally {
		Date.now = originalNow;
	}
});

test("设置样式变化不刷新线框更新时间", () => {
	const originalNow = Date.now;
	const original = FakeComponent.prototype.render;
	const theme = createFakeTheme();
	const wrapped = createWrappedRender("Fake", "assistant", original, () => theme);
	const first = new FakeComponent();
	const second = new FakeComponent();
	const state = (globalThis as any)[PATCH_KEY];
	try {
		Date.now = () => 1_000;
		wrapped.call(first, 36);
		Date.now = () => 2_000;
		wrapped.call(second, 36);
		Date.now = () => 10_000;
		state.config.settings.chromeFrame.toolCompactMode = !state.config.settings.chromeFrame.toolCompactMode;
		const lines = wrapped.call(second, 36);

		assert.match(stripAnsi(lines.at(-1)!), /1s ╯$/);
	} finally {
		Date.now = originalNow;
	}
});

test("重复渲染同一线框不刷新更新时间", () => {
	const originalNow = Date.now;
	const original = FakeComponent.prototype.render;
	const theme = createFakeTheme();
	const wrapped = createWrappedRender("Fake", "assistant", original, () => theme);
	const first = new FakeComponent();
	const second = new FakeComponent();
	try {
		Date.now = () => 1_000;
		wrapped.call(first, 36);
		Date.now = () => 2_000;
		wrapped.call(second, 36);
		Date.now = () => 10_000;
		const lines = wrapped.call(second, 36);

		assert.match(stripAnsi(lines.at(-1)!), /1s ╯$/);
	} finally {
		Date.now = originalNow;
	}
});

test("Tool 展开不刷新线框更新时间", () => {
	class ExpandableTool {
		toolName = "read";
		toolCallId = "tool-call-1";
		isPartial = false;
		result = { isError: false, content: [{ type: "text", text: "first line\nsecond line" }] };
		expanded = false;
		render(_width: number) {
			return this.expanded ? ["read src/a.ts", "first line", "second line"] : ["read src/a.ts"];
		}
	}
	const originalNow = Date.now;
	const theme = createFakeTheme();
	const wrapped = createWrappedRender("ToolFake", "tool", ExpandableTool.prototype.render, () => theme);
	const first = new FakeComponent();
	const tool = new ExpandableTool();
	try {
		Date.now = () => 1_000;
		createWrappedRender("Fake", "assistant", FakeComponent.prototype.render, () => theme).call(first, 36);
		Date.now = () => 2_000;
		wrapped.call(tool, 48);
		Date.now = () => 10_000;
		tool.expanded = true;
		const lines = wrapped.call(tool, 48);

		assert.match(stripAnsi(lines.at(-1)!), /1s ╯$/);
	} finally {
		Date.now = originalNow;
	}
});

test("disablePatch 后线框间隔 registry 会重置", () => {
	const originalNow = Date.now;
	const original = FakeComponent.prototype.render;
	const theme = createFakeTheme();
	const wrapped = createWrappedRender("Fake", "assistant", original, () => theme);
	try {
		Date.now = () => 1_000;
		wrapped.call(new FakeComponent(), 36);
		disablePatch([]);
		Date.now = () => 2_000;
		const lines = wrapped.call(new FakeComponent(), 36);

		assert.doesNotMatch(stripAnsi(lines.at(-1)!), /\d+s/);
	} finally {
		Date.now = originalNow;
	}
});

test("wrapper 缓存会随 configVersion 变化失效且不依赖 JSON.stringify", () => {
	const originalStringify = JSON.stringify;
	const original = FakeComponent.prototype.render;
	const theme = createFakeTheme();
	const wrapped = createWrappedRender("Fake", "custom", original, () => theme);
	const instance = new FakeComponent();
	const state = (globalThis as any)[PATCH_KEY];

	JSON.stringify = (() => {
		throw new Error("JSON.stringify should not be used in render cache key");
	}) as typeof JSON.stringify;
	try {
		const first = wrapped.call(instance, 32);
		const callsAfterFirst = theme.calls.length;
		state.config.settings.chromeFrame.assistantFrame = !state.config.settings.chromeFrame.assistantFrame;
		const second = wrapped.call(instance, 32);

		assert.equal(stripAnsi(second.join("\n")), stripAnsi(first.join("\n")));
		assert.ok(theme.calls.length > callsAfterFirst);
	} finally {
		JSON.stringify = originalStringify;
	}
});


class MultiLineComponent {
	toolName = "read";
	isPartial = false;
	result = { isError: false };
	expanded = false;
	seenWidth = 0;

	render(width: number) {
		this.seenWidth = width;
		return ["", "first line", "second line", "third line"];
	}
}

function renderToolInstance(instance: any, kind: any = "tool", width = 48) {
	const original = Object.getPrototypeOf(instance).render;
	const theme = createFakeTheme();
	const wrapped = createWrappedRender("ToolFake", kind, original, () => theme);
	return { lines: wrapped.call(instance, width), instance, theme };
}

function bodyText(lines: string[]): string {
	return stripAnsi(lines.slice(1, -1).join("\n"));
}

test("Tool 极简模式默认只显示第一条有效文本行", () => {
	const { lines } = renderToolInstance(new MultiLineComponent());
	const body = bodyText(lines);

	assert.match(stripAnsi(lines[0]!), /TOOL read ✓/);
	assert.match(body, /first line/);
	assert.doesNotMatch(body, /second line/);
	assert.doesNotMatch(body, /third line/);
});

test("Tool 极简模式不在内部额外添加 toolName 或状态", () => {
	const instance = Object.assign(new MultiLineComponent(), { toolName: "bash" });
	const { lines } = renderToolInstance(instance);
	const body = bodyText(lines);

	assert.match(stripAnsi(lines[0]!), /TOOL bash ✓/);
	assert.doesNotMatch(body, /bash/);
	assert.doesNotMatch(body, /✓|success/);
	assert.match(body, /first line/);
});

test("Tool 普通模式保持原始多行内容", () => {
	const state = (globalThis as any)[PATCH_KEY];
	state.config.settings.chromeFrame.toolCompactMode = false;
	const { lines } = renderToolInstance(new MultiLineComponent());
	const body = bodyText(lines);

	assert.match(body, /first line/);
	assert.match(body, /second line/);
	assert.match(body, /third line/);
});

test("Tool 展开后恢复原始完整内容", () => {
	const instance = new MultiLineComponent();
	const first = renderToolInstance(instance).lines;
	instance.expanded = true;
	const second = renderToolInstance(instance).lines;

	assert.doesNotMatch(bodyText(first), /second line/);
	assert.match(bodyText(second), /second line/);
	assert.match(bodyText(second), /third line/);
});

test("edit 默认不被 Tool 极简模式收起", () => {
	const instance = Object.assign(new MultiLineComponent(), { toolName: "edit" });
	const { lines } = renderToolInstance(instance);
	const body = bodyText(lines);

	assert.match(body, /first line/);
	assert.match(body, /second line/);
	assert.match(body, /third line/);
});

test("compactEditTool 开启后 edit 也按极简模式收起", () => {
	const state = (globalThis as any)[PATCH_KEY];
	state.config.settings.chromeFrame.compactEditTool = true;
	const instance = Object.assign(new MultiLineComponent(), { toolName: "edit" });
	const { lines } = renderToolInstance(instance);
	const body = bodyText(lines);

	assert.match(body, /first line/);
	assert.doesNotMatch(body, /second line/);
});

test("kind=bash 的用户 BashExecutionComponent 不受 Tool 极简模式影响", () => {
	class UserBashComponent {
		status = "complete";
		expanded = false;
		render(_width: number) {
			return ["$ npm test", "line two", "line three"];
		}
	}
	const { lines } = renderToolInstance(new UserBashComponent(), "bash");
	const body = bodyText(lines);

	assert.match(stripAnsi(lines[0]!), /BASH/);
	assert.match(body, /\$ npm test/);
	assert.match(body, /line two/);
	assert.match(body, /line three/);
});

test("toolName=bash 的 LLM tool 受 Tool 极简模式影响", () => {
	const instance = Object.assign(new MultiLineComponent(), { toolName: "bash" });
	const { lines } = renderToolInstance(instance, "tool");
	const body = bodyText(lines);

	assert.match(stripAnsi(lines[0]!), /TOOL bash ✓/);
	assert.match(body, /first line/);
	assert.doesNotMatch(body, /second line/);
});

test("toolName=bash 的 LLM tool 极简时优先显示命令关键行", () => {
	class BashTool {
		toolName = "bash";
		isPartial = false;
		result = { isError: false, content: [{ type: "text", text: "stdout line\nsecond stdout" }] };
		expanded = false;
		render(_width: number) {
			return ["", "$ npm test", "", "stdout line", "second stdout"];
		}
	}
	const { lines } = renderToolInstance(new BashTool(), "tool");
	const body = bodyText(lines);

	assert.match(stripAnsi(lines[0]!), /TOOL bash ✓/);
	assert.match(body, /\$ npm test/);
	assert.doesNotMatch(body, /stdout line/);
});

test("Tool 极简模式跳过 OSC、空行与图片行并保留 ANSI 文本", () => {
	const kitty = "\x1b_Gf=100,a=T;AAAA\x1b\\";
	class ComplexTool {
		toolName = "read";
		isPartial = false;
		result = { isError: false };
		render(_width: number) {
			return ["   ", "\x1b]133;A\x07", kitty, "\x1b[32mgreen first\x1b[39m", "second"];
		}
	}
	const { lines } = renderToolInstance(new ComplexTool());
	const joined = lines.join("\n");
	const body = bodyText(lines);

	assert.ok(joined.includes("\x1b[32mgreen first\x1b[39m"));
	assert.match(body, /green first/);
	assert.doesNotMatch(body, /second/);
	assert.equal(joined.includes(kitty), false);
});

test("Tool 极简模式原始内容只有图片时保留空 tool 外框", () => {
	const kitty = "\x1b_Gf=100,a=T;AAAA\x1b\\";
	class ImageOnlyTool {
		toolName = "image";
		isPartial = false;
		result = { isError: false };
		render(_width: number) {
			return [kitty];
		}
	}
	const { lines } = renderToolInstance(new ImageOnlyTool());
	const joined = lines.join("\n");

	assert.equal(lines.length, 3);
	assert.match(stripAnsi(lines[0]!), /TOOL image ✓/);
	assert.equal(joined.includes(kitty), false);
});

test("Tool 极简模式优先显示有参数的关键调用行", () => {
	class RendererTool {
		toolName = "grep";
		isPartial = false;
		result = { isError: false, content: [{ type: "text", text: "src/a.ts:1: foo\nsrc/b.ts:2: foo" }] };
		expanded = false;
		render(_width: number) {
			return ["grep /foo/ in src", "", "src/a.ts:1: foo", "src/b.ts:2: foo"];
		}
	}
	const { lines } = renderToolInstance(new RendererTool());
	const body = bodyText(lines);

	assert.match(stripAnsi(lines[0]!), /TOOL grep ✓/);
	assert.match(body, /grep \/foo\/ in src/);
	assert.doesNotMatch(body, /src\/a\.ts:1: foo/);
	assert.doesNotMatch(body, /src\/b\.ts:2: foo/);
});

test("Tool 极简模式对 read 优先显示文件路径调用行", () => {
	class ReadLikeTool {
		toolName = "read";
		isPartial = false;
		result = { isError: false, content: [{ type: "text", text: "actual file line\nsecond line" }] };
		expanded = false;
		render(_width: number) {
			return ["read src/settings.ts"];
		}
	}
	const { lines } = renderToolInstance(new ReadLikeTool());
	const body = bodyText(lines);

	assert.match(body, /read src\/settings\.ts/);
	assert.doesNotMatch(body, /actual file line/);
	assert.doesNotMatch(body, /second line/);
});

test("Tool 极简模式无文本结果时仍可显示有效关键调用行", () => {
	class EmptyResultTool {
		toolName = "write";
		isPartial = false;
		result = { isError: false, content: [] };
		expanded = false;
		render(_width: number) {
			return ["write src/new.ts"];
		}
	}
	const { lines } = renderToolInstance(new EmptyResultTool());
	const body = bodyText(lines);

	assert.equal(lines.length, 3);
	assert.match(stripAnsi(lines[0]!), /TOOL write ✓/);
	assert.match(body, /write src\/new\.ts/);
});

test("Tool 极简模式在调用行只有工具名时回退 result 首行", () => {
	class TodoLikeTool {
		toolName = "todo";
		isPartial = false;
		result = { isError: false, content: [{ type: "text", text: "[completed] #1 梳理项目结构\n[pending] #2 后续任务" }] };
		expanded = false;
		render(_width: number) {
			return ["todo =", "✓", "[completed] #1 梳理项目结构"];
		}
	}
	const { lines } = renderToolInstance(new TodoLikeTool());
	const body = bodyText(lines);

	assert.match(body, /\[completed\] #1 梳理项目结构/);
	assert.doesNotMatch(body, /todo =/);
	assert.doesNotMatch(body, /\[pending\] #2/);
});

test("Tool 极简模式在无标准 result.content 时跳过工具名与状态行", () => {
	class TodoLikeTool {
		toolName = "todo";
		isPartial = false;
		result = { isError: false };
		expanded = false;
		render(_width: number) {
			return ["todo =", "✓", "[completed] #1 梳理项目结构", "[pending] #2 后续任务"];
		}
	}
	const { lines } = renderToolInstance(new TodoLikeTool());
	const body = bodyText(lines);

	assert.match(body, /\[completed\] #1 梳理项目结构/);
	assert.doesNotMatch(body, /todo =/);
	assert.doesNotMatch(body, /^│\s*✓/);
	assert.doesNotMatch(body, /\[pending\] #2/);
});

test("Tool 极简模式把 todo ≡ 视为低价值工具名行", () => {
	class TodoLikeTool {
		toolName = "todo";
		isPartial = false;
		result = { isError: false };
		expanded = false;
		render(_width: number) {
			return ["todo ≡", "✓", "[completed] #1 梳理项目结构"];
		}
	}
	const { lines } = renderToolInstance(new TodoLikeTool());
	const body = bodyText(lines);

	assert.match(body, /\[completed\] #1 梳理项目结构/);
	assert.doesNotMatch(body, /todo ≡/);
});


test("Tool 极简模式保留 read skill 的 Pi 紧凑调用摘要", () => {
	class ReadSkillTool {
		toolName = "read";
		isPartial = false;
		result = { isError: false, content: [{ type: "text", text: "---\nname: actors\ndescription: demo" }] };
		expanded = false;
		render(_width: number) {
			return ["[skill] actors (Ctrl+O to expand)", "", "---", "name: actors"];
		}
	}
	const { lines } = renderToolInstance(new ReadSkillTool());
	const body = bodyText(lines);

	assert.match(body, /\[skill\] actors/);
	assert.doesNotMatch(body, /---/);
});


test("Tool 极简模式为 JSON 结果工具优先显示参数摘要", () => {
	class InspectTool {
		toolName = "inspect";
		args = { target: "tool:read", view: "schema", verbose: true };
		isPartial = false;
		result = { isError: false, content: [{ type: "text", text: "{\n  \"name\": \"read\"\n}" }] };
		expanded = false;
		render(_width: number) {
			return ["inspect", "", "{", "  \"name\": \"read\""];
		}
	}
	const { lines } = renderToolInstance(new InspectTool());
	const body = bodyText(lines);

	assert.match(body, /inspect target=tool:read view=schema/);
	assert.match(body, /verbose=true/);
	assert.doesNotMatch(body, /^\s*\{/m);
});


test("Tool 极简模式跳过 result 中的结构符号行", () => {
	class JsonResultTool {
		toolName = "custom";
		isPartial = false;
		result = { isError: false, content: [{ type: "text", text: "{\n  \"ok\": true\n}" }] };
		expanded = false;
		render(_width: number) {
			return ["custom", "", "{", "  \"ok\": true"];
		}
	}
	const { lines } = renderToolInstance(new JsonResultTool());
	const body = bodyText(lines);

	assert.match(body, /\"ok\": true/);
	assert.doesNotMatch(body, /^\s*\{/m);
});


test("Tool 极简缓存随 expanded 与设置变化失效", () => {
	const original = MultiLineComponent.prototype.render;
	const theme = createFakeTheme();
	const wrapped = createWrappedRender("ToolFake", "tool", original, () => theme);
	const instance = new MultiLineComponent();
	const state = (globalThis as any)[PATCH_KEY];

	const compact = wrapped.call(instance, 48);
	const callsAfterCompact = theme.calls.length;
	instance.expanded = true;
	const expanded = wrapped.call(instance, 48);
	const callsAfterExpanded = theme.calls.length;
	state.config.settings.chromeFrame.toolCompactMode = false;
	instance.expanded = false;
	const normal = wrapped.call(instance, 48);

	assert.doesNotMatch(bodyText(compact), /second line/);
	assert.match(bodyText(expanded), /second line/);
	assert.match(bodyText(normal), /second line/);
	assert.ok(callsAfterExpanded > callsAfterCompact);
	assert.ok(theme.calls.length > callsAfterExpanded);
});

test("普通消息 inner 返回空数组时不渲染 box", () => {
	class EmptyComponent {
		render(_width: number) {
			return [];
		}
	}
	const wrapped = createWrappedRender("Empty", "custom", EmptyComponent.prototype.render, () => createFakeTheme());
	assert.deepEqual(wrapped.call(new EmptyComponent(), 30), []);
});

test("工具 inner 返回空数组时仍有状态 box", () => {
	class EmptyToolComponent {
		toolName = "read";
		isPartial = false;
		result = { isError: false };
		render(_width: number) {
			return [];
		}
	}
	const wrapped = createWrappedRender("EmptyTool", "tool", EmptyToolComponent.prototype.render, () => createFakeTheme());
	const lines = wrapped.call(new EmptyToolComponent(), 30);
	assert.equal(lines.length, 3);
	assert.match(stripAnsi(lines[0]!), /TOOL read ✓/);
});

test("assistantFrame 关闭时 assistant 返回原始 render，开启时继续 box", () => {
	class AssistantComponent {
		render(_width: number) {
			return ["hello"];
		}
	}
	const wrapped = createWrappedRender("Assistant", "assistant", AssistantComponent.prototype.render, () => createFakeTheme());
	const state = (globalThis as any)[PATCH_KEY];
	state.config.settings.chromeFrame.assistantFrame = false;
	assert.deepEqual(wrapped.call(new AssistantComponent(), 30), ["hello"]);
	state.config.settings.chromeFrame.assistantFrame = true;
	assert.match(stripAnsi(wrapped.call(new AssistantComponent(), 30)[0]!), /ASSISTANT/);
});

test("inner render 抛异常时返回原始 render fallback", () => {
	let calls = 0;
	class ThrowOnce {
		render(_width: number) {
			calls += 1;
			if (calls === 1) throw new Error("boom");
			return ["fallback"];
		}
	}
	const wrapped = createWrappedRender("ThrowOnce", "user", ThrowOnce.prototype.render, () => createFakeTheme());
	assert.deepEqual(wrapped.call(new ThrowOnce(), 30), ["fallback"]);
});
