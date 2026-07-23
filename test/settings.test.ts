/** 功能：验证 alps pi 默认设置模型 实现者：alps 实现日期：2026-05-27 */

import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, cloneDefaultSettings } from "../src/settings.ts";

test("默认开启消息线框和 Tool 极简模式且默认不收起 edit", () => {
	assert.equal(DEFAULT_SETTINGS.chromeFrame.enabled, true);
	assert.equal(DEFAULT_SETTINGS.chromeFrame.assistantFrameStyle, "box");
	assert.equal(DEFAULT_SETTINGS.chromeFrame.toolCompactMode, true);
	assert.equal(DEFAULT_SETTINGS.chromeFrame.compactEditTool, false);
});

test("固定输入框、美化输入框和 Animations 默认开启且无 bottomStatus", () => {
	assert.equal(DEFAULT_SETTINGS.fixedBottomEditor.enabled, true);
	assert.equal(DEFAULT_SETTINGS.beautifiedInput.enabled, true);
	assert.equal(DEFAULT_SETTINGS.animations.enabled, true);
	assert.equal(DEFAULT_SETTINGS.animations.randomMode, false);
	assert.equal(DEFAULT_SETTINGS.animations.thinking, "shimmer");
	assert.equal(DEFAULT_SETTINGS.animations.working, "crush");
	assert.equal(DEFAULT_SETTINGS.animations.tool, "pipeline");
	assert.equal(DEFAULT_SETTINGS.animations.width, "default");
	assert.equal(DEFAULT_SETTINGS.animations.fps, 16);
	assert.equal("bottomStatus" in DEFAULT_SETTINGS, false);
});

test("cloneDefaultSettings 返回包含固定输入框和美化输入框的新对象", () => {
	const cloned = cloneDefaultSettings();
	assert.notEqual(cloned, DEFAULT_SETTINGS);
	assert.notEqual(cloned.chromeFrame, DEFAULT_SETTINGS.chromeFrame);
	assert.notEqual(cloned.fixedBottomEditor, DEFAULT_SETTINGS.fixedBottomEditor);
	assert.notEqual(cloned.beautifiedInput, DEFAULT_SETTINGS.beautifiedInput);
	assert.notEqual(cloned.animations, DEFAULT_SETTINGS.animations);
	assert.notEqual(cloned.shortcuts, DEFAULT_SETTINGS.shortcuts);
	assert.equal("bottomStatus" in cloned, false);
	assert.deepEqual(cloned, {
		chromeFrame: {
			enabled: true,
			assistantFrameStyle: "box",
			toolCompactMode: true,
			compactEditTool: false,
		},
		fixedBottomEditor: {
			enabled: true,
		},
		beautifiedInput: {
			enabled: true,
		},
		animations: {
			enabled: true,
			randomMode: false,
			working: "crush",
			thinking: "shimmer",
			tool: "pipeline",
			width: "default",
			fps: 16,
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
