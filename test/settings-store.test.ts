/** 功能：验证 0.2.0 独立设置的优先级、迁移、锁与原子写入。 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
	PI_SETTINGS_NAMESPACE,
	cloneStartupSettings,
	readPersistedSettings,
	readPersistedSettingsFromPaths,
	writePersistedSettings,
} from "../src/settings-store.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";

function tempPaths() {
	const dir = mkdtempSync(join(tmpdir(), "alps-pi-settings-"));
	return {
		dir,
		primary: join(dir, "alps-pi", "settings.json"),
		piSettings: join(dir, "settings.json"),
		legacy: join(dir, "alps-pi.json"),
	};
}

function writeJson(path: string, value: unknown) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}

function readJson(path: string) {
	return JSON.parse(readFileSync(path, "utf-8"));
}

test("启动默认设置保留 legacy fixed 字段且现代功能默认开启", () => {
	const settings = cloneStartupSettings();
	assert.equal(settings.chromeFrame.enabled, true);
	assert.equal(settings.fixedBottomEditor.enabled, true);
	assert.equal(settings.beautifiedInput.enabled, true);
	assert.deepEqual(settings.inputMetrics, {
		inputTokens: true,
		outputTokens: true,
		cacheHit: true,
		tokenSpeed: true,
		elapsedTime: true,
	});
	assert.equal(settings.footer.enabled, true);
	assert.equal(settings.animations.enabled, true);
	assert.equal("bottomStatus" in settings, false);
});

test("显式独立路径读写使用锁与原子 JSON 并合并缺失字段", () => {
	const { dir, primary } = tempPaths();
	try {
		const settings = cloneStartupSettings();
		settings.chromeFrame.toolCompactMode = "off";
		settings.fixedBottomEditor.enabled = false;
		settings.beautifiedInput.enabled = false;
		settings.inputMetrics.cacheHit = false;
		settings.inputMetrics.elapsedTime = false;
		settings.footer.enabled = false;
		settings.animations.thinking = "aurora";
		writePersistedSettings(settings, primary);
		const raw = readJson(primary);
		assert.equal(raw.bottomStatus, undefined);
		assert.equal(existsSync(`${primary}.lock`), false);
		assert.equal(readPersistedSettings(primary).fixedBottomEditor.enabled, false);
		assert.equal(readPersistedSettings(primary).footer.enabled, false);
		assert.equal(readPersistedSettings(primary).inputMetrics.cacheHit, false);
		assert.equal(readPersistedSettings(primary).inputMetrics.elapsedTime, false);
		assert.equal(readPersistedSettings(primary).animations.thinking, "aurora");
		assert.equal(readPersistedSettings(primary).chromeFrame.assistantFrame, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("四级读取优先级严格为 primary → namespace → legacy → defaults", () => {
	for (const source of ["primary", "namespace", "legacy", "defaults"] as const) {
		const paths = tempPaths();
		try {
			writeJson(paths.piSettings, {
				theme: "alps",
				[PI_SETTINGS_NAMESPACE]: { beautifiedInput: { enabled: source === "namespace" ? false : true } },
			});
			writeJson(paths.legacy, { beautifiedInput: { enabled: source === "legacy" ? false : true } });
			if (source === "primary") writeJson(paths.primary, { beautifiedInput: { enabled: false } });
			if (source === "legacy" || source === "defaults") writeJson(paths.piSettings, { theme: "alps" });
			if (source === "defaults") rmSync(paths.legacy, { force: true });
			const piBefore = readFileSync(paths.piSettings, "utf-8");

			const loaded = readPersistedSettingsFromPaths(paths);
			assert.equal(loaded.beautifiedInput.enabled, source === "defaults" ? true : false, source);
			assert.equal(readFileSync(paths.piSettings, "utf-8"), piBefore);
			if (source === "namespace" || source === "legacy") assert.equal(readJson(paths.primary).beautifiedInput.enabled, false);
			if (source === "defaults") assert.equal(existsSync(paths.primary), false);
		} finally {
			rmSync(paths.dir, { recursive: true, force: true });
		}
	}
});

test("Tool 展示模式兼容旧布尔值并保留显式三态", () => {
	const { dir, primary } = tempPaths();
	try {
		for (const [raw, expected] of [
			[true, "compact"],
			[false, "off"],
			["off", "off"],
			["compact", "compact"],
			["collapsed", "collapsed"],
			["invalid", "compact"],
		] as const) {
			writeJson(primary, { chromeFrame: { toolCompactMode: raw } });
			assert.equal(readPersistedSettings(primary).chromeFrame.toolCompactMode, expected);
		}
		writeJson(primary, { chromeFrame: {} });
		assert.equal(readPersistedSettings(primary).chromeFrame.toolCompactMode, "compact");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("旧配置缺少 Footer 和 Input Metrics 时默认开启，显式 false 保留", () => {
	const { dir, primary } = tempPaths();
	try {
		writeJson(primary, { beautifiedInput: { enabled: false } });
		assert.equal(readPersistedSettings(primary).footer.enabled, true);
		assert.deepEqual(readPersistedSettings(primary).inputMetrics, DEFAULT_SETTINGS.inputMetrics);
		writeJson(primary, { footer: { enabled: false }, inputMetrics: { inputTokens: false, cacheHit: "invalid" } });
		const loaded = readPersistedSettings(primary);
		assert.equal(loaded.footer.enabled, false);
		assert.equal(loaded.inputMetrics.inputTokens, false);
		assert.equal(loaded.inputMetrics.cacheHit, true);
		assert.equal(loaded.inputMetrics.elapsedTime, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("primary 存在时不读取或改写 namespace/legacy", () => {
	const paths = tempPaths();
	try {
		writeJson(paths.primary, { fixedBottomEditor: { enabled: false }, beautifiedInput: { enabled: false } });
		writeJson(paths.piSettings, { [PI_SETTINGS_NAMESPACE]: { fixedBottomEditor: { enabled: true }, beautifiedInput: { enabled: true } } });
		writeJson(paths.legacy, { fixedBottomEditor: { enabled: true }, beautifiedInput: { enabled: true } });
		const beforePi = readFileSync(paths.piSettings, "utf-8");
		const beforeLegacy = readFileSync(paths.legacy, "utf-8");
		const loaded = readPersistedSettingsFromPaths(paths);
		assert.equal(loaded.fixedBottomEditor.enabled, false);
		assert.equal(loaded.beautifiedInput.enabled, false);
		assert.equal(readFileSync(paths.piSettings, "utf-8"), beforePi);
		assert.equal(readFileSync(paths.legacy, "utf-8"), beforeLegacy);
	} finally {
		rmSync(paths.dir, { recursive: true, force: true });
	}
});

test("同进程两个陈旧快照只合并各自改变字段", () => {
	const { dir, primary } = tempPaths();
	try {
		writePersistedSettings(cloneStartupSettings(), primary);
		const first = readPersistedSettings(primary);
		const second = readPersistedSettings(primary);
		first.chromeFrame.assistantFrame = false;
		first.inputMetrics.tokenSpeed = false;
		second.beautifiedInput.enabled = false;
		writePersistedSettings(first, primary);
		writePersistedSettings(second, primary);
		const loaded = readPersistedSettings(primary);
		assert.equal(loaded.chromeFrame.assistantFrame, false);
		assert.equal(loaded.beautifiedInput.enabled, false);
		assert.equal(loaded.inputMetrics.tokenSpeed, false);
		assert.equal(loaded.fixedBottomEditor.enabled, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("多进程压力写入保留每个独立字段且不留 lock/tmp", async () => {
	const { dir, primary } = tempPaths();
	try {
		const worker = resolve(import.meta.dirname, "settings-writer-worker.ts");
		const specs = [
			["chromeFrame", "assistantFrame", "false"],
			["beautifiedInput", "enabled", "false"],
			["footer", "enabled", "false"],
			["inputMetrics", "outputTokens", "false"],
			["animations", "randomMode", "true"],
			["animations", "fps", "24"],
			["shortcuts", "copyEditor", "\"ctrl+alt+g\""],
		] as const;
		for (let round = 0; round < 3; round += 1) {
			writeJson(primary, cloneStartupSettings());
			const go = join(dir, `go-${round}`);
			const children = specs.map(([section, key, value], index) => {
				const ready = join(dir, `ready-${round}-${index}`);
				const child = spawn(process.execPath, ["--experimental-strip-types", worker, primary, ready, go, section, key, value], { stdio: "inherit" });
				return { child, ready };
			});
			const waitArray = new Int32Array(new SharedArrayBuffer(4));
			const deadline = Date.now() + 15_000;
			while (children.some(({ ready }) => !existsSync(ready)) && Date.now() < deadline) Atomics.wait(waitArray, 0, 0, 20);
			assert.ok(children.every(({ ready }) => existsSync(ready)), `round ${round} workers did not reach shared baseline`);
			writeFileSync(go, "go", "utf-8");
			await Promise.all(children.map(({ child }) => new Promise<void>((resolvePromise, reject) => {
				child.once("error", reject);
				child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`worker exit ${code}`)));
			})));
			const raw = readJson(primary);
			assert.equal(raw.chromeFrame.assistantFrame, false);
			assert.equal(raw.beautifiedInput.enabled, false);
			assert.equal(raw.footer.enabled, false);
			assert.equal(raw.inputMetrics.outputTokens, false);
			assert.equal(raw.animations.randomMode, true);
			assert.equal(raw.animations.fps, 24);
			assert.equal(raw.shortcuts.copyEditor, "ctrl+alt+g");
			assert.equal(raw.fixedBottomEditor.enabled, true);
			assert.equal(existsSync(`${primary}.lock`), false);
			assert.equal(readdirSync(dirname(primary)).some((name) => name.endsWith(".tmp")), false);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("测试隔离路径只写独立文件，不触碰 Pi settings", () => {
	const paths = tempPaths();
	const previous = process.env.ALPS_PI_SETTINGS_PATH;
	try {
		process.env.ALPS_PI_SETTINGS_PATH = paths.primary;
		writeJson(paths.piSettings, { theme: "dark" });
		const settings = cloneStartupSettings();
		settings.beautifiedInput.enabled = false;
		writePersistedSettings(settings);
		assert.equal(readJson(paths.primary).beautifiedInput.enabled, false);
		assert.deepEqual(readJson(paths.piSettings), { theme: "dark" });
	} finally {
		if (previous === undefined) delete process.env.ALPS_PI_SETTINGS_PATH;
		else process.env.ALPS_PI_SETTINGS_PATH = previous;
		rmSync(paths.dir, { recursive: true, force: true });
	}
});

test("旧快捷键字段保持可读但 UI 只使用现代 editor/input 子集", () => {
	const { dir, primary } = tempPaths();
	try {
		writeJson(primary, { shortcuts: { ...DEFAULT_SETTINGS.shortcuts, jumpChatBottom: "ctrl+alt+g" } });
		const loaded = readPersistedSettings(primary);
		assert.equal(loaded.shortcuts.jumpChatBottom, "ctrl+alt+g");
		assert.equal(loaded.shortcuts.stashEditor, DEFAULT_SETTINGS.shortcuts.stashEditor);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
