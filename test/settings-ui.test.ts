/** 功能：验证 alps pi 设置界面交互 实现者：alps 实现日期：2026-05-26 */

import assert from "node:assert/strict";
import test from "node:test";
import { createInitialPatchState } from "../src/patch.ts";
import { AlpsPiSettingsComponent } from "../src/settings-ui.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createFakeTheme, stripAnsi } from "./helpers.test.ts";

function createPanel() {
	const state = createInitialPatchState();
	const calls: string[] = [];
	let closed = false;
	const component = new AlpsPiSettingsComponent(createFakeTheme(), () => {
		closed = true;
	}, {
		getState: () => state,
		enable: () => {
			calls.push("enable");
			state.enabled = true;
			return state;
		},
		disable: () => {
			calls.push("disable");
			state.enabled = false;
			return state;
		},
	});
	return { state, calls, component, isClosed: () => closed };
}

test("设置界面只展示总开关和正文线框，并渲染完整边框", () => {
	const { component } = createPanel();
	const lines = component.render(80);
	const plain = stripAnsi(lines.join("\n"));
	assert.match(plain, /总开关/);
	assert.match(plain, /正文线框/);
	assert.doesNotMatch(plain, /preview/i);
	assert.ok(stripAnsi(lines[0]!).startsWith("╭"));
	assert.ok(stripAnsi(lines.at(-1)!).startsWith("╰"));
	for (const line of lines) {
		const stripped = stripAnsi(line);
		assert.ok(stripped.startsWith("╭") || stripped.startsWith("╰") || stripped.startsWith("│"), stripped);
		assert.ok(stripped.endsWith("╮") || stripped.endsWith("╯") || stripped.endsWith("│"), stripped);
		assert.equal(visibleWidth(line), 80);
	}
});

test("设置界面可切换总开关", () => {
	const { state, calls, component } = createPanel();
	assert.equal(state.enabled, false);
	component.handleInput(" ");
	assert.equal(state.enabled, true);
	assert.deepEqual(calls, ["enable"]);
	component.handleInput(" ");
	assert.equal(state.enabled, false);
	assert.deepEqual(calls, ["enable", "disable"]);
});

test("设置界面可切换正文线框并关闭", () => {
	const { state, component, isClosed } = createPanel();
	assert.equal(state.config.settings.assistantFrame, true);
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.equal(state.config.settings.assistantFrame, false);
	component.handleInput("q");
	assert.equal(isClosed(), true);
});
