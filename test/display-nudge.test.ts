/** 功能：验证显示层清理（nudge）只改行字符串、不改内容与宽度 实现者：alps 实现日期：2026-11-10 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderBeautifiedEditorFrame } from "../src/features/bottom-input/frame.ts";
import { createFakeTheme } from "./helpers.test.ts";

const status = {
	model: "model",
	thinking: null,
	context: null,
	elapsed: null,
	sessionUsage: null,
	tokensPerSecond: null,
	inputMetrics: undefined,
	icons: undefined,
} as any;

function frame(displayNudgeText?: string): string[] {
	return renderBeautifiedEditorFrame({
		editorLines: ["hello"],
		width: 40,
		theme: createFakeTheme(),
		status,
		displayNudgeText,
	});
}

test("nudge 不改变行数与可见宽度", () => {
	const plain = frame();
	const nudged = frame("\x1b[0m");
	assert.equal(nudged.length, plain.length);
	for (let index = 0; index < plain.length; index += 1) {
		assert.equal(visibleWidth(nudged[index]!), visibleWidth(plain[index]!));
		assert.equal(visibleWidth(nudged[index]!), 40);
	}
});

test("nudge 确实改变了行字符串，能触发整行重画", () => {
	const plain = frame();
	const nudged = frame("\x1b[0m");
	for (let index = 0; index < plain.length; index += 1) {
		assert.notEqual(nudged[index], plain[index], `line ${index} 应不同`);
	}
});

test("nudge 不改变输入文本本身", () => {
	const nudged = frame("\x1b[0m");
	const text = nudged
		.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
		.find((line) => line.includes("hello"));
	assert.ok(text, "输入文本仍在帧内");
});
