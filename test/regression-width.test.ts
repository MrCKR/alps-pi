/** 功能：宽度矩阵回归测试 实现者：alps 实现日期：2026-05-26 */

import assert from "node:assert/strict";
import test from "node:test";
import { renderNeonBox } from "../src/features/chrome-frame/chrome.ts";
import { createFakeTheme, assertLinesWithin, stripAnsi } from "./helpers.test.ts";

const cases: Array<[number, string, string]> = [
	[20, "assistant", "English short sentence"],
	[20, "assistant", "中文短句需要换行"],
	[20, "working", "emoji 🚀✅🔥"],
	[40, "assistant", "**markdown** `code` [link](https://example.com)"],
	[40, "assistant", "\x1b[32mANSI colorful line with many words\x1b[39m"],
	[80, "assistant", "多行中文第一行\n第二行包含更长的中文内容用于验证宽度不会超过终端列宽"],
	[120, "toolSuccess", "long tool output ".repeat(20)],
];

for (const [width, kind, content] of cases) {
	test(`width=${width} kind=${kind} content=${content.slice(0, 12)}`, () => {
		const lines = renderNeonBox(kind as any, [content], width, createFakeTheme(), { toolName: "bash" });
		assertLinesWithin(lines, width);
		assert.ok(stripAnsi(lines[0]!).startsWith("╭"));
		assert.ok(stripAnsi(lines.at(-1)!).startsWith("╰"));
		assert.ok(lines.length >= 3);
		if (content.trim()) {
			const plain = stripAnsi(lines.join("\n"));
			assert.ok(/[A-Za-z\u4e00-\u9fff🚀✅🔥]/u.test(plain));
		}
	});
}
