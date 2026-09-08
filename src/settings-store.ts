/** 功能：在 Pi 原生 settings.json 的独立命名空间中原子、跨进程安全地持久化 Alps Pi 设置。 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { cloneDefaultSettings, normalizeToolDisplayMode, type AlpsPiSettings } from "./settings.ts";
import { normalizeAnimationsSettings } from "./features/animations/settings.ts";
import { normalizeInputMetricsSettings } from "./features/bottom-input/metrics.ts";
import { normalizeShortcut, shortcutConflictKey, shortcutUsesSuper, isSupportedSuperShortcut, RESERVED_BOTTOM_INPUT_SHORTCUTS, SHORTCUT_KEYS } from "./features/bottom-input/shortcuts.ts";

const SETTINGS_ENV = "ALPS_PI_SETTINGS_PATH";
export const PI_SETTINGS_NAMESPACE = "alps-pi";
const NAMESPACE_STORAGE_VERSION_KEY = "_storageVersion";
const NAMESPACE_STORAGE_VERSION = 1;
let tempSequence = 0;
const lastReadSnapshots = new Map<string, AlpsPiSettings>();
const objectBaselines = new WeakMap<object, AlpsPiSettings>();

export type SettingsSourcePaths = {
	piSettings: string;
	standalone: string;
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

/** Alps Pi 的唯一主设置文件；环境变量仅替换该 Pi settings 路径以隔离测试。 */
export function getSettingsPath(): string {
	return getIsolatedSettingsPath() ?? getPiSettingsPath();
}

export function getPiSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** 0.2.x 独立目录设置，仅用于一次性迁移。 */
export function getStandaloneSettingsPath(): string {
	return join(getAgentDir(), "alps-pi", "settings.json");
}

/** 最早期单文件设置，仅用于一次性迁移。 */
export function getLegacySettingsPath(): string {
	return join(getAgentDir(), "alps-pi.json");
}

export function getDefaultSettingsSourcePaths(): SettingsSourcePaths {
	const isolatedPath = getIsolatedSettingsPath();
	if (isolatedPath) return settingsSourcePathsForPiFile(isolatedPath);
	return {
		piSettings: getPiSettingsPath(),
		standalone: getStandaloneSettingsPath(),
		legacy: getLegacySettingsPath(),
	};
}

export function readPersistedSettings(path?: string): AlpsPiSettings {
	return readPersistedSettingsFromPaths(path ? settingsSourcePathsForPiFile(path) : getDefaultSettingsSourcePaths());
}

/** 优先迁移 0.2.x 独立主文件；已带版本标记的 Pi namespace 永远是唯一主源。 */
export function readPersistedSettingsFromPaths(paths: SettingsSourcePaths): AlpsPiSettings {
	const defaults = cloneStartupSettings();
	const namespace = readNamespaceFromPiFile(paths.piSettings, defaults);
	const standalone = readStandaloneSettingsIfExists(paths.standalone, defaults);
	const namespaceIsCurrent = hasCurrentNamespaceStorage(paths.piSettings);

	// 0.2.x–0.3.x 把 standalone 当主源，而 namespace 可能只是升级前留下的陈旧副本。
	if (standalone && !namespaceIsCurrent) {
		const migrated = writeNamespacedSettings(standalone, paths.piSettings, defaults, true);
		if (migrated.written) removeMigratedSettingsFiles(paths);
		return rememberRead(paths.piSettings, migrated.settings);
	}
	if (namespaceIsCurrent) {
		// 另一进程可能刚完成迁移，重新读取锁后写入的 canonical namespace。
		const currentNamespace = readNamespaceFromPiFile(paths.piSettings, defaults) ?? namespace;
		if (currentNamespace) {
			removeMigratedSettingsFiles(paths);
			return rememberRead(paths.piSettings, currentNamespace);
		}
	}
	if (namespace) {
		removeMigratedSettingsFiles(paths);
		return rememberRead(paths.piSettings, namespace);
	}

	const legacy = readStandaloneSettingsIfExists(paths.legacy, defaults);
	if (legacy) {
		const migrated = writeNamespacedSettings(legacy, paths.piSettings, defaults, true);
		if (migrated.written) removeMigratedSettingsFiles(paths);
		return rememberRead(paths.piSettings, migrated.settings);
	}

	return rememberRead(paths.piSettings, defaults);
}

/** 所有运行时写入只更新 Pi settings 根对象中的 "alps-pi" 字段。 */
export function writePersistedSettings(settings: AlpsPiSettings, path?: string): void {
	const target = path ?? getSettingsPath();
	const baseline = objectBaselines.get(settings as object) ?? lastReadSnapshots.get(target) ?? cloneStartupSettings();
	const result = writeNamespacedSettings(settings, target, baseline);
	if (!result.written) return;
	lastReadSnapshots.set(target, cloneSettings(result.settings));
	objectBaselines.set(settings as object, cloneSettings(result.settings));
}

/** 将运行时 tracked settings 对象与本次磁盘读取快照关联，供字段级并发合并。 */
export function trackSettingsBaseline(settings: AlpsPiSettings, baseline: AlpsPiSettings): void {
	objectBaselines.set(settings as object, cloneSettings(baseline));
}

/** 读取 Pi namespace；保留旧导出名供迁移测试和外部诊断。 */
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

function settingsSourcePathsForPiFile(piSettings: string): SettingsSourcePaths {
	const agentDir = dirname(piSettings);
	return {
		piSettings,
		standalone: join(agentDir, "alps-pi", "settings.json"),
		legacy: join(agentDir, "alps-pi.json"),
	};
}

function rememberRead(path: string, settings: AlpsPiSettings): AlpsPiSettings {
	const snapshot = cloneSettings(settings);
	const result = cloneSettings(snapshot);
	lastReadSnapshots.set(path, snapshot);
	objectBaselines.set(result as object, cloneSettings(snapshot));
	return result;
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

type NamespacedWriteResult = {
	settings: AlpsPiSettings;
	written: boolean;
};

function writeNamespacedSettings(
	settings: AlpsPiSettings,
	path: string,
	baseline: AlpsPiSettings,
	replaceNamespace = false,
): NamespacedWriteResult {
	mkdirSync(dirname(path), { recursive: true });
	let release: (() => void) | undefined;
	try {
		release = acquireSettingsLock(path);
		const root = readPiSettingsRoot(path);
		const current = normalizeSettings(root[PI_SETTINGS_NAMESPACE], cloneStartupSettings());
		const merged = replaceNamespace ? cloneSettings(settings) : mergeChangedSettings(current, baseline, settings);
		root[PI_SETTINGS_NAMESPACE] = {
			...cloneSettings(merged),
			[NAMESPACE_STORAGE_VERSION_KEY]: NAMESPACE_STORAGE_VERSION,
		};
		atomicWriteJson(path, root);
		return { settings: merged, written: true };
	} catch (error) {
		console.debug?.(`[alps-pi] Failed to write settings namespace to ${path}:`, error);
		return { settings: cloneSettings(settings), written: false };
	} finally {
		try {
			release?.();
		} catch {
			// stale lock cleanup must not break settings UI.
		}
	}
}

function readPiSettingsRoot(path: string): Record<string, any> {
	if (!existsSync(path)) return {};
	const root = JSON.parse(readFileSync(path, "utf-8"));
	if (!isRecord(root)) throw new TypeError(`Pi settings root must be an object: ${path}`);
	return root;
}

function hasCurrentNamespaceStorage(path: string): boolean {
	try {
		const namespace = readPiSettingsRoot(path)[PI_SETTINGS_NAMESPACE];
		return isRecord(namespace) && namespace[NAMESPACE_STORAGE_VERSION_KEY] === NAMESPACE_STORAGE_VERSION;
	} catch {
		return false;
	}
}

function removeMigratedSettingsFiles(paths: SettingsSourcePaths): void {
	for (const path of new Set([paths.standalone, paths.legacy])) {
		if (path === paths.piSettings) continue;
		try {
			rmSync(path, { force: true });
		} catch (error) {
			console.debug?.(`[alps-pi] Failed to remove migrated settings file ${path}:`, error);
		}
	}
	try {
		rmdirSync(dirname(paths.standalone));
	} catch {
		// Keep non-empty or already removed directories intact.
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
			toolCompactMode: normalizeToolDisplayMode(isRecord(raw.chromeFrame) ? raw.chromeFrame.toolCompactMode : undefined, defaults.chromeFrame.toolCompactMode),
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
