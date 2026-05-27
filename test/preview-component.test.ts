/** 功能：验证 /alps-pi preview 组件内容与关闭键 实现者：alps 实现日期：2026-05-26 */

import assert from "node:assert/strict";
import test from "node:test";
import { createPreviewComponent } from "../src/preview.ts";
import { createFakeTheme, assertLinesWithin, stripAnsi } from "./helpers.test.ts";

function renderPreview(width = 72) {
	const theme = createFakeTheme();
	const component = createPreviewComponent(theme);
	const lines = component.render(width);
	return { theme, component, lines, plain: stripAnsi(lines.join("\n")) };
}

test("preview 渲染包含要求的 message/tool/bash/working 与边界样例", () => {
	const { lines, plain } = renderPreview(72);
	for (const expected of [
		"USER",
		"ASSISTANT",
		"CUSTOM",
		"SKILL",
		"COMPACT",
		"BRANCH",
		"TOOL read",
		"TOOL todo ✓",
		"TOOL bash ✗",
		"BASH",
		"WORKING",
		"长中文",
		"ANSI green text",
		"```ts",
		"const ok = true;",
		"very long line",
		"press Esc",
	]) {
		assert.ok(plain.includes(expected), expected);
	}
	assert.ok((plain.match(/BASH/g) ?? []).length >= 3);
	assert.ok(plain.includes("$ npm test"));
	assertLinesWithin(lines, 72);
});


test("preview 关闭键 q/Esc/Enter/Ctrl+C 只调用 done 一次", () => {
	for (const key of ["q", "Q", "\x1b", "\r", "\x03"]) {
		let calls = 0;
		const component = createPreviewComponent(createFakeTheme(), () => {
			calls += 1;
		});
		component.handleInput(key);
		component.handleInput(key);
		assert.equal(calls, 1, JSON.stringify(key));
	}
});


test("preview 非关闭键不调用 done", () => {
	let calls = 0;
	const component = createPreviewComponent(createFakeTheme(), () => {
		calls += 1;
	});
	component.handleInput("x");
	assert.equal(calls, 0);
});
