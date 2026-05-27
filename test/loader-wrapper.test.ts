/** 功能：验证 working chrome 保留为纯渲染/preview 能力，不再全局 patch 基础 Loader 实现者：alps 实现日期：2026-05-26 */

import assert from "node:assert/strict";
import test from "node:test";
import { renderNeonBox } from "../src/chrome.ts";
import { createRuntimeTargets } from "../src/patch.ts";
import { createFakeTheme, assertLinesWithin, stripAnsi } from "./helpers.test.ts";

test("working chrome 可通过纯渲染展示 WORKING box", () => {
	const lines = renderNeonBox("working", ["⠋ Working..."], 34, createFakeTheme());
	assert.match(stripAnsi(lines[0]!), /WORKING/);
	assert.ok(stripAnsi(lines.join("\n")).includes("Working"));
	assertLinesWithin(lines, 34);
});


test("working chrome 多次渲染不累积 box", () => {
	const first = stripAnsi(renderNeonBox("working", ["⠋ Working..."], 34, createFakeTheme()).join("\n"));
	const second = stripAnsi(renderNeonBox("working", ["⠙ Still working..."], 34, createFakeTheme()).join("\n"));
	assert.equal((first.match(/WORKING/g) ?? []).length, 1);
	assert.equal((second.match(/WORKING/g) ?? []).length, 1);
	assert.ok(second.includes("Still working"));
});


test("基础 Loader 不在 runtime targets 中，避免全局 patch", () => {
	const targets = createRuntimeTargets(createFakeTheme());
	assert.equal(targets.some((target) => target.id === "Loader"), false);
});


test("working chrome width 很小时不抛异常", () => {
	for (const width of [1, 2, 3, 4]) {
		assert.doesNotThrow(() => renderNeonBox("working", ["Working..."], width, createFakeTheme()));
	}
});
