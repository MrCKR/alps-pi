/** 功能：验证各组件 wrapper 的 label、宽度与回退 实现者：alps 实现日期：2026-05-26 */

import assert from "node:assert/strict";
import test from "node:test";
import { createInitialPatchState, createWrappedRender, PATCH_KEY } from "../src/patch.ts";
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
	state.config.settings.assistantFrame = false;
	assert.deepEqual(wrapped.call(new AssistantComponent(), 30), ["hello"]);
	state.config.settings.assistantFrame = true;
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
