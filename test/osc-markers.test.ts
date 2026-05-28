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

test("box 后 marker 被恢复到正文首尾而不是边框", () => {
	const theme = createFakeTheme();
	const input = [`${START}hello`, `${END}${FINAL}world`];
	const extracted = extractBoundaryOscMarkers(input);
	const boxed = renderNeonBox("assistant", extracted.lines, 30, theme);
	const restored = restoreBoundaryOscMarkers(boxed, extracted, { startIndex: 1, endIndex: boxed.length - 2 });
	assert.equal(restored[0]!.startsWith(START), false);
	assert.ok(restored[1]!.startsWith(START));
	assert.ok(restored.at(-2)!.startsWith(`${END}${FINAL}`));
	assert.equal(restored.at(-1)!.startsWith(`${END}${FINAL}`), false);
	assert.equal(visibleWidth(restored[1]!), 30);
	assert.equal(visibleWidth(restored.at(-2)!), 30);
});


test("renderNeonBox 直接处理真实 Pi OSC133 边界且不把 END/FINAL 放到底边框", () => {
	const theme = createFakeTheme();
	const lines = renderNeonBox("user", [`${START}hello`, `${END}${FINAL}world`], 32, theme);
	assert.equal(lines[0]!.startsWith(START), false);
	assert.ok(lines[1]!.startsWith(START));
	assert.ok(lines.at(-2)!.startsWith(`${END}${FINAL}`));
	assert.equal(lines.at(-1)!.startsWith(`${END}${FINAL}`), false);
	const plainContent = lines.slice(1, -1).map(stripAnsi).join("\n");
	assert.equal(plainContent.includes(END), false);
	assert.equal(plainContent.includes(FINAL), false);
	assert.ok(plainContent.includes("hello"));
	assert.ok(plainContent.includes("world"));
});


test("真实 User/Assistant renderer 的 OSC133 前缀 marker 会恢复到正文首尾", () => {
	ensurePiTheme();
	const userLines = new UserMessageComponent("hello").render(40);
	const assistantLines = new AssistantMessageComponent({ content: [{ type: "text", text: "hello" }] } as any).render(40);
	for (const [kind, original] of [["user", userLines], ["assistant", assistantLines]] as const) {
		const boxed = renderNeonBox(kind, original, 44, createFakeTheme());
		assert.equal(boxed[0]!.startsWith(START), false, kind);
		assert.ok(boxed[1]!.startsWith(START), kind);
		assert.ok(boxed.at(-2)!.startsWith(`${END}${FINAL}`), kind);
		assert.equal(boxed.at(-1)!.startsWith(`${END}${FINAL}`), false, kind);
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
