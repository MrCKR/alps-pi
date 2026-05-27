/** 功能：验证 alps pi 默认设置模型 实现者：alps 实现日期：2026-05-27 */

import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, cloneDefaultSettings } from "../src/settings.ts";

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
	assert.deepEqual(cloned, {
		chromeFrame: {
			enabled: false,
			assistantFrame: true,
		},
		fixedBottomEditor: {
			enabled: true,
		},
		bottomStatus: {
			enabled: false,
		},
	});
});
