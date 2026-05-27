/** 功能：验证图片 escape 行检测与安全回退 实现者：alps 实现日期：2026-05-26 */

import assert from "node:assert/strict";
import test from "node:test";
import { renderNeonBox } from "../src/chrome.ts";
import { containsImageLine, isImageEscapeLine } from "../src/image.ts";
import { createSafeBoxRender } from "../src/patch.ts";
import { createFakeTheme, stripAnsi, assertLinesWithin } from "./helpers.test.ts";

const kitty = "\x1b_Gf=100,a=T;AAAA\x1b\\";
const iterm = "\x1b]1337;File=inline=1;width=10px;height=10px:AAAA\x07";

test("检测 Kitty image escape 行", () => {
	assert.equal(isImageEscapeLine(kitty), true);
});

test("检测 iTerm image escape 行", () => {
	assert.equal(isImageEscapeLine(iterm), true);
});

test("普通文本不被识别为 image line", () => {
	assert.equal(isImageEscapeLine("plain text"), false);
	assert.equal(containsImageLine(["plain", "text"]), false);
});

test("含 image line 的内容不被截断破坏，image 行不加边框/背景", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("toolSuccess", ["before", kitty, "after"], 40, theme, { toolName: "read" });
	const imageLine = lines.find((line) => line.includes(kitty));
	assert.equal(imageLine, kitty);
	assert.equal(theme.calls.some((call) => call.kind === "bg" && call.text.includes(kitty)), false);
	assert.ok(stripAnsi(lines[0]!).includes("TOOL read ✓"));
	assert.ok(stripAnsi(lines.at(-1)!).startsWith("╰"));
	assertLinesWithin(lines.filter((line) => !line.includes(kitty)), 40);
});

test("image line 包装失败时回退原始渲染", () => {
	const originalLines = ["before", kitty, "after"];
	const safe = createSafeBoxRender("tool", () => originalLines, {
		getTheme: () => createFakeTheme(),
		getFallback: () => originalLines,
		forceImageFallback: true,
		toolName: "read",
	});
	assert.deepEqual(safe(40), originalLines);
});

test("image line 前后仍可添加标题和边框时不破坏 escape", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("toolPending", [kitty], 36, theme, { toolName: "image" });
	assert.ok(lines[0] && stripAnsi(lines[0]).includes("TOOL image"));
	assert.equal(lines.find((line) => line.includes(kitty)), kitty);
	assert.ok(lines.at(-1) && stripAnsi(lines.at(-1)!).includes("╰"));
});


test("长 Kitty/iTerm image payload 原样保留且不截断终止符", () => {
	const longKitty = `\x1b_Gf=100,a=T;${"A".repeat(5000)}\x1b\\`;
	const longIterm = `\x1b]1337;File=inline=1;width=10px;height=10px:${"B".repeat(5000)}\x07`;
	for (const image of [longKitty, longIterm]) {
		const theme = createFakeTheme();
		const lines = renderNeonBox("toolSuccess", ["before", image, "after"], 24, theme, { toolName: "image" });
		const imageLine = lines.find((line) => line.includes(image));
		assert.equal(imageLine, image);
		assert.equal(imageLine?.endsWith(image.endsWith("\x07") ? "\x07" : "\x1b\\"), true);
		assert.equal(theme.calls.some((call) => call.kind === "bg" && call.text.includes(image)), false);
	}
});


test("forceImageFallback 对长 image payload 整块回退", () => {
	const longKitty = `\x1b_Gf=100,a=T;${"C".repeat(5000)}\x1b\\`;
	const originalLines = ["before", longKitty, "after"];
	const safe = createSafeBoxRender("tool", () => originalLines, {
		getTheme: () => createFakeTheme(),
		getFallback: () => originalLines,
		forceImageFallback: true,
		toolName: "read",
	});
	assert.deepEqual(safe(24), originalLines);
});
