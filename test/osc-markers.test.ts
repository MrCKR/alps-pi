/** 功能：验证 OSC133 marker 安全提取与恢复 实现者：alps 实现日期：2026-05-26 */

import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderNeonBox } from "../src/features/chrome-frame/chrome.ts";
import { extractBoundaryOscMarkers, restoreBoundaryOscMarkers, stripBoundaryOscMarkers } from "../src/features/chrome-frame/osc.ts";
import { createFakeTheme, stripAnsi } from "./helpers.test.ts";

const START = "\x1b]133;A\x07";
const END = "\x1b]133;B\x07";
const FINAL = "\x1b]133;C\x07";

let themeInitialized = false;
function ensurePiTheme() {
	if (!themeInitialized) {
		initTheme("dark", false);
		themeInitialized = true;
	}
}

test("能提取首行开头 START OSC133 marker", () => {
	const extracted = extractBoundaryOscMarkers([`${START}hello`, "world"]);
	assert.deepEqual(extracted.startMarkers, [START]);
	assert.equal(extracted.lines[0], "hello");
});


test("首行开头 END/FINAL 不作为 start marker 提取", () => {
	const extracted = extractBoundaryOscMarkers([`${END}${FINAL}hello`, "world"]);
	assert.deepEqual(extracted.startMarkers, []);
	assert.equal(extracted.lines[0], `${END}${FINAL}hello`);
});

test("能提取真实 Pi 的尾行开头 OSC133 marker", () => {
	const extracted = extractBoundaryOscMarkers(["hello", `${END}${FINAL}world`]);
	assert.deepEqual(extracted.endMarkers, [END, FINAL]);
	assert.equal(extracted.lines.at(-1), "world");
});


test("尾行结尾 OSC133 marker 不作为边界 marker 提取", () => {
	const extracted = extractBoundaryOscMarkers(["hello", `world${END}${FINAL}`]);
	assert.deepEqual(extracted.endMarkers, []);
	assert.equal(extracted.lines.at(-1), `world${END}${FINAL}`);
});

test("marker 不参与 visibleWidth 计算", () => {
	assert.equal(visibleWidth(`${START}abc${END}${FINAL}`), 3);
});

test("box 后 marker 默认恢复到 top/bottom 边框", () => {
	const input = [`${START}hello`, `${END}${FINAL}world`];
	const extracted = extractBoundaryOscMarkers(input);
	const restored = restoreBoundaryOscMarkers(["top", "content", "bottom"], extracted);
	assert.ok(restored[0]!.startsWith(START));
	assert.equal(restored[1]!.startsWith(START), false);
	assert.ok(restored.at(-1)!.startsWith(`${END}${FINAL}`));
	assert.equal(restored.at(-2)!.startsWith(`${END}${FINAL}`), false);
});


test("renderNeonBox 直接处理真实 Pi OSC133 边界并放到 top/bottom 边框", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("user", [`${START}hello`, `${END}${FINAL}world`], 32, theme);
	assert.ok(lines[0]!.startsWith(START));
	assert.ok(lines.at(-1)!.startsWith(`${END}${FINAL}`));
	for (const line of lines.slice(1, -1)) {
		assert.equal(line.startsWith(START), false);
		assert.equal(line.startsWith(END), false);
		assert.equal(line.startsWith(FINAL), false);
	}
	const joined = lines.join("\n");
	assert.equal((joined.match(/\x1b\]133;/g) ?? []).length, 3);
	const plainContent = lines.slice(1, -1).map(stripAnsi).join("\n");
	assert.equal(plainContent.includes(END), false);
	assert.equal(plainContent.includes(FINAL), false);
	assert.ok(plainContent.includes("hello"));
	assert.ok(plainContent.includes("world"));
});

test("assistant 边界空行裁剪后 OSC133 仍在 top/bottom 边框", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("assistant", [`${START}`, "ok", `${END}${FINAL}`], 32, theme);
	assert.ok(lines[0]!.startsWith(START));
	assert.ok(lines.at(-1)!.startsWith(`${END}${FINAL}`));
	for (const line of lines.slice(1, -1)) {
		assert.equal(line.startsWith(START), false);
		assert.equal(line.startsWith(END), false);
		assert.equal(line.startsWith(FINAL), false);
	}
	assert.match(lines.slice(1, -1).map(stripAnsi).join("\n"), /ok/);
});

test("thinking 边界 control-only 行被裁剪且 OSC133 留在外框边界", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("thinking", [`${START}\x1b[31m \x1b[39m`, "visible", `${END}${FINAL}   `], 34, theme);
	assert.ok(lines[0]!.startsWith(START));
	assert.ok(lines.at(-1)!.startsWith(`${END}${FINAL}`));
	const content = lines.slice(1, -1).map(stripAnsi);
	assert.equal(content.length, 1);
	assert.match(content[0]!, /visible/);
	for (const line of lines.slice(1, -1)) {
		assert.equal(line.startsWith(START), false);
		assert.equal(line.startsWith(END), false);
		assert.equal(line.startsWith(FINAL), false);
	}
});

test("assistant 边界空白区内的 START-only blank 不会被裁剪丢失", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("assistant", ["", `${START}\x1b[31m \x1b[39m`, "visible", `${END}${FINAL}`, ""], 34, theme);
	assert.ok(lines[0]!.startsWith(START));
	assert.ok(lines.at(-1)!.startsWith(`${END}${FINAL}`));
	assert.equal((lines.join("\n").match(/\x1b\]133;/g) ?? []).length, 3);
	const content = lines.slice(1, -1).map(stripAnsi);
	assert.equal(content.length, 1);
	assert.match(content[0]!, /visible/);
	for (const line of lines.slice(1, -1)) {
		assert.equal(line.startsWith(START), false);
		assert.equal(line.startsWith(END), false);
		assert.equal(line.startsWith(FINAL), false);
	}
});

test("tool 尾部 END/FINAL-only blank 后有 padding 空行时 marker 不丢失", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("tool", ["result", `${END}${FINAL}\x1b[31m \x1b[39m`, ""], 34, theme, { toolName: "read", status: "success" });
	assert.equal(lines[0]!.startsWith(START), false);
	assert.ok(lines.at(-1)!.startsWith(`${END}${FINAL}`));
	assert.equal((lines.join("\n").match(/\x1b\]133;/g) ?? []).length, 2);
	const content = lines.slice(1, -1).map(stripAnsi);
	assert.equal(content.length, 1);
	assert.match(content[0]!, /result/);
});

for (const [name, original] of [
	["无 padding", ["body", END, FINAL]],
	["尾部 padding 空行", ["body", END, FINAL, ""]],
	["marker 后带空格", ["body", `${END} `, `${FINAL} `]],
] as const) {
	test(`assistant 尾部跨行 END/FINAL marker 保持原始顺序：${name}`, () => {
		const theme = createFakeTheme();
		const lines = renderNeonBox("assistant", original, 34, theme);
		assert.ok(lines.at(-1)!.startsWith(`${END}${FINAL}`));
		assert.equal((lines.join("\n").match(/\x1b\]133;/g) ?? []).length, 2);
		for (const line of lines.slice(1, -1)) {
			assert.equal(line.startsWith(END), false);
			assert.equal(line.startsWith(FINAL), false);
		}
	});
}

test("custom marker 不在原始首尾但位于边界空白区时迁移到 top/bottom", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("custom", ["", `${START}  `, "body", `${END}${FINAL}  `, ""], 34, theme);
	assert.ok(lines[0]!.startsWith(START));
	assert.ok(lines.at(-1)!.startsWith(`${END}${FINAL}`));
	assert.equal((lines.join("\n").match(/\x1b\]133;/g) ?? []).length, 3);
	const content = lines.slice(1, -1).map(stripAnsi);
	assert.deepEqual(content.map((line) => line.includes("body")), [true]);
	for (const line of lines.slice(1, -1)) {
		assert.equal(line.startsWith(START), false);
		assert.equal(line.startsWith(END), false);
		assert.equal(line.startsWith(FINAL), false);
	}
});

test("assistant START marker 附着在首个可见边界行时仍迁移且保留文本", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("assistant", ["", `${START}visible`, `${END}${FINAL}tail`, ""], 34, theme);
	assert.ok(lines[0]!.startsWith(START));
	assert.ok(lines.at(-1)!.startsWith(`${END}${FINAL}`));
	assert.equal((lines.join("\n").match(/\x1b\]133;/g) ?? []).length, 3);
	const content = lines.slice(1, -1).map(stripAnsi).join("\n");
	assert.match(content, /visible/);
	assert.match(content, /tail/);
	for (const line of lines.slice(1, -1)) {
		assert.equal(line.startsWith(START), false);
		assert.equal(line.startsWith(END), false);
		assert.equal(line.startsWith(FINAL), false);
	}
});


test("真实 User/Assistant renderer 的 OSC133 前缀 marker 会恢复到 top/bottom 边框", () => {
	ensurePiTheme();
	const userLines = new UserMessageComponent("hello").render(40);
	const assistantLines = new AssistantMessageComponent({ content: [{ type: "text", text: "hello" }] } as any).render(40);
	for (const [kind, original] of [["user", userLines], ["assistant", assistantLines]] as const) {
		const boxed = renderNeonBox(kind, original, 44, createFakeTheme());
		assert.ok(boxed[0]!.startsWith(START), kind);
		assert.ok(boxed.at(-1)!.startsWith(`${END}${FINAL}`), kind);
		for (const line of boxed.slice(1, -1)) {
			assert.equal(line.startsWith(START), false, kind);
			assert.equal(line.startsWith(END), false, kind);
			assert.equal(line.startsWith(FINAL), false, kind);
		}
		const plainContent = boxed.slice(1, -1).map(stripAnsi).join("\n");
		assert.equal(plainContent.includes(END), false, kind);
		assert.equal(plainContent.includes(FINAL), false, kind);
		assert.ok(plainContent.includes("hello"), kind);
	}
});

test("无 marker 时输出不变", () => {
	const lines = ["a", "b"];
	const extracted = extractBoundaryOscMarkers(lines);
	assert.deepEqual(extracted.lines, lines);
	assert.deepEqual(extracted.startMarkers, []);
	assert.deepEqual(extracted.endMarkers, []);
	assert.deepEqual(restoreBoundaryOscMarkers(lines, extracted), lines);
});

test("多个 marker 连续出现时保持顺序", () => {
	const lines = [`${START}${START}a`, `${END}${FINAL}b`];
	const extracted = extractBoundaryOscMarkers(lines);
	assert.deepEqual(extracted.startMarkers, [START, START]);
	assert.deepEqual(extracted.endMarkers, [END, FINAL]);
	const restored = restoreBoundaryOscMarkers(["top", "bottom"], extracted);
	assert.ok(restored[0]!.startsWith(`${START}${START}`));
	assert.ok(restored[1]!.startsWith(`${END}${FINAL}`));
});

test("非 OSC ANSI 颜色码不被当成 marker 移除", () => {
	const red = "\x1b[31mred\x1b[39m";
	const extracted = extractBoundaryOscMarkers([red]);
	assert.equal(extracted.lines[0], red);
	assert.equal(stripAnsi(extracted.lines[0]!), "red");
});

test("marker 提取失败时不抛异常并保留原始行", () => {
	const malformed = "\x1b]133;A-no-bel hello";
	assert.doesNotThrow(() => stripBoundaryOscMarkers([malformed]));
	assert.deepEqual(stripBoundaryOscMarkers([malformed]).lines, [malformed]);
});
