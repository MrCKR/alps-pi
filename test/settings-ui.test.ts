/** 功能：验证 alps pi 设置界面交互 实现者：alps 实现日期：2026-05-26 */

import assert from "node:assert/strict";
import test from "node:test";
import { createInitialPatchState } from "../src/features/chrome-frame/patch.ts";
import { AlpsPiSettingsComponent } from "../src/settings-ui.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { validateShortcutChange } from "../src/features/bottom-input/shortcuts.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createFakeTheme, stripAnsi } from "./helpers.test.ts";

function createPanel() {
	const state = createInitialPatchState();
	const calls: string[] = [];
	const beautifiedInputCalls: boolean[] = [];
	const changedCalls: string[] = [];
	const renderCalls: boolean[] = [];
	let closed = false;
	const component = new AlpsPiSettingsComponent(createFakeTheme(), () => {
		closed = true;
	}, {
		getState: () => state,
		setMasterEnabled: (enabled: boolean) => {
			calls.push(enabled ? "enable" : "disable");
			state.enabled = enabled;
			state.config.settings.chromeFrame.enabled = enabled;
			return state;
		},
		setBeautifiedInputEnabled: (enabled: boolean) => {
			beautifiedInputCalls.push(enabled);
		},
		onSettingsChanged: (settings) => {
			changedCalls.push(JSON.stringify(settings.animations));
		},
		requestRender: () => {
			renderCalls.push(true);
		},
	});
	return { state, calls, beautifiedInputCalls, changedCalls, renderCalls, component, isClosed: () => closed };
}

test("设置界面展示英文设置名、中文描述和主题线框", () => {
	const { component } = createPanel();
	const lines = component.render(80);
	const plain = stripAnsi(lines.join("\n"));
	assert.match(plain, /Master Switch/);
	assert.match(plain, /Assistant Frame/);
	assert.match(plain, /Compact Tools/);
	assert.match(plain, /Compact Edit/);
	assert.doesNotMatch(plain, /Fixed Input/);
	assert.match(plain, /Beautified Input/);
	assert.match(plain, /Animations/);
	assert.match(plain, /Shortcuts/);
	assert.match(plain, /统一启用或关闭所有 Alps Pi 美化效果/);
	assert.doesNotMatch(plain, /底部状态栏/);
	assert.match(plain, /Master Switch\s+ON/);
	assert.match(plain, /Compact Tools\s+ON/);
	assert.match(plain, /Compact Edit\s+OFF/);
	assert.match(plain, /Beautified Input\s+ON/);
	assert.match(plain, /Animations\s+configure/);
	assert.doesNotMatch(plain, /preview/i);
	assert.doesNotMatch(plain, /Alps Pi 美化设置/);
	assert.equal(stripAnsi(lines[0]!), `╭${"─".repeat(78)}╮`);
	assert.equal(stripAnsi(lines.at(-1)!), `╰${"─".repeat(78)}╯`);
	assert.ok(stripAnsi(lines.slice(1, -1).join("\n")).split("\n").every((line) => line.startsWith("│ ") && line.endsWith(" │")));
	assert.match(plain, />/);
	assert.match(plain, /↑\/↓ select · Enter\/Space toggle · Esc\/q close/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 80));
	assert.match(lines[0]!, /\x1b\[38;5;12m╭/);
	assert.match(lines.at(-1)!, /\x1b\[38;5;12m╰/);
});

test("设置界面可切换美化总开关", () => {
	const { state, calls, component } = createPanel();
	assert.equal(state.config.settings.chromeFrame.enabled, true);
	component.handleInput(" ");
	assert.equal(state.config.settings.chromeFrame.enabled, false);
	assert.deepEqual(calls, ["disable"]);
	component.handleInput(" ");
	assert.equal(state.config.settings.chromeFrame.enabled, true);
	assert.deepEqual(calls, ["disable", "enable"]);
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

test("设置界面第五项切换美化输入框且不改 legacy fixed 偏好", () => {
	const { state, beautifiedInputCalls, component } = createPanel();
	state.config.settings.fixedBottomEditor.enabled = true;
	for (let i = 0; i < 4; i++) component.handleInput("\x1b[B");
	component.handleInput(" ");

	assert.equal(state.config.settings.beautifiedInput.enabled, false);
	assert.equal(state.config.settings.fixedBottomEditor.enabled, true);
	assert.deepEqual(beautifiedInputCalls, [false]);
	assert.doesNotMatch(stripAnsi(component.render(80).join("\n")), /Fixed Input/);
});

test("Animations 二级页可修改 Enabled、Random Mode、Thinking、Working、Tool、Width、FPS，并提供预览入口", async () => {
	const { state, changedCalls, renderCalls, component } = createPanel();
	openAnimationsSettings(component);
	const initial = stripAnsi(component.render(90).join("\n"));
	assert.match(initial, /Enabled\s+ON/);
	assert.match(initial, /Random Mode\s+OFF/);
	assert.match(initial, /Thinking\s+shimmer/);
	assert.match(initial, /Working\s+crush/);
	assert.match(initial, /Tool\s+pipeline/);
	assert.match(initial, /Width\s+default/);
	assert.match(initial, /FPS\s+16/);
	assert.match(initial, /Preview\s+open/);

	component.handleInput(" ");
	assert.equal(state.config.settings.animations.enabled, false);
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.equal(state.config.settings.animations.randomMode, true);
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.notEqual(state.config.settings.animations.thinking, "shimmer");
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.notEqual(state.config.settings.animations.working, "crush");
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.notEqual(state.config.settings.animations.tool, "pipeline");
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.equal(state.config.settings.animations.width, 20);
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.equal(state.config.settings.animations.fps, 24);
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.match(stripAnsi(component.render(90).join("\n")), /Animation Preview/);
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.ok(renderCalls.length > 0);
	const callsBeforeClose = renderCalls.length;
	component.handleInput("q");
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(renderCalls.length, callsBeforeClose);
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	component.handleInput(" ");
	assert.match(stripAnsi(component.render(90).join("\n")), /Preview\s+open/);
	assert.ok(changedCalls.length >= 7);
});

test("快捷键校验拒绝归一化后的 Pi 保留键", () => {
	for (const shortcut of ["ctrl+shift+p", "shift+ctrl+p", "ctrl+shift+o", "shift+ctrl+o"]) {
		const result = validateShortcutChange(DEFAULT_SETTINGS.shortcuts, "copyEditor", shortcut);
		assert.equal(result.ok, false, shortcut);
		if (!result.ok) assert.match(result.reason, /Reserved/);
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
	assert.match(stripAnsi(component.render(80).join("\n")), /Conflicts/);
});

test("快捷键设置 Enter 捕获并保存新快捷键", () => {
	const { state, component } = createPanel();
	openShortcutSettings(component);
	component.handleInput("\r");
	component.handleInput("\x1bg");

	assert.equal(state.config.settings.shortcuts.stashEditor, "alt+g");
	assert.match(stripAnsi(component.render(80).join("\n")), /alt\+g/);
	assert.match(stripAnsi(component.render(80).join("\n")), /Saved/);
});

test("快捷键设置捕获中 Esc 取消且不修改", () => {
	const { state, component } = createPanel();
	openShortcutSettings(component);
	component.handleInput("\r");
	component.handleInput("\x1b");

	assert.equal(state.config.settings.shortcuts.stashEditor, DEFAULT_SETTINGS.shortcuts.stashEditor);
	assert.match(stripAnsi(component.render(80).join("\n")), /Cancelled/);
});

test("快捷键设置捕获中 Backspace 恢复默认", () => {
	const { state, component } = createPanel();
	state.config.settings.shortcuts.stashEditor = "alt+g";
	openShortcutSettings(component);
	component.handleInput("\r");
	component.handleInput("\x7f");

	assert.equal(state.config.settings.shortcuts.stashEditor, DEFAULT_SETTINGS.shortcuts.stashEditor);
	assert.match(stripAnsi(component.render(80).join("\n")), /Restored default/);
});

test("快捷键设置捕获中拒绝保留键和冲突键", () => {
	const { state, component } = createPanel();
	openShortcutSettings(component);
	component.handleInput("\r");
	component.handleInput("\x1b[80;6u");
	assert.equal(state.config.settings.shortcuts.stashEditor, DEFAULT_SETTINGS.shortcuts.stashEditor);
	assert.match(stripAnsi(component.render(80).join("\n")), /Reserved/);

	component.handleInput("\x1b[67;7u");
	assert.equal(state.config.settings.shortcuts.stashEditor, DEFAULT_SETTINGS.shortcuts.stashEditor);
	assert.match(stripAnsi(component.render(80).join("\n")), /Conflicts/);
});

test("快捷键设置保存后关闭捕获并返回快捷键页", () => {
	const { state, component } = createPanel();
	openShortcutSettings(component);
	component.handleInput("\r");
	component.handleInput("\x1bg");
	component.handleInput("\x1b");

	assert.equal(state.config.settings.shortcuts.stashEditor, "alt+g");
	assert.doesNotMatch(stripAnsi(component.render(80).join("\n")), /Editing:/);
	assert.match(stripAnsi(component.render(80).join("\n")), /Master Switch/);
});

function openAnimationsSettings(component: AlpsPiSettingsComponent): void {
	for (let i = 0; i < 5; i++) component.handleInput("\x1b[B");
	component.handleInput(" ");
}

function openShortcutSettings(component: AlpsPiSettingsComponent): void {
	for (let i = 0; i < 6; i++) component.handleInput("\x1b[B");
	component.handleInput(" ");
}
