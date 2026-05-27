/** 功能：验证 alps pi 默认设置模型 实现者：alps 实现日期：2026-05-27 */

import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, cloneDefaultSettings } from "../src/settings.ts";

test("固定输入框默认关闭", () => {
	assert.equal(DEFAULT_SETTINGS.fixedBottomEditor.enabled, false);
});

test("cloneDefaultSettings 返回包含固定输入框的新对象", () => {
	const cloned = cloneDefaultSettings();
	assert.notEqual(cloned, DEFAULT_SETTINGS);
	assert.notEqual(cloned.chromeFrame, DEFAULT_SETTINGS.chromeFrame);
	assert.notEqual(cloned.fixedBottomEditor, DEFAULT_SETTINGS.fixedBottomEditor);
	assert.deepEqual(cloned, {
		chromeFrame: {
			enabled: false,
			assistantFrame: true,
		},
		fixedBottomEditor: {
			enabled: false,
		},
	});
});
