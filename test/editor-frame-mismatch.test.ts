/** 功能：验证输入框线框内容行与实际输入文本的一致性检测 实现者：alps 实现日期：2026-11-10 */

import assert from "node:assert/strict";
import test from "node:test";
import { findFrameContentMismatch } from "../src/features/bottom-input/debug.ts";

const SGR = "\x1b[38;2;106;111;150m";
const RESET = "\x1b[39m";

function frame(top: string, content: string, bottom: string): string[] {
	return [top, content, bottom];
}

test("输入框为空且内容行也为空时不报告", () => {
	const lines = frame("╭ label ╮", `│${" ".repeat(20)}│`, "╰────╯");
	assert.equal(findFrameContentMismatch("", lines), undefined);
});

test("输入框为空但内容行画出了流式正文时报告", () => {
	const lines = frame("╭ label ╮", `│ This tests whether the${" ".repeat(6)}│`, "╰────╯");
	const mismatch = findFrameContentMismatch("", lines);
	assert.ok(mismatch);
	assert.match(mismatch!.innerText, /This tests whether the/);
	assert.equal(mismatch!.editorText, "");
});

test("忽略 SGR 后仍能取到内容行文本", () => {
	const lines = frame("╭ label ╮", `│${SGR}流式片段${RESET}${" ".repeat(8)}│`, "╰────╯");
	const mismatch = findFrameContentMismatch("", lines);
	assert.ok(mismatch);
	assert.equal(mismatch!.innerText, "流式片段");
});

test("有输入文本但内容行为空时报告", () => {
	const lines = frame("╭ label ╮", `│${" ".repeat(20)}│`, "╰────╯");
	const mismatch = findFrameContentMismatch("hello", lines);
	assert.ok(mismatch);
	assert.equal(mismatch!.innerText, "");
	assert.equal(mismatch!.editorText, "hello");
});

test("两侧都有文本时不报告，避免截断误报", () => {
	const lines = frame("╭ label ╮", `│ hello world${" ".repeat(9)}│`, "╰────╯");
	assert.equal(findFrameContentMismatch("hello world", lines), undefined);
});

test("多行输入按内容行合并比较", () => {
	const lines = frame("╭ label ╮", `│ line one${" ".repeat(12)}│`, `│ line two${" ".repeat(12)}│`);
	assert.equal(findFrameContentMismatch("line one\nline two", lines), undefined);
	assert.ok(findFrameContentMismatch("", lines));
});
