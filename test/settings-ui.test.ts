/** 功能：验证 alps pi 设置界面交互 实现者：alps 实现日期：2026-05-26 */

import assert from "node:assert/strict";
import test from "node:test";
import { createInitialPatchState } from "../src/features/chrome-frame/patch.ts";
import { AlpsPiSettingsComponent } from "../src/settings-ui.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createFakeTheme, stripAnsi } from "./helpers.test.ts";

function createPanel(options: { fixedResult?: { enabled: boolean; installed: boolean; failure?: string } } = {}) {
	const state = createInitialPatchState();
	const calls: string[] = [];
	const fixedCalls: boolean[] = [];
	let closed = false;
	const component = new AlpsPiSettingsComponent(createFakeTheme(), () => {
		closed = true;
	}, {
		getState: () => state,
		enableChromeFrame: () => {
			calls.push("enable");
			state.enabled = true;
			state.config.settings.chromeFrame.enabled = true;
			return state;
		},
		disableChromeFrame: () => {
			calls.push("disable");
			state.enabled = false;
			state.config.settings.chromeFrame.enabled = false;
			return state;
		},
		setFixedBottomEditorEnabled: (enabled: boolean) => {
			fixedCalls.push(enabled);
			return options.fixedResult ?? { enabled, installed: false };
		},
	});
	return { state, calls, fixedCalls, component, isClosed: () => closed };
}

test("设置界面展示线框美化、正文线框和固定输入框，并渲染完整边框", () => {
	const { component } = createPanel();
	const lines = component.render(80);
	const plain = stripAnsi(lines.join("\n"));
	assert.match(plain, /线框美化/);
	assert.match(plain, /正文线框/);
	assert.match(plain, /固定输入框/);
	assert.match(plain, /固定输入框\s+OFF/);
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

test("设置界面可切换线框美化", () => {
	const { state, calls, component } = createPanel();
	assert.equal(state.config.settings.chromeFrame.enabled, false);
	component.handleInput(" ");
	assert.equal(state.config.settings.chromeFrame.enabled, true);
	assert.deepEqual(calls, ["enable"]);
	component.handleInput(" ");
	assert.equal(state.config.settings.chromeFrame.enabled, false);
	assert.deepEqual(calls, ["enable", "disable"]);
});

test("设置界面可切换正文线框并关闭", () => {
	const { state, component, isClosed } = createPanel();
	assert.equal(state.config.settings.chromeFrame.assistantFrame, true);
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.equal(state.config.settings.chromeFrame.assistantFrame, false);
	component.handleInput("q");
	assert.equal(isClosed(), true);
});

test("设置界面第三项切换固定输入框并调用 runtime op", () => {
	const { state, fixedCalls, component } = createPanel();
	assert.equal(state.config.settings.fixedBottomEditor.enabled, false);
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.equal(state.config.settings.fixedBottomEditor.enabled, true);
	assert.deepEqual(fixedCalls, [true]);
});

test("设置界面固定输入框启用失败时回滚 OFF", () => {
	const { state, fixedCalls, component } = createPanel({ fixedResult: { enabled: false, installed: false, failure: "boom" } });
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput(" ");

	assert.equal(state.config.settings.fixedBottomEditor.enabled, false);
	assert.deepEqual(fixedCalls, [true]);
	assert.match(stripAnsi(component.render(80).join("\n")), /固定输入框\s+OFF/);
});
