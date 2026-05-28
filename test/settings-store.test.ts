/** 功能：验证 Alps Pi 设置持久化读写 实现者：alps 实现日期：2026-05-27 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cloneStartupSettings, readPersistedSettings, writePersistedSettings } from "../src/settings-store.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";

test("启动默认设置固定输入框开启，底部状态栏关闭", () => {
	const settings = cloneStartupSettings();

	assert.equal(settings.chromeFrame.enabled, true);
	assert.equal(settings.chromeFrame.toolCompactMode, true);
	assert.equal(settings.chromeFrame.compactEditTool, false);
	assert.equal(settings.fixedBottomEditor.enabled, true);
	assert.equal(settings.bottomStatus.enabled, false);
});

test("读写持久化设置并合并缺失字段", () => {
	const dir = mkdtempSync(join(tmpdir(), "alps-pi-settings-"));
	const file = join(dir, "settings.json");
	try {
		const settings = cloneStartupSettings();
		settings.chromeFrame.toolCompactMode = false;
		settings.chromeFrame.compactEditTool = true;
		settings.fixedBottomEditor.enabled = false;
		settings.bottomStatus.enabled = true;
		writePersistedSettings(settings, file);

		const loaded = readPersistedSettings(file);
		assert.equal(loaded.fixedBottomEditor.enabled, false);
		assert.equal(loaded.bottomStatus.enabled, true);
		assert.equal(loaded.chromeFrame.assistantFrame, true);
		assert.equal(loaded.chromeFrame.toolCompactMode, false);
		assert.equal(loaded.chromeFrame.compactEditTool, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("读取持久化快捷键时过滤保留键、重复键和不支持的 Super 键", () => {
	const dir = mkdtempSync(join(tmpdir(), "alps-pi-settings-"));
	const file = join(dir, "settings.json");
	try {
		writeFileSync(file, JSON.stringify({
			shortcuts: {
				copyEditor: "ctrl+c",
				cutEditor: "ctrl+alt+c",
				scrollChatUp: "super+a",
				jumpChatBottom: "ctrl+alt+g",
				jumpNextUserMessage: "ctrl+shift+p",
				jumpNextAssistantMessage: "shift+ctrl+o",
			},
		}), "utf-8");

		const loaded = readPersistedSettings(file);
		assert.equal(loaded.shortcuts.copyEditor, DEFAULT_SETTINGS.shortcuts.copyEditor);
		assert.equal(loaded.shortcuts.cutEditor, DEFAULT_SETTINGS.shortcuts.cutEditor);
		assert.equal(loaded.shortcuts.scrollChatUp, DEFAULT_SETTINGS.shortcuts.scrollChatUp);
		assert.equal(loaded.shortcuts.jumpChatBottom, "ctrl+alt+g");
		assert.equal(loaded.shortcuts.jumpNextUserMessage, DEFAULT_SETTINGS.shortcuts.jumpNextUserMessage);
		assert.equal(loaded.shortcuts.jumpNextAssistantMessage, DEFAULT_SETTINGS.shortcuts.jumpNextAssistantMessage);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("完整默认快捷键持久化不会被误拒绝", () => {
	const dir = mkdtempSync(join(tmpdir(), "alps-pi-settings-"));
	const file = join(dir, "settings.json");
	try {
		writeFileSync(file, JSON.stringify({ shortcuts: DEFAULT_SETTINGS.shortcuts }), "utf-8");

		const loaded = readPersistedSettings(file);
		assert.deepEqual(loaded.shortcuts, DEFAULT_SETTINGS.shortcuts);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
