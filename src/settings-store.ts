/** 功能：读写 Alps Pi 用户级持久化设置 实现者：alps 实现日期：2026-05-27 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { cloneDefaultSettings, type AlpsPiSettings, type AssistantFrameStyle } from "./settings.ts";
import { normalizeAnimationsSettings } from "./features/animations/settings.ts";
import { normalizeShortcut, shortcutConflictKey, shortcutUsesSuper, isSupportedSuperShortcut, RESERVED_BOTTOM_INPUT_SHORTCUTS, SHORTCUT_KEYS } from "./features/bottom-input/shortcuts.ts";

const SETTINGS_ENV = "ALPS_PI_SETTINGS_PATH";
export const PI_SETTINGS_NAMESPACE = "alps-pi";

/** 返回启动默认设置；消息线框、固定输入框与美化输入框默认开启。 */
export function cloneStartupSettings(): AlpsPiSettings {
	const settings = cloneDefaultSettings();
	settings.chromeFrame.enabled = true;
	settings.fixedBottomEditor.enabled = true;
	settings.beautifiedInput.enabled = true;
	settings.animations.enabled = true;
	return settings;
}

/** 计算当前持久化主路径；测试隔离变量存在时返回隔离文件，否则返回 Pi 原生 settings。 */
export function getSettingsPath(): string {
	return getIsolatedSettingsPath() ?? getPiSettingsPath();
}

/** 返回 Pi 原生全局 settings 文件路径。 */
export function getPiSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** 返回独立设置文件路径；只用于 fallback 读取和迁移。 */
export function getLegacySettingsPath(): string {
	return join(getAgentDir(), "alps-pi", "settings.json");
}

/** 读取用户设置；默认使用 Pi settings 的 "alps-pi" 命名空间，测试可传入独立文件路径。 */
export function readPersistedSettings(path?: string): AlpsPiSettings {
	const isolatedPath = path ?? getIsolatedSettingsPath();
	if (isolatedPath) {
		return readStandaloneSettings(isolatedPath, cloneStartupSettings());
	}
	return readNamespacedPiSettings(getPiSettingsPath(), getLegacySettingsPath());
}

/** 写入用户设置；默认只替换 Pi settings 的 "alps-pi" 字段，测试可传入独立文件路径。 */
export function writePersistedSettings(settings: AlpsPiSettings, path?: string): void {
	const isolatedPath = path ?? getIsolatedSettingsPath();
	if (isolatedPath) {
		writeStandaloneSettings(settings, isolatedPath);
		return;
	}
	writeNamespacedPiSettings(settings, getPiSettingsPath());
}

/** 从指定 Pi settings 文件读取 "alps-pi" 命名空间；缺失时尝试从独立文件迁移。 */
export function readNamespacedPiSettings(piSettingsPath: string, legacySettingsPath = getLegacySettingsPath()): AlpsPiSettings {
	const defaults = cloneStartupSettings();
	const namespaceSettings = readNamespaceFromPiFile(piSettingsPath, defaults);
	if (namespaceSettings) return namespaceSettings;

	const legacySettings = readStandaloneSettingsIfExists(legacySettingsPath, defaults);
	if (legacySettings) {
		writeNamespacedPiSettings(legacySettings, piSettingsPath);
		return legacySettings;
	}
	return defaults;
}

/** 写入指定 Pi settings 文件的 "alps-pi" 命名空间，保留其它原生设置字段。 */
export function writeNamespacedPiSettings(settings: AlpsPiSettings, piSettingsPath: string): void {
	try {
		const root = readPiSettingsRoot(piSettingsPath);
		if (!root) return;
		root[PI_SETTINGS_NAMESPACE] = cloneSettings(settings);
		mkdirSync(dirname(piSettingsPath), { recursive: true });
		writeFileSync(piSettingsPath, JSON.stringify(root, null, 2) + "\n", "utf-8");
	} catch (error) {
		console.debug?.(`[alps-pi] Failed to write settings namespace to ${piSettingsPath}:`, error);
	}
}

/** 生成普通对象快照，避免把 Proxy 或额外字段写入磁盘。 */
export function cloneSettings(settings: AlpsPiSettings): AlpsPiSettings {
	return {
		chromeFrame: { ...settings.chromeFrame },
		fixedBottomEditor: { ...settings.fixedBottomEditor },
		beautifiedInput: { ...settings.beautifiedInput },
		animations: { ...settings.animations },
		shortcuts: { ...settings.shortcuts },
	};
}

function getIsolatedSettingsPath(): string | undefined {
	return process.env[SETTINGS_ENV]?.trim() || undefined;
}

function readStandaloneSettings(path: string, defaults: AlpsPiSettings): AlpsPiSettings {
	const settings = readStandaloneSettingsIfExists(path, defaults);
	return settings ?? defaults;
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

function readPiSettingsRoot(path: string): Record<string, any> | undefined {
	if (!existsSync(path)) return {};
	try {
		const root = JSON.parse(readFileSync(path, "utf-8"));
		if (!isRecord(root)) {
			console.debug?.(`[alps-pi] Refuse to write settings namespace because ${path} is not a JSON object.`);
			return undefined;
		}
		return root;
	} catch (error) {
		console.debug?.(`[alps-pi] Refuse to write settings namespace because ${path} is invalid JSON:`, error);
		return undefined;
	}
}

/** 只接受已知设置值，避免坏配置污染运行时。 */
function normalizeSettings(value: unknown, defaults: AlpsPiSettings): AlpsPiSettings {
	const raw = isRecord(value) ? value : {};
	return {
		chromeFrame: {
			enabled: readBoolean(raw.chromeFrame, "enabled", defaults.chromeFrame.enabled),
			assistantFrameStyle: readAssistantFrameStyle(raw.chromeFrame, defaults.chromeFrame.assistantFrameStyle),
			toolCompactMode: readBoolean(raw.chromeFrame, "toolCompactMode", defaults.chromeFrame.toolCompactMode),
			compactEditTool: readBoolean(raw.chromeFrame, "compactEditTool", defaults.chromeFrame.compactEditTool),
		},
		fixedBottomEditor: {
			enabled: readBoolean(raw.fixedBottomEditor, "enabled", defaults.fixedBottomEditor.enabled),
		},
		beautifiedInput: {
			enabled: readBoolean(raw.beautifiedInput, "enabled", defaults.beautifiedInput.enabled),
		},
		animations: normalizeAnimationsSettings(raw.animations, defaults.animations),
		shortcuts: normalizeShortcutSettings(raw.shortcuts, defaults.shortcuts),
	};
}

function writeStandaloneSettings(settings: AlpsPiSettings, path: string): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(cloneSettings(settings), null, 2) + "\n", "utf-8");
	} catch (error) {
		console.debug?.(`[alps-pi] Failed to write settings to ${path}:`, error);
	}
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

function readAssistantFrameStyle(parent: unknown, fallback: AssistantFrameStyle): AssistantFrameStyle {
	if (!isRecord(parent)) return fallback;
	const style = parent.assistantFrameStyle;
	if (style === "box" || style === "horizontal" || style === "none") return style;
	if (typeof parent.assistantFrame === "boolean") return parent.assistantFrame ? "box" : "none";
	return fallback;
}

function readBoolean(parent: unknown, key: string, fallback: boolean): boolean {
	if (!isRecord(parent)) return fallback;
	return typeof parent[key] === "boolean" ? parent[key] : fallback;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
