/** 功能：验证 Alps Pi 设置持久化读写 实现者：alps 实现日期：2026-05-27 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cloneStartupSettings, readPersistedSettings, writePersistedSettings } from "../src/settings-store.ts";

test("启动默认设置固定输入框开启，底部状态栏关闭", () => {
	const settings = cloneStartupSettings();

	assert.equal(settings.chromeFrame.enabled, true);
	assert.equal(settings.fixedBottomEditor.enabled, true);
	assert.equal(settings.bottomStatus.enabled, false);
});

test("读写持久化设置并合并缺失字段", () => {
	const dir = mkdtempSync(join(tmpdir(), "alps-pi-settings-"));
	const file = join(dir, "settings.json");
	try {
		const settings = cloneStartupSettings();
		settings.fixedBottomEditor.enabled = false;
		settings.bottomStatus.enabled = true;
		writePersistedSettings(settings, file);

		const loaded = readPersistedSettings(file);
		assert.equal(loaded.fixedBottomEditor.enabled, false);
		assert.equal(loaded.bottomStatus.enabled, true);
		assert.equal(loaded.chromeFrame.assistantFrame, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
