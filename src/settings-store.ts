/** 功能：独立、原子且跨进程安全地持久化 Alps Pi 用户设置。 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { cloneDefaultSettings, type AlpsPiSettings } from "./settings.ts";
import { normalizeAnimationsSettings } from "./features/animations/settings.ts";
import { normalizeInputMetricsSettings } from "./features/bottom-input/metrics.ts";
import { normalizeShortcut, shortcutConflictKey, shortcutUsesSuper, isSupportedSuperShortcut, RESERVED_BOTTOM_INPUT_SHORTCUTS, SHORTCUT_KEYS } from "./features/bottom-input/shortcuts.ts";

const SETTINGS_ENV = "ALPS_PI_SETTINGS_PATH";
export const PI_SETTINGS_NAMESPACE = "alps-pi";
let tempSequence = 0;
const lastReadSnapshots = new Map<string, AlpsPiSettings>();
const objectBaselines = new WeakMap<object, AlpsPiSettings>();

export type SettingsSourcePaths = {
	primary: string;
	piSettings: string;
	legacy: string;
};

export function cloneStartupSettings(): AlpsPiSettings {
	const settings = cloneDefaultSettings();
	settings.chromeFrame.enabled = true;
	settings.fixedBottomEditor.enabled = true;
	settings.beautifiedInput.enabled = true;
	settings.footer.enabled = true;
	settings.animations.enabled = true;
	return settings;
}

/** 0.2.0 主设置路径。 */
export function getSettingsPath(): string {
	return getIsolatedSettingsPath() ?? join(getAgentDir(), "alps-pi", "settings.json");
}

export function getPiSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** 最早期单文件安装的兼容 fallback；读取后迁移到主路径。 */
export function getLegacySettingsPath(): string {
	return join(getAgentDir(), "alps-pi.json");
}

export function getDefaultSettingsSourcePaths(): SettingsSourcePaths {
	return {
		primary: getSettingsPath(),
		piSettings: getPiSettingsPath(),
		legacy: getLegacySettingsPath(),
	};
}

export function readPersistedSettings(path?: string): AlpsPiSettings {
	const isolatedPath = path ?? getIsolatedSettingsPath();
	if (isolatedPath) return rememberRead(isolatedPath, readStandaloneSettings(isolatedPath, cloneStartupSettings()));
	return readPersistedSettingsFromPaths(getDefaultSettingsSourcePaths());
}

/** 严格按主文件 → Pi namespace → 旧独立文件 → 默认值读取，并非破坏性迁移。 */
export function readPersistedSettingsFromPaths(paths: SettingsSourcePaths): AlpsPiSettings {
	const defaults = cloneStartupSettings();
	const primary = readStandaloneSettingsIfExists(paths.primary, defaults);
	if (primary) return rememberRead(paths.primary, primary);

	const namespace = readNamespaceFromPiFile(paths.piSettings, defaults);
	if (namespace) {
		writeStandaloneSettings(namespace, paths.primary, defaults);
		return rememberRead(paths.primary, namespace);
	}

	const legacy = readStandaloneSettingsIfExists(paths.legacy, defaults);
	if (legacy) {
		writeStandaloneSettings(legacy, paths.primary, defaults);
		return rememberRead(paths.primary, legacy);
	}

	return rememberRead(paths.primary, defaults);
}

/** 所有运行时写入只落到独立主文件；namespace 仅作为迁移来源。 */
export function writePersistedSettings(settings: AlpsPiSettings, path?: string): void {
	const target = path ?? getSettingsPath();
	const baseline = objectBaselines.get(settings as object) ?? lastReadSnapshots.get(target) ?? cloneStartupSettings();
	const merged = writeStandaloneSettings(settings, target, baseline);
	lastReadSnapshots.set(target, cloneSettings(merged));
	objectBaselines.set(settings as object, cloneSettings(merged));
}

/** 将运行时 tracked settings 对象与本次磁盘读取快照关联，供字段级并发合并。 */
export function trackSettingsBaseline(settings: AlpsPiSettings, baseline: AlpsPiSettings): void {
	objectBaselines.set(settings as object, cloneSettings(baseline));
}

/** 只读 Pi namespace；保留旧导出名供迁移测试和外部诊断。 */
export function readNamespacedPiSettings(piSettingsPath: string, legacySettingsPath = getLegacySettingsPath()): AlpsPiSettings {
	const defaults = cloneStartupSettings();
	return readNamespaceFromPiFile(piSettingsPath, defaults)
		?? readStandaloneSettingsIfExists(legacySettingsPath, defaults)
		?? defaults;
}

export function cloneSettings(settings: AlpsPiSettings): AlpsPiSettings {
	return {
		chromeFrame: { ...settings.chromeFrame },
		fixedBottomEditor: { ...settings.fixedBottomEditor },
		beautifiedInput: { ...settings.beautifiedInput },
		inputMetrics: { ...settings.inputMetrics },
		footer: { ...settings.footer },
		animations: { ...settings.animations },
		shortcuts: { ...settings.shortcuts },
	};
}

function getIsolatedSettingsPath(): string | undefined {
	return process.env[SETTINGS_ENV]?.trim() || undefined;
}

function rememberRead(path: string, settings: AlpsPiSettings): AlpsPiSettings {
	const snapshot = cloneSettings(settings);
	const result = cloneSettings(snapshot);
	lastReadSnapshots.set(path, snapshot);
	objectBaselines.set(result as object, cloneSettings(snapshot));
	return result;
}

function readStandaloneSettings(path: string, defaults: AlpsPiSettings): AlpsPiSettings {
	return readStandaloneSettingsIfExists(path, defaults) ?? cloneSettings(defaults);
}

function readStandaloneSettingsIfExists(path: string, defaults: AlpsPiSettings): AlpsPiSettings | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return normalizeSettings(JSON.parse(readFileSync(path, "utf-8")), defaults);
	} catch (error) {
		console.debug?.(`[alps-pi] Failed to read settings from ${path}:`, error);
		return undefined;
	}
}

function readNamespaceFromPiFile(path: string, defaults: AlpsPiSettings): AlpsPiSettings | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const root = JSON.parse(readFileSync(path, "utf-8"));
		if (!isRecord(root) || root[PI_SETTINGS_NAMESPACE] === undefined) return undefined;
		return normalizeSettings(root[PI_SETTINGS_NAMESPACE], defaults);
	} catch (error) {
		console.debug?.(`[alps-pi] Failed to read settings namespace from ${path}:`, error);
		return undefined;
	}
}

function writeStandaloneSettings(settings: AlpsPiSettings, path: string, baseline: AlpsPiSettings): AlpsPiSettings {
	mkdirSync(dirname(path), { recursive: true });
	let release: (() => void) | undefined;
	try {
		release = acquireSettingsLock(path);
		const current = readStandaloneSettingsIfExists(path, cloneStartupSettings()) ?? cloneStartupSettings();
		const merged = mergeChangedSettings(current, baseline, settings);
		atomicWriteJson(path, cloneSettings(merged));
		return merged;
	} catch (error) {
		console.debug?.(`[alps-pi] Failed to write settings to ${path}:`, error);
		return cloneSettings(settings);
	} finally {
		try {
			release?.();
		} catch {
			// stale lock cleanup must not break settings UI.
		}
	}
}

function acquireSettingsLock(path: string): () => void {
	const waitArray = new Int32Array(new SharedArrayBuffer(4));
	let lastError: unknown;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			return lockfile.lockSync(path, { realpath: false, stale: 10_000, update: 2_000 });
		} catch (error) {
			lastError = error;
			if ((error as NodeJS.ErrnoException)?.code !== "ELOCKED") throw error;
			Atomics.wait(waitArray, 0, 0, Math.min(100, 10 + attempt * 2));
		}
	}
	throw lastError;
}

function mergeChangedSettings(current: AlpsPiSettings, baseline: AlpsPiSettings, next: AlpsPiSettings): AlpsPiSettings {
	const merged = cloneSettings(current);
	for (const section of ["chromeFrame", "fixedBottomEditor", "beautifiedInput", "inputMetrics", "footer", "animations", "shortcuts"] as const) {
		const baselineSection = baseline[section] as Record<string, unknown>;
		const nextSection = next[section] as Record<string, unknown>;
		const mergedSection = merged[section] as Record<string, unknown>;
		for (const [key, value] of Object.entries(nextSection)) {
			if (!Object.is(value, baselineSection[key])) mergedSection[key] = value;
		}
	}
	return normalizeSettings(merged, cloneStartupSettings());
}

function atomicWriteJson(path: string, value: unknown): void {
	const tempPath = join(dirname(path), `.${process.pid}-${++tempSequence}-${path.split(/[\\/]/).at(-1)}.tmp`);
	try {
		writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
		renameSync(tempPath, path);
	} finally {
		rmSync(tempPath, { force: true });
	}
}

function normalizeSettings(value: unknown, defaults: AlpsPiSettings): AlpsPiSettings {
	const raw = isRecord(value) ? value : {};
	return {
		chromeFrame: {
			enabled: readBoolean(raw.chromeFrame, "enabled", defaults.chromeFrame.enabled),
			assistantFrame: readBoolean(raw.chromeFrame, "assistantFrame", defaults.chromeFrame.assistantFrame),
			toolCompactMode: readBoolean(raw.chromeFrame, "toolCompactMode", defaults.chromeFrame.toolCompactMode),
			compactEditTool: readBoolean(raw.chromeFrame, "compactEditTool", defaults.chromeFrame.compactEditTool),
		},
		fixedBottomEditor: {
			enabled: readBoolean(raw.fixedBottomEditor, "enabled", defaults.fixedBottomEditor.enabled),
		},
		beautifiedInput: {
			enabled: readBoolean(raw.beautifiedInput, "enabled", defaults.beautifiedInput.enabled),
		},
		inputMetrics: normalizeInputMetricsSettings(raw.inputMetrics, defaults.inputMetrics),
		footer: {
			enabled: readBoolean(raw.footer, "enabled", defaults.footer.enabled),
		},
		animations: normalizeAnimationsSettings(raw.animations, defaults.animations),
		shortcuts: normalizeShortcutSettings(raw.shortcuts, defaults.shortcuts),
	};
}

function normalizeShortcutSettings(parent: unknown, defaults: AlpsPiSettings["shortcuts"]): AlpsPiSettings["shortcuts"] {
	const result = { ...defaults };
	if (!isRecord(parent)) return result;
	const occupied = new Set(SHORTCUT_KEYS.map((key) => shortcutConflictKey(defaults[key])));
	for (const key of SHORTCUT_KEYS) {
		const value = parent[key];
		if (typeof value !== "string") continue;
		const normalized = normalizeShortcut(value);
		if (!normalized || isReservedShortcut(normalized)) continue;
		if (shortcutUsesSuper(normalized) && !isSupportedSuperShortcut(normalized)) continue;
		const defaultConflictKey = shortcutConflictKey(defaults[key]);
		const nextConflictKey = shortcutConflictKey(normalized);
		occupied.delete(defaultConflictKey);
		if (occupied.has(nextConflictKey)) {
			occupied.add(defaultConflictKey);
			continue;
		}
		result[key] = normalized;
		occupied.add(nextConflictKey);
	}
	return result;
}

function isReservedShortcut(shortcut: string): boolean {
	return RESERVED_BOTTOM_INPUT_SHORTCUTS.has(shortcutConflictKey(shortcut));
}

function readBoolean(parent: unknown, key: string, fallback: boolean): boolean {
	if (!isRecord(parent)) return fallback;
	return typeof parent[key] === "boolean" ? parent[key] : fallback;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
