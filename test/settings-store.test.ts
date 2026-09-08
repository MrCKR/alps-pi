/** 功能：验证 Pi settings namespace 的优先级、迁移、锁与原子写入。 */

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
		piSettings: join(dir, "settings.json"),
		standalone: join(dir, "alps-pi", "settings.json"),
		legacy: join(dir, "alps-pi.json"),
	};
}

function writeJson(path: string, value: unknown) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}

function readJson(path: string): any {
	return JSON.parse(readFileSync(path, "utf-8"));
}

function readNamespace(path: string): any {
	return readJson(path)[PI_SETTINGS_NAMESPACE];
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

test("Pi namespace 读写使用锁与原子 JSON 并保留宿主字段", () => {
	const { dir, piSettings } = tempPaths();
	try {
		writeJson(piSettings, { theme: "alps", extensions: ["npm:alps-pi"] });
		const settings = cloneStartupSettings();
		settings.chromeFrame.toolCompactMode = "off";
		settings.fixedBottomEditor.enabled = false;
		settings.beautifiedInput.enabled = false;
		settings.inputMetrics.cacheHit = false;
		settings.inputMetrics.elapsedTime = false;
		settings.footer.enabled = false;
		settings.animations.thinking = "aurora";
		writePersistedSettings(settings, piSettings);

		const root = readJson(piSettings);
		assert.equal(root.theme, "alps");
		assert.deepEqual(root.extensions, ["npm:alps-pi"]);
		assert.equal(root[PI_SETTINGS_NAMESPACE].bottomStatus, undefined);
		assert.equal(root[PI_SETTINGS_NAMESPACE]._storageVersion, 1);
		assert.equal(existsSync(`${piSettings}.lock`), false);
		assert.equal(readPersistedSettings(piSettings).fixedBottomEditor.enabled, false);
		assert.equal(readPersistedSettings(piSettings).footer.enabled, false);
		assert.equal(readPersistedSettings(piSettings).inputMetrics.cacheHit, false);
		assert.equal(readPersistedSettings(piSettings).inputMetrics.elapsedTime, false);
		assert.equal(readPersistedSettings(piSettings).animations.thinking, "aurora");
		assert.equal(readPersistedSettings(piSettings).chromeFrame.assistantFrame, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("读取优先级严格为当前 Pi namespace → 独立目录迁移 → 旧单文件 → defaults", () => {
	for (const source of ["namespace", "standalone", "legacy", "defaults"] as const) {
		const paths = tempPaths();
		try {
			writeJson(paths.piSettings, { theme: "alps" });
			if (source === "namespace") {
				const settings = cloneStartupSettings();
				settings.beautifiedInput.enabled = false;
				writePersistedSettings(settings, paths.piSettings);
				writeJson(paths.standalone, { beautifiedInput: { enabled: true } });
				writeJson(paths.legacy, { beautifiedInput: { enabled: true } });
			} else if (source === "standalone") {
				writeJson(paths.standalone, { beautifiedInput: { enabled: false } });
				writeJson(paths.legacy, { beautifiedInput: { enabled: true } });
			} else if (source === "legacy") {
				writeJson(paths.legacy, { beautifiedInput: { enabled: false } });
			}

			const loaded = readPersistedSettingsFromPaths(paths);
			assert.equal(loaded.beautifiedInput.enabled, source === "defaults", source);
			const persistedRoot = readJson(paths.piSettings);
			assert.equal(persistedRoot.theme, "alps");
			if (source === "defaults") assert.equal(persistedRoot[PI_SETTINGS_NAMESPACE], undefined);
			else assert.equal(persistedRoot[PI_SETTINGS_NAMESPACE].beautifiedInput.enabled, false);
			assert.equal(existsSync(paths.standalone), false);
			assert.equal(existsSync(paths.legacy), false);
		} finally {
			rmSync(paths.dir, { recursive: true, force: true });
		}
	}
});

test("Tool 展示模式兼容旧布尔值并保留显式三态", () => {
	const { dir, piSettings } = tempPaths();
	try {
		for (const [raw, expected] of [
			[true, "compact"],
			[false, "off"],
			["off", "off"],
			["compact", "compact"],
			["collapsed", "collapsed"],
			["invalid", "compact"],
		] as const) {
			writeJson(piSettings, { [PI_SETTINGS_NAMESPACE]: { chromeFrame: { toolCompactMode: raw } } });
			assert.equal(readPersistedSettings(piSettings).chromeFrame.toolCompactMode, expected);
		}
		writeJson(piSettings, { [PI_SETTINGS_NAMESPACE]: { chromeFrame: {} } });
		assert.equal(readPersistedSettings(piSettings).chromeFrame.toolCompactMode, "compact");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("旧配置缺少 Footer 和 Input Metrics 时默认开启，显式 false 保留", () => {
	const { dir, piSettings } = tempPaths();
	try {
		writeJson(piSettings, { [PI_SETTINGS_NAMESPACE]: { beautifiedInput: { enabled: false } } });
		assert.equal(readPersistedSettings(piSettings).footer.enabled, true);
		assert.deepEqual(readPersistedSettings(piSettings).inputMetrics, DEFAULT_SETTINGS.inputMetrics);
		writeJson(piSettings, {
			[PI_SETTINGS_NAMESPACE]: { footer: { enabled: false }, inputMetrics: { inputTokens: false, cacheHit: "invalid" } },
		});
		const loaded = readPersistedSettings(piSettings);
		assert.equal(loaded.footer.enabled, false);
		assert.equal(loaded.inputMetrics.inputTokens, false);
		assert.equal(loaded.inputMetrics.cacheHit, true);
		assert.equal(loaded.inputMetrics.elapsedTime, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("当前 namespace 为唯一来源并清理两个旧设置文件", () => {
	const paths = tempPaths();
	try {
		writeJson(paths.piSettings, { theme: "alps" });
		const current = cloneStartupSettings();
		current.fixedBottomEditor.enabled = false;
		current.beautifiedInput.enabled = false;
		writePersistedSettings(current, paths.piSettings);
		writeJson(paths.standalone, { fixedBottomEditor: { enabled: true }, beautifiedInput: { enabled: true } });
		writeJson(paths.legacy, { fixedBottomEditor: { enabled: true }, beautifiedInput: { enabled: true } });
		const loaded = readPersistedSettingsFromPaths(paths);
		assert.equal(loaded.fixedBottomEditor.enabled, false);
		assert.equal(loaded.beautifiedInput.enabled, false);
		assert.equal(readJson(paths.piSettings).theme, "alps");
		assert.equal(existsSync(paths.standalone), false);
		assert.equal(existsSync(paths.legacy), false);
	} finally {
		rmSync(paths.dir, { recursive: true, force: true });
	}
});

test("升级时独立主文件覆盖陈旧 namespace，之后只以 namespace 为准", () => {
	const paths = tempPaths();
	try {
		writeJson(paths.piSettings, {
			theme: "alps",
			[PI_SETTINGS_NAMESPACE]: { beautifiedInput: { enabled: false } },
		});
		writeJson(paths.standalone, { beautifiedInput: { enabled: true } });

		const migrated = readPersistedSettingsFromPaths(paths);
		assert.equal(migrated.beautifiedInput.enabled, true);
		assert.equal(readNamespace(paths.piSettings).beautifiedInput.enabled, true);
		assert.equal(readNamespace(paths.piSettings)._storageVersion, 1);
		assert.equal(existsSync(paths.standalone), false);

		writeJson(paths.standalone, { beautifiedInput: { enabled: false } });
		assert.equal(readPersistedSettingsFromPaths(paths).beautifiedInput.enabled, true);
		assert.equal(existsSync(paths.standalone), false);
	} finally {
		rmSync(paths.dir, { recursive: true, force: true });
	}
});

test("同进程两个陈旧快照只合并各自改变字段", () => {
	const { dir, piSettings } = tempPaths();
	try {
		writePersistedSettings(cloneStartupSettings(), piSettings);
		const first = readPersistedSettings(piSettings);
		const second = readPersistedSettings(piSettings);
		first.chromeFrame.assistantFrame = false;
		first.inputMetrics.tokenSpeed = false;
		second.beautifiedInput.enabled = false;
		writePersistedSettings(first, piSettings);
		writePersistedSettings(second, piSettings);
		const loaded = readPersistedSettings(piSettings);
		assert.equal(loaded.chromeFrame.assistantFrame, false);
		assert.equal(loaded.beautifiedInput.enabled, false);
		assert.equal(loaded.inputMetrics.tokenSpeed, false);
		assert.equal(loaded.fixedBottomEditor.enabled, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("多进程压力写入 namespace，保留宿主字段且不留 lock/tmp", async () => {
	const { dir, piSettings } = tempPaths();
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
			writeJson(piSettings, { theme: "alps", [PI_SETTINGS_NAMESPACE]: cloneStartupSettings() });
			const go = join(dir, `go-${round}`);
			const children = specs.map(([section, key, value], index) => {
				const ready = join(dir, `ready-${round}-${index}`);
				const child = spawn(process.execPath, ["--experimental-strip-types", worker, piSettings, ready, go, section, key, value], { stdio: "inherit" });
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
			const root = readJson(piSettings);
			const raw = root[PI_SETTINGS_NAMESPACE];
			assert.equal(root.theme, "alps");
			assert.equal(raw.chromeFrame.assistantFrame, false);
			assert.equal(raw.beautifiedInput.enabled, false);
			assert.equal(raw.footer.enabled, false);
			assert.equal(raw.inputMetrics.outputTokens, false);
			assert.equal(raw.animations.randomMode, true);
			assert.equal(raw.animations.fps, 24);
			assert.equal(raw.shortcuts.copyEditor, "ctrl+alt+g");
			assert.equal(raw.fixedBottomEditor.enabled, true);
			assert.equal(existsSync(`${piSettings}.lock`), false);
			assert.equal(readdirSync(dirname(piSettings)).some((name) => name.endsWith(".tmp")), false);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ALPS_PI_SETTINGS_PATH 指向测试用 Pi settings 根文件", () => {
	const paths = tempPaths();
	const previous = process.env.ALPS_PI_SETTINGS_PATH;
	try {
		process.env.ALPS_PI_SETTINGS_PATH = paths.piSettings;
		writeJson(paths.piSettings, { theme: "dark" });
		const settings = cloneStartupSettings();
		settings.beautifiedInput.enabled = false;
		writePersistedSettings(settings);
		const root = readJson(paths.piSettings);
		assert.equal(root.theme, "dark");
		assert.equal(root[PI_SETTINGS_NAMESPACE].beautifiedInput.enabled, false);
	} finally {
		if (previous === undefined) delete process.env.ALPS_PI_SETTINGS_PATH;
		else process.env.ALPS_PI_SETTINGS_PATH = previous;
		rmSync(paths.dir, { recursive: true, force: true });
	}
});

test("损坏的 Pi settings 不被覆盖，旧设置保留供恢复", () => {
	const paths = tempPaths();
	const previousDebug = console.debug;
	try {
		console.debug = () => {};
		writeFileSync(paths.piSettings, "{ broken", "utf-8");
		writeJson(paths.standalone, { beautifiedInput: { enabled: false } });
		const loaded = readPersistedSettingsFromPaths(paths);
		assert.equal(loaded.beautifiedInput.enabled, false);
		assert.equal(readFileSync(paths.piSettings, "utf-8"), "{ broken");
		assert.equal(existsSync(paths.standalone), true);
		writePersistedSettings(loaded, paths.piSettings);
		assert.equal(readFileSync(paths.piSettings, "utf-8"), "{ broken");
		assert.equal(existsSync(paths.standalone), true);
	} finally {
		console.debug = previousDebug;
		rmSync(paths.dir, { recursive: true, force: true });
	}
});

test("旧快捷键字段保持可读但 UI 只使用现代 editor/input 子集", () => {
	const { dir, piSettings } = tempPaths();
	try {
		writeJson(piSettings, {
			[PI_SETTINGS_NAMESPACE]: { shortcuts: { ...DEFAULT_SETTINGS.shortcuts, jumpChatBottom: "ctrl+alt+g" } },
		});
		const loaded = readPersistedSettings(piSettings);
		assert.equal(loaded.shortcuts.jumpChatBottom, "ctrl+alt+g");
		assert.equal(loaded.shortcuts.stashEditor, DEFAULT_SETTINGS.shortcuts.stashEditor);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
