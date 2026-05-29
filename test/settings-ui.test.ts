/** 功能：验证 alps pi 设置界面交互 实现者：alps 实现日期：2026-05-26 */

import assert from "node:assert/strict";
import test from "node:test";
import { createInitialPatchState } from "../src/features/chrome-frame/patch.ts";
import { AlpsPiSettingsComponent } from "../src/settings-ui.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { validateShortcutChange } from "../src/features/bottom-input/shortcuts.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createFakeTheme, stripAnsi } from "./helpers.test.ts";

function createPanel(options: { fixedResult?: { enabled: boolean; installed: boolean; failure?: string } } = {}) {
	const state = createInitialPatchState();
	const calls: string[] = [];
	const fixedCalls: boolean[] = [];
	const beautifiedInputCalls: boolean[] = [];
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
		setBeautifiedInputEnabled: (enabled: boolean) => {
			beautifiedInputCalls.push(enabled);
		},
	});
	return { state, calls, fixedCalls, beautifiedInputCalls, component, isClosed: () => closed };
}

test("设置界面展示线框美化、正文线框、Tool 极简模式、edit 收起、固定输入框和美化输入框，并使用主题线框", () => {
	const { component } = createPanel();
	const lines = component.render(80);
	const plain = stripAnsi(lines.join("\n"));
	assert.match(plain, /线框美化/);
	assert.match(plain, /正文线框/);
	assert.match(plain, /Tool 极简模式/);
	assert.match(plain, /极简下收起 edit/);
	assert.match(plain, /固定输入框/);
	assert.match(plain, /美化输入框/);
	assert.doesNotMatch(plain, /底部状态栏/);
	assert.match(plain, /Tool 极简模式\s+ON/);
	assert.match(plain, /极简下收起 edit\s+OFF/);
	assert.match(plain, /固定输入框\s+ON/);
	assert.match(plain, /美化输入框\s+ON/);
	assert.doesNotMatch(plain, /preview/i);
	assert.doesNotMatch(plain, /Alps Pi 美化设置/);
	assert.equal(stripAnsi(lines[0]!), `╭${"─".repeat(78)}╮`);
	assert.equal(stripAnsi(lines.at(-1)!), `╰${"─".repeat(78)}╯`);
	assert.ok(stripAnsi(lines.slice(1, -1).join("\n")).split("\n").every((line) => line.startsWith("│ ") && line.endsWith(" │")));
	assert.match(plain, />/);
	assert.match(plain, /Type to search · Enter\/Space to change · Esc to cancel/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 80));
	assert.match(lines[0]!, /\x1b\[38;5;12m╭/);
	assert.match(lines.at(-1)!, /\x1b\[38;5;12m╰/);
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

test("设置界面可切换 Tool 极简模式与 edit 收起", () => {
	const { state, component } = createPanel();
	assert.equal(state.config.settings.chromeFrame.toolCompactMode, true);
	assert.equal(state.config.settings.chromeFrame.compactEditTool, false);
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.equal(state.config.settings.chromeFrame.toolCompactMode, false);
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.equal(state.config.settings.chromeFrame.compactEditTool, true);
});

test("设置界面第五项切换固定输入框并调用 runtime op", () => {
	const { state, fixedCalls, beautifiedInputCalls, component } = createPanel();
	assert.equal(state.config.settings.fixedBottomEditor.enabled, true);
	assert.equal(state.config.settings.beautifiedInput.enabled, true);
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.equal(state.config.settings.fixedBottomEditor.enabled, false);
	assert.equal(state.config.settings.beautifiedInput.enabled, true);
	assert.deepEqual(fixedCalls, [false]);
	assert.deepEqual(beautifiedInputCalls, []);
});

test("设置界面第六项切换美化输入框并调用 runtime op", () => {
	const { state, fixedCalls, beautifiedInputCalls, component } = createPanel();
	assert.equal(state.config.settings.fixedBottomEditor.enabled, true);
	assert.equal(state.config.settings.beautifiedInput.enabled, true);
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.equal(state.config.settings.fixedBottomEditor.enabled, true);
	assert.equal(state.config.settings.beautifiedInput.enabled, false);
	assert.deepEqual(fixedCalls, []);
	assert.deepEqual(beautifiedInputCalls, [false]);
});

test("设置界面固定输入框启用失败时回滚 OFF", () => {
	const state = createInitialPatchState();
	state.config.settings.fixedBottomEditor.enabled = false;
	const fixedCalls: boolean[] = [];
	const component = new AlpsPiSettingsComponent(createFakeTheme(), undefined, {
		getState: () => state,
		setFixedBottomEditorEnabled: (enabled: boolean) => {
			fixedCalls.push(enabled);
			return { enabled: false, installed: false, failure: "boom" };
		},
	});
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput(" ");

	assert.equal(state.config.settings.fixedBottomEditor.enabled, false);
	assert.deepEqual(fixedCalls, [true]);
	assert.match(stripAnsi(component.render(80).join("\n")), /固定输入框\s+OFF/);
});

test("快捷键校验拒绝归一化后的 Pi 保留键", () => {
	for (const shortcut of ["ctrl+shift+p", "shift+ctrl+p", "ctrl+shift+o", "shift+ctrl+o"]) {
		const result = validateShortcutChange(DEFAULT_SETTINGS.shortcuts, "copyEditor", shortcut);
		assert.equal(result.ok, false, shortcut);
		if (!result.ok) assert.match(result.reason, /保留/);
	}
});

test("快捷键设置 Backspace 恢复默认会拒绝冲突", () => {
	const { state, component } = createPanel();
	state.config.settings.shortcuts.copyEditor = "ctrl+alt+g";
	state.config.settings.shortcuts.cutEditor = DEFAULT_SETTINGS.shortcuts.copyEditor;

	openShortcutSettings(component);
	component.handleInput("\x1b[B");
	component.handleInput("\x7f");

	assert.equal(state.config.settings.shortcuts.copyEditor, "ctrl+alt+g");
	assert.match(stripAnsi(component.render(80).join("\n")), /冲突/);
});

test("快捷键设置 Enter 捕获并保存新快捷键", () => {
	const { state, component } = createPanel();
	openShortcutSettings(component);
	component.handleInput("\r");
	component.handleInput("\x1bg");

	assert.equal(state.config.settings.shortcuts.stashEditor, "alt+g");
	assert.match(stripAnsi(component.render(80).join("\n")), /alt\+g/);
	assert.match(stripAnsi(component.render(80).join("\n")), /已保存/);
});

test("快捷键设置捕获中 Esc 取消且不修改", () => {
	const { state, component } = createPanel();
	openShortcutSettings(component);
	component.handleInput("\r");
	component.handleInput("\x1b");

	assert.equal(state.config.settings.shortcuts.stashEditor, DEFAULT_SETTINGS.shortcuts.stashEditor);
	assert.match(stripAnsi(component.render(80).join("\n")), /已取消/);
});

test("快捷键设置捕获中 Backspace 恢复默认", () => {
	const { state, component } = createPanel();
	state.config.settings.shortcuts.stashEditor = "alt+g";
	openShortcutSettings(component);
	component.handleInput("\r");
	component.handleInput("\x7f");

	assert.equal(state.config.settings.shortcuts.stashEditor, DEFAULT_SETTINGS.shortcuts.stashEditor);
	assert.match(stripAnsi(component.render(80).join("\n")), /已恢复默认/);
});

test("快捷键设置捕获中拒绝保留键和冲突键", () => {
	const { state, component } = createPanel();
	openShortcutSettings(component);
	component.handleInput("\r");
	component.handleInput("\x1b[80;6u");
	assert.equal(state.config.settings.shortcuts.stashEditor, DEFAULT_SETTINGS.shortcuts.stashEditor);
	assert.match(stripAnsi(component.render(80).join("\n")), /保留/);

	component.handleInput("\x1b[67;7u");
	assert.equal(state.config.settings.shortcuts.stashEditor, DEFAULT_SETTINGS.shortcuts.stashEditor);
	assert.match(stripAnsi(component.render(80).join("\n")), /冲突/);
});

test("快捷键设置保存后关闭捕获并返回快捷键页", () => {
	const { state, component } = createPanel();
	openShortcutSettings(component);
	component.handleInput("\r");
	component.handleInput("\x1bg");
	component.handleInput("\x1b");

	assert.equal(state.config.settings.shortcuts.stashEditor, "alt+g");
	assert.doesNotMatch(stripAnsi(component.render(80).join("\n")), /正在设置/);
	assert.match(stripAnsi(component.render(80).join("\n")), /线框美化/);
});

function openShortcutSettings(component: AlpsPiSettingsComponent): void {
	for (let i = 0; i < 6; i++) component.handleInput("\x1b[B");
	component.handleInput(" ");
}
