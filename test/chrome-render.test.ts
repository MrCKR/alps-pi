/** 功能：验证统一 box 渲染纯函数 实现者：alps 实现日期：2026-05-26 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderCompactThinkingBox, renderNeonBox } from "../src/features/chrome-frame/chrome.ts";
import { createFakeTheme, assertLinesWithin, stripAnsi } from "./helpers.test.ts";

test("renderNeonBox 输出完整三段 box 且包含 label 与内容", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("user", ["hello"], 32, theme);
	assert.ok(lines.length >= 3);
	assert.match(stripAnsi(lines[0]!), /USER/);
	assert.match(stripAnsi(lines[1]!), /hello/);
	assert.match(stripAnsi(lines.at(-1)!), /╰/);
	assertLinesWithin(lines, 32);
});

test("每一行可见宽度不超过 width，通常补齐到 width", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("assistant", ["one", "two"], 40, theme);
	assertLinesWithin(lines, 40);
	for (const line of lines) {
		assert.equal(visibleWidth(line), 40);
	}
});

test("多行内容每行都有左右边框", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("custom", ["a", "b", "c"], 28, theme);
	const plain = lines.map(stripAnsi);
	for (const contentLine of plain.slice(1, -1)) {
		assert.ok(contentLine.startsWith("│ "), contentLine);
		assert.ok(contentLine.endsWith(" │"), contentLine);
	}
});

test("普通 assistant frame 裁剪边界纯空白 content 行并保留中间空行", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("assistant", ["", "第一段", "", "第二段", ""], 28, theme).map(stripAnsi);
	const content = lines.slice(1, -1);

	assert.match(content[0]!, /第一段/);
	assert.match(content[1]!, /^│\s+│$/);
	assert.match(content[2]!, /第二段/);
	assert.equal(content.length, 3);
});

test("user 首个纯空白 content 行不被 assistant 逻辑删除", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("user", ["", "用户内容"], 28, theme).map(stripAnsi);
	const content = lines.slice(1, -1);

	assert.match(content[0]!, /^│\s+│$/);
	assert.match(content[1]!, /用户内容/);
});

test("长行会被换行或截断，不破坏边框", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("assistant", ["abcdefghijklmnopqrstuvwxyz0123456789"], 20, theme);
	assert.ok(lines.length > 3);
	assertLinesWithin(lines, 20);
	for (const contentLine of lines.slice(1, -1).map(stripAnsi)) {
		assert.ok(contentLine.startsWith("│ "));
		assert.ok(contentLine.endsWith(" │"));
	}
});

test("普通消息空内容不渲染 box", () => {
	const theme = createFakeTheme();
	assert.deepEqual(renderNeonBox("assistant", [], 24, theme), []);
	assert.deepEqual(renderNeonBox("branch", ["   "], 24, theme), []);
	assert.deepEqual(renderNeonBox("custom", ["\x1b]133;A\x07"], 24, theme), []);
});

test("工具类空内容仍保留状态 box", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("tool", [], 24, theme, { toolName: "read", status: "success" });
	assert.equal(lines.length, 3);
	assert.match(stripAnsi(lines[0]!), /TOOL read ✓/);
	assert.match(stripAnsi(lines[1]!), /^│\s+│$/);
	assertLinesWithin(lines, 24);
});

test("指定非 user kind 裁剪边界空白但保留中间空白", () => {
	const theme = createFakeTheme();
	for (const kind of ["thinking", "bash", "tool", "toolPending", "toolSuccess", "toolError", "custom", "skill", "compaction", "branch"] as const) {
		const lines = renderNeonBox(kind, ["", "alpha", "", "omega", ""], 34, theme, { toolName: "read", status: "success" }).map(stripAnsi);
		const content = lines.slice(1, -1);
		assert.match(content[0]!, /alpha/, kind);
		assert.match(content[1]!, /^│\s+│$/, kind);
		assert.match(content[2]!, /omega/, kind);
		assert.equal(content.length, 3, kind);
	}
});

test("ANSI/OSC/control-only 边界行按空白裁剪且不删除中间空行", () => {
	const theme = createFakeTheme();
	const controlOnly = "\x1b[31m \x1b[39m\x1b]9;ignored\x07";
	const lines = renderNeonBox("custom", [controlOnly, "visible", controlOnly, "tail", controlOnly], 34, theme).map(stripAnsi);
	const content = lines.slice(1, -1);

	assert.match(content[0]!, /visible/);
	assert.match(content[1]!, /^│\s+│$/);
	assert.match(content[2]!, /tail/);
	assert.equal(content.length, 3);
});

test("宽度过小时简化渲染且不抛异常", () => {
	const theme = createFakeTheme();
	for (const width of [0, 1, 2, 3, 4, 5]) {
		const lines = renderNeonBox("user", ["abcdef"], width, theme);
		assert.ok(Array.isArray(lines));
		assertLinesWithin(lines, Math.max(0, width));
	}
});



test("窄宽度 fallback 会净化危险 terminal escape", () => {
	const theme = createFakeTheme();
	const dangerous = "A]52;c;AAAAB[2JCPpayload\D[31mE";
	for (const width of [1, 5, 7]) {
		const neon = renderNeonBox("user", [dangerous], width, theme).join("");
		const compact = renderCompactThinkingBox([dangerous], width, theme).join("");
		for (const output of [neon, compact]) {
			assert.doesNotMatch(output, /\]52/);
			assert.doesNotMatch(output, /\[2J/);
			assert.doesNotMatch(output, /P/);
			assert.doesNotMatch(output, /payload/);
			assert.doesNotMatch(output, /\[(?![0-9;:]*m)/);
		}
	}
});

test("ANSI 彩色内容不参与宽度计算", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("assistant", ["\x1b[31mred text\x1b[39m and normal"], 26, theme);
	assertLinesWithin(lines, 26);
	assert.ok(lines.some((line) => line.includes("\x1b[31m")));
});

test("CJK 内容按宽字符处理且不超出边框", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("assistant", ["中文内容需要正确换行，不可以撑破边框"], 24, theme);
	assertLinesWithin(lines, 24);
	assert.ok(stripAnsi(lines.join("\n")).includes("中文"));
});

test("emoji / Nerd Font 内容不会导致抛异常", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("working", ["🚀  ✅ 字符混排"], 24, theme);
	assertLinesWithin(lines, 24);
	assert.ok(lines.length >= 3);
});

test("不渲染底板背景，只调用边框与标题 token", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("toolSuccess", ["ok"], 30, theme, { toolName: "read" });
	assert.equal(theme.calls.filter((call) => call.kind === "bg").length, 0);
	assert.ok(theme.calls.some((call) => call.kind === "fg" && call.token === "success"));
	assert.ok(theme.calls.some((call) => call.kind === "fg" && call.token === "toolTitle"));
	assert.match(stripAnsi(lines[0]!), /TOOL read ✓/);
});


test("bottom border 可在右下角显示消息间隔", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("assistant", ["ok"], 32, theme, { elapsedText: "1m05s" });
	const bottom = stripAnsi(lines.at(-1)!);

	assert.match(bottom, /1m05s ╯$/);
	assert.equal(visibleWidth(bottom), 32);
	assertLinesWithin(lines, 32);
});

test("bottom border 宽度不足时仍保持外框闭合", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("assistant", ["ok"], 8, theme, { elapsedText: "123456789s" });
	const bottom = stripAnsi(lines.at(-1)!);

	assert.ok(bottom.startsWith("╰"));
	assert.ok(bottom.endsWith("╯"));
	assert.equal(visibleWidth(bottom), 8);
});

test("top border label 后会重新应用 border token，避免嵌套 fg reset 丢色", () => {
	const theme = createFakeTheme();
	renderNeonBox("toolSuccess", ["ok"], 30, theme, { toolName: "read" });
	const fgCalls = theme.calls.filter((call) => call.kind === "fg");
	const successBeforeLabel = fgCalls.findIndex((call) => call.token === "success" && call.text === "╭─ ");
	const label = fgCalls.findIndex((call) => call.token === "toolTitle" && call.text.includes("TOOL read"));
	const successAfterLabel = fgCalls.findIndex((call) => call.token === "success" && call.text.startsWith(" ") && call.text.includes("╮"));
	assert.ok(successBeforeLabel >= 0, JSON.stringify(fgCalls));
	assert.ok(label > successBeforeLabel, JSON.stringify(fgCalls));
	assert.ok(successAfterLabel > label, JSON.stringify(fgCalls));
});
