/** 功能：验证 Alps Pi 设置持久化读写 实现者：alps 实现日期：2026-05-27 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cloneStartupSettings, PI_SETTINGS_NAMESPACE, readNamespacedPiSettings, readPersistedSettings, writeNamespacedPiSettings, writePersistedSettings } from "../src/settings-store.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";

test("启动默认设置固定输入框和美化输入框开启", () => {
	const settings = cloneStartupSettings();

	assert.equal(settings.chromeFrame.enabled, true);
	assert.equal(settings.chromeFrame.toolCompactMode, true);
	assert.equal(settings.chromeFrame.compactEditTool, false);
	assert.equal(settings.fixedBottomEditor.enabled, true);
	assert.equal(settings.beautifiedInput.enabled, true);
	assert.equal("bottomStatus" in settings, false);
});

test("读写持久化设置并合并缺失字段", () => {
	const dir = mkdtempSync(join(tmpdir(), "alps-pi-settings-"));
	const file = join(dir, "settings.json");
	try {
		const settings = cloneStartupSettings();
		settings.chromeFrame.toolCompactMode = false;
		settings.chromeFrame.compactEditTool = true;
		settings.fixedBottomEditor.enabled = false;
		settings.beautifiedInput.enabled = false;
		writePersistedSettings(settings, file);

		const raw = JSON.parse(readFileSync(file, "utf-8"));
		assert.equal(raw.bottomStatus, undefined);
		const loaded = readPersistedSettings(file);
		assert.equal(loaded.fixedBottomEditor.enabled, false);
		assert.equal(loaded.beautifiedInput.enabled, false);
		assert.equal("bottomStatus" in loaded, false);
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

test("Pi 原生 settings 的 alps-pi 命名空间可读写且保留其它字段并丢弃 bottomStatus", () => {
	const dir = mkdtempSync(join(tmpdir(), "alps-pi-settings-"));
	const file = join(dir, "settings.json");
	try {
		writeFileSync(file, JSON.stringify({ theme: "dark", showHardwareCursor: true }), "utf-8");
		const settings = cloneStartupSettings();
		settings.beautifiedInput.enabled = false;

		writeNamespacedPiSettings(settings, file);

		const root = JSON.parse(readFileSync(file, "utf-8"));
		assert.equal(root.theme, "dark");
		assert.equal(root.showHardwareCursor, true);
		assert.equal(root[PI_SETTINGS_NAMESPACE].beautifiedInput.enabled, false);
		assert.equal(root[PI_SETTINGS_NAMESPACE].bottomStatus, undefined);
		assert.equal(root.alpsPi, undefined);
		assert.equal(readNamespacedPiSettings(file).beautifiedInput.enabled, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Pi 原生 settings 缺少 alps-pi 时从独立文件迁移并忽略 bottomStatus", () => {
	const dir = mkdtempSync(join(tmpdir(), "alps-pi-settings-"));
	const piFile = join(dir, "settings.json");
	const legacyFile = join(dir, "legacy-settings.json");
	try {
		writeFileSync(piFile, JSON.stringify({ theme: "dark" }), "utf-8");
		writeFileSync(legacyFile, JSON.stringify({ fixedBottomEditor: { enabled: false }, beautifiedInput: { enabled: false }, bottomStatus: { enabled: true } }), "utf-8");

		const loaded = readNamespacedPiSettings(piFile, legacyFile);

		assert.equal(loaded.fixedBottomEditor.enabled, false);
		assert.equal(loaded.beautifiedInput.enabled, false);
		assert.equal("bottomStatus" in loaded, false);
		const root = JSON.parse(readFileSync(piFile, "utf-8"));
		assert.equal(root.theme, "dark");
		assert.equal(root[PI_SETTINGS_NAMESPACE].fixedBottomEditor.enabled, false);
		assert.equal(root[PI_SETTINGS_NAMESPACE].beautifiedInput.enabled, false);
		assert.equal(root[PI_SETTINGS_NAMESPACE].bottomStatus, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("测试隔离路径存在时不碰 Pi 原生 settings 文件", () => {
	const dir = mkdtempSync(join(tmpdir(), "alps-pi-settings-"));
	const isolatedFile = join(dir, "isolated.json");
	const piFile = join(dir, "settings.json");
	const previous = process.env.ALPS_PI_SETTINGS_PATH;
	try {
		process.env.ALPS_PI_SETTINGS_PATH = isolatedFile;
		writeFileSync(piFile, JSON.stringify({ theme: "dark" }), "utf-8");
		const settings = cloneStartupSettings();
		settings.beautifiedInput.enabled = false;

		writePersistedSettings(settings);

		assert.equal(existsSync(isolatedFile), true);
		assert.equal(JSON.parse(readFileSync(isolatedFile, "utf-8")).bottomStatus, undefined);
		assert.deepEqual(JSON.parse(readFileSync(piFile, "utf-8")), { theme: "dark" });
	} finally {
		if (previous === undefined) delete process.env.ALPS_PI_SETTINGS_PATH;
		else process.env.ALPS_PI_SETTINGS_PATH = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
