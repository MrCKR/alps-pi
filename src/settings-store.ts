/** 功能：读写 Alps Pi 用户级持久化设置 实现者：alps 实现日期：2026-05-27 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cloneDefaultSettings, type AlpsPiSettings } from "./settings.ts";

const SETTINGS_ENV = "ALPS_PI_SETTINGS_PATH";

/** 返回启动默认设置；消息线框与固定输入框默认开启，底部状态栏仍默认关闭。 */
export function cloneStartupSettings(): AlpsPiSettings {
	const settings = cloneDefaultSettings();
	settings.chromeFrame.enabled = true;
	settings.fixedBottomEditor.enabled = true;
	settings.bottomStatus.enabled = false;
	return settings;
}

/** 计算持久化设置路径；测试可用环境变量隔离真实用户配置。 */
export function getSettingsPath(): string {
	const override = process.env[SETTINGS_ENV]?.trim();
	return override || join(homedir(), ".pi", "agent", "alps-pi", "settings.json");
}

/** 读取用户设置；缺文件或格式不完整时合并启动默认值。 */
export function readPersistedSettings(path = getSettingsPath()): AlpsPiSettings {
	const defaults = cloneStartupSettings();
	if (!existsSync(path)) {
		return defaults;
	}

	try {
		return normalizeSettings(JSON.parse(readFileSync(path, "utf-8")), defaults);
	} catch (error) {
		console.debug?.(`[alps-pi] Failed to read settings from ${path}:`, error);
		return defaults;
	}
}

/** 写入用户设置；失败只记录调试信息，不能破坏 UI 操作。 */
export function writePersistedSettings(settings: AlpsPiSettings, path = getSettingsPath()): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(cloneSettings(settings), null, 2) + "\n", "utf-8");
	} catch (error) {
		console.debug?.(`[alps-pi] Failed to write settings to ${path}:`, error);
	}
}

/** 生成普通对象快照，避免把 Proxy 或额外字段写入磁盘。 */
export function cloneSettings(settings: AlpsPiSettings): AlpsPiSettings {
	return {
		chromeFrame: { ...settings.chromeFrame },
		fixedBottomEditor: { ...settings.fixedBottomEditor },
		bottomStatus: { ...settings.bottomStatus },
	};
}

/** 只接受已知 boolean 字段，避免坏配置污染运行时。 */
function normalizeSettings(value: unknown, defaults: AlpsPiSettings): AlpsPiSettings {
	const raw = isRecord(value) ? value : {};
	return {
		chromeFrame: {
			enabled: readBoolean(raw.chromeFrame, "enabled", defaults.chromeFrame.enabled),
			assistantFrame: readBoolean(raw.chromeFrame, "assistantFrame", defaults.chromeFrame.assistantFrame),
		},
		fixedBottomEditor: {
			enabled: readBoolean(raw.fixedBottomEditor, "enabled", defaults.fixedBottomEditor.enabled),
		},
		bottomStatus: {
			enabled: readBoolean(raw.bottomStatus, "enabled", defaults.bottomStatus.enabled),
		},
	};
}

function readBoolean(parent: unknown, key: string, fallback: boolean): boolean {
	if (!isRecord(parent)) return fallback;
	return typeof parent[key] === "boolean" ? parent[key] : fallback;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
