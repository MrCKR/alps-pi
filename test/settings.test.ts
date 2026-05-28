/** 功能：验证 alps pi 默认设置模型 实现者：alps 实现日期：2026-05-27 */

import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, cloneDefaultSettings } from "../src/settings.ts";

test("默认开启 Tool 极简模式且默认不收起 edit", () => {
	assert.equal(DEFAULT_SETTINGS.chromeFrame.toolCompactMode, true);
	assert.equal(DEFAULT_SETTINGS.chromeFrame.compactEditTool, false);
});

test("固定输入框默认开启", () => {
	assert.equal(DEFAULT_SETTINGS.fixedBottomEditor.enabled, true);
});

test("底部状态栏默认关闭", () => {
	assert.equal(DEFAULT_SETTINGS.bottomStatus.enabled, false);
});

test("cloneDefaultSettings 返回包含固定输入框和底部状态栏的新对象", () => {
	const cloned = cloneDefaultSettings();
	assert.notEqual(cloned, DEFAULT_SETTINGS);
	assert.notEqual(cloned.chromeFrame, DEFAULT_SETTINGS.chromeFrame);
	assert.notEqual(cloned.fixedBottomEditor, DEFAULT_SETTINGS.fixedBottomEditor);
	assert.notEqual(cloned.bottomStatus, DEFAULT_SETTINGS.bottomStatus);
	assert.notEqual(cloned.shortcuts, DEFAULT_SETTINGS.shortcuts);
	assert.deepEqual(cloned, {
		chromeFrame: {
			enabled: false,
			assistantFrame: true,
			toolCompactMode: true,
			compactEditTool: false,
		},
		fixedBottomEditor: {
			enabled: true,
		},
		bottomStatus: {
			enabled: false,
		},
		shortcuts: {
			stashEditor: "alt+s",
			copyEditor: "ctrl+alt+c",
			cutEditor: "ctrl+alt+x",
			scrollChatUp: "super+up",
			scrollChatDown: "super+down",
			editorStart: "super+shift+up",
			editorEnd: "super+shift+down",
			jumpPreviousUserMessage: "ctrl+shift+u",
			jumpNextUserMessage: "ctrl+shift+i",
			jumpPreviousAssistantMessage: "ctrl+alt+,",
			jumpNextAssistantMessage: "ctrl+alt+.",
			jumpChatBottom: "ctrl+shift+g",
		},
	});
});
