/** 功能：验证 fixed bottom editor cluster 纯函数 实现者：alps 实现日期：2026-05-27 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FIXED_EDITOR_CURSOR_MARKER, renderFixedEditorCluster } from "../src/features/fixed-bottom-editor/cluster.ts";
import { assertLinesWithin, stripAnsi } from "./helpers.test.ts";

test("空输入返回空 cluster", () => {
	assert.deepEqual(renderFixedEditorCluster({ width: 80, maxHeight: 4 }), { lines: [] });
	assert.deepEqual(renderFixedEditorCluster({ editorLines: [], statusLines: [], footerLines: [], width: 80, maxHeight: 4 }), { lines: [] });
});

test("行宽超过 width 时会截断", () => {
	const cluster = renderFixedEditorCluster({
		editorLines: ["abcdefghijklmnopqrstuvwxyz"],
		width: 8,
		maxHeight: 3,
	});

	assert.equal(cluster.lines.length, 1);
	assertLinesWithin(cluster.lines, 8);
	assert.equal(stripAnsi(cluster.lines[0]!), "abcdefgh");
});

test("ANSI、CJK 和 emoji 不导致可见宽度超出 width", () => {
	const cluster = renderFixedEditorCluster({
		statusLines: ["\x1b[31m状态：准备好了\x1b[39m"],
		editorLines: ["输入 😀😀😀 中文内容"],
		footerLines: ["\x1b[2mfooter 尾部信息很长\x1b[22m"],
		width: 10,
		maxHeight: 5,
	});

	assert.equal(cluster.lines.length, 3);
	assertLinesWithin(cluster.lines, 10);
	for (const line of cluster.lines) {
		assert.ok(visibleWidth(line) <= 10);
	}
});

test("包含 CURSOR_MARKER 时能提取 cursor，并从输出行删除 marker", () => {
	const marker = FIXED_EDITOR_CURSOR_MARKER;
	const cluster = renderFixedEditorCluster({
		statusLines: ["status"],
		editorLines: [`hello ${marker}世界`],
		footerLines: ["footer"],
		width: 20,
		maxHeight: 5,
	});

	assert.deepEqual(cluster.cursor, { row: 1, col: 6 });
	assert.equal(cluster.lines[1], "hello 世界");
	assert.equal(cluster.lines.some((line) => line.includes(marker)), false);
	assertLinesWithin(cluster.lines, 20);
});

test("editor 行数超过可用高度时，优先保留 cursor 附近行", () => {
	const marker = FIXED_EDITOR_CURSOR_MARKER;
	const cluster = renderFixedEditorCluster({
		editorLines: ["line-0", "line-1", `line-2 ${marker}cursor`, "line-3", "line-4", "line-5"],
		width: 20,
		maxHeight: 3,
	});

	assert.deepEqual(cluster.lines.map(stripAnsi), ["line-1", "line-2 cursor", "line-3"]);
	assert.deepEqual(cluster.cursor, { row: 1, col: 7 });
	assertLinesWithin(cluster.lines, 20);
});
