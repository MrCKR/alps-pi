/** 功能：管理底部输入框快捷键默认值、匹配、归一化与冲突检查 实现者：alps 实现日期：2026-05-28 */

import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

export type BottomInputShortcutKey =
	| "stashEditor"
	| "copyEditor"
	| "cutEditor"
	| "scrollChatUp"
	| "scrollChatDown"
	| "editorStart"
	| "editorEnd"
	| "jumpPreviousUserMessage"
	| "jumpNextUserMessage"
	| "jumpPreviousAssistantMessage"
	| "jumpNextAssistantMessage"
	| "jumpChatBottom";

export type BottomInputShortcuts = Record<BottomInputShortcutKey, string>;

export type ShortcutValidationResult =
	| { ok: true; shortcut: string }
	| { ok: false; reason: string };

export const DEFAULT_BOTTOM_INPUT_SHORTCUTS: BottomInputShortcuts = {
	stashEditor: "alt+s",
	copyEditor: "ctrl+alt+c",
	cutEditor: "ctrl+alt+x",
	scrollChatUp: "super+up",
	scrollChatDown: "super+down",
	editorStart: "super+shift+up",
	editorEnd: "super+shift+down",
	jumpPreviousUserMessage: "ctrl+shift+u",
	jumpNextUserMessage: "ctrl+shift+i",
	jumpPreviousAssistantMessage: "ctrl+alt+,",
	jumpNextAssistantMessage: "ctrl+alt+.",
	jumpChatBottom: "ctrl+shift+g",
};

export const SHORTCUT_LABELS: Record<BottomInputShortcutKey, string> = {
	stashEditor: "Stash Editor",
	copyEditor: "Copy Editor",
	cutEditor: "Cut Editor",
	scrollChatUp: "Scroll Chat Up",
	scrollChatDown: "Scroll Chat Down",
	editorStart: "Move Cursor Start",
	editorEnd: "Move Cursor End",
	jumpPreviousUserMessage: "Previous User Message",
	jumpNextUserMessage: "Next User Message",
	jumpPreviousAssistantMessage: "Previous Assistant Msg",
	jumpNextAssistantMessage: "Next Assistant Msg",
	jumpChatBottom: "Chat Bottom",
};

export const SHORTCUT_KEYS = Object.keys(DEFAULT_BOTTOM_INPUT_SHORTCUTS) as BottomInputShortcutKey[];

const SUPER_SHORTCUT_PATTERNS = new Map<string, RegExp>([
	["super+up", /^\x1b\[(?:1;9(?::[12])?[AH]|574(?:19|23);9(?::[12])?u|7;9(?::[12])?~|27;9;65~)$/],
	["super+down", /^\x1b\[(?:1;9(?::[12])?[BF]|574(?:20|24);9(?::[12])?u|8;9(?::[12])?~|27;9;66~)$/],
	["super+home", /^\x1b\[(?:1;9(?::[12])?H|57423;9(?::[12])?u|7;9(?::[12])?~)$/],
	["super+end", /^\x1b\[(?:1;9(?::[12])?F|57424;9(?::[12])?u|8;9(?::[12])?~)$/],
	["super+pageup", /^\x1b\[(?:5;9(?::[12])?~|57421;9(?::[12])?u)$/],
	["super+pagedown", /^\x1b\[(?:6;9(?::[12])?~|57422;9(?::[12])?u)$/],
	["super+shift+up", /^\x1b\[(?:1;10(?::[12])?[AH]|574(?:19|23);10(?::[12])?u|7;10(?::[12])?~|27;10;65~)$/],
	["super+shift+down", /^\x1b\[(?:1;10(?::[12])?[BF]|574(?:20|24);10(?::[12])?u|8;10(?::[12])?~|27;10;66~)$/],
	["super+shift+home", /^\x1b\[(?:1;10(?::[12])?H|57423;10(?::[12])?u|7;10(?::[12])?~)$/],
	["super+shift+end", /^\x1b\[(?:1;10(?::[12])?F|57424;10(?::[12])?u|8;10(?::[12])?~)$/],
]);

const MODIFIER_ORDER = ["ctrl", "alt", "super", "shift"] as const;
const MODIFIERS = new Set<string>(MODIFIER_ORDER);
const NAMED_KEYS = new Set([
	"escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear",
	"home", "end", "pageup", "pagedown", "up", "down", "left", "right",
]);
const SYMBOL_KEYS = new Set([
	"`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/",
	"!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "|", "~", "{", "}", ":", "<", ">", "?",
]);
const RAW_RESERVED_SHORTCUTS = [
	"escape",
	"ctrl+c",
	"ctrl+d",
	"ctrl+z",
	"shift+tab",
	"ctrl+p",
	"shift+ctrl+p",
	"ctrl+l",
	"ctrl+o",
	"shift+ctrl+o",
	"ctrl+t",
	"ctrl+n",
	"ctrl+g",
	"alt+enter",
	"alt+up",
	"alt+down",
	"ctrl+v",
	"alt+v",
	"shift+l",
	"shift+t",
	"ctrl+s",
	"ctrl+r",
	"ctrl+backspace",
	"ctrl+a",
	"ctrl+x",
	"ctrl+u",
];

export const RESERVED_BOTTOM_INPUT_SHORTCUTS = new Set(
	RAW_RESERVED_SHORTCUTS.map((shortcut) => shortcutConflictKey(normalizeShortcut(shortcut))).filter(Boolean),
);

/** 合并用户配置，缺字段时使用默认快捷键。 */
export function resolveBottomInputShortcuts(value: Partial<BottomInputShortcuts> | undefined): BottomInputShortcuts {
	const resolved = { ...DEFAULT_BOTTOM_INPUT_SHORTCUTS };
	if (!value) return resolved;
	for (const key of SHORTCUT_KEYS) {
		const shortcut = typeof value[key] === "string" ? normalizeShortcut(value[key]) : "";
		if (shortcut) resolved[key] = shortcut;
	}
	return resolved;
}

/** 判断快捷键是否使用 Super/Command 语义。 */
export function shortcutUsesSuper(shortcut: string): boolean {
	const parts = normalizeShortcut(shortcut).split("+");
	return parts.slice(0, -1).includes("super");
}

/** 原版只对终端可稳定产生 escape 的 Super 组合做 fallback。 */
export function isSupportedSuperShortcut(shortcut: string): boolean {
	return SUPER_SHORTCUT_PATTERNS.has(normalizeShortcut(shortcut));
}

/** 归一化冲突键；部分终端把 Super+Home/End 报成 Super+Up/Down。 */
export function shortcutConflictKey(shortcut: string): string {
	switch (normalizeShortcut(shortcut)) {
		case "super+home":
			return "super+up";
		case "super+end":
			return "super+down";
		case "super+shift+home":
			return "super+shift+up";
		case "super+shift+end":
			return "super+shift+down";
		default:
			return normalizeShortcut(shortcut);
	}
}

/** 按配置匹配 raw terminal input；Super 组合优先走原版 escape fallback。 */
export function matchesConfiguredShortcut(data: string, shortcut: string): boolean {
	if (isKeyRelease(data)) return false;
	const normalizedShortcut = normalizeShortcut(shortcut);
	if (!normalizedShortcut) return false;
	if (shortcutUsesSuper(normalizedShortcut)) {
		return SUPER_SHORTCUT_PATTERNS.get(normalizedShortcut)?.test(data) ?? false;
	}
	return matchesKey(data, normalizedShortcut);
}

/** Alt+S 多编码匹配；配置为 alt+s 时也匹配原版特殊输入。 */
export function isStashShortcutInput(data: string, shortcut = DEFAULT_BOTTOM_INPUT_SHORTCUTS.stashEditor): boolean {
	if (isKeyRelease(data)) return false;
	if (normalizeShortcut(shortcut) !== "alt+s") {
		return matchesConfiguredShortcut(data, shortcut);
	}
	return data === "ß"
		|| data === "\x1bs"
		|| data === "\x1bS"
		|| /^\x1b\[(?:83|115)(?::\d*)?(?::\d*)?;3(?::\d+)?u$/.test(data)
		|| data === "\x1b[27;3;115~"
		|| data === "\x1b[27;3;83~"
		|| matchesKey(data, "alt+s");
}

/** 归一化快捷键文本；cmd/command 视为 super，并按固定 modifier 顺序输出。 */
export function normalizeShortcut(shortcut: string): string {
	const parts = shortcut
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "")
		.split("+")
		.filter(Boolean)
		.map((part) => part === "cmd" || part === "command" ? "super" : part);
	if (parts.length === 0) return "";

	const key = normalizeKey(parts.at(-1)!);
	if (!key) return "";
	const modifiers = [...new Set(parts.slice(0, -1))].filter((part) => MODIFIERS.has(part));
	if (modifiers.length !== parts.slice(0, -1).length) return "";
	modifiers.sort((a, b) => MODIFIER_ORDER.indexOf(a as any) - MODIFIER_ORDER.indexOf(b as any));
	return [...modifiers, key].join("+");
}

/** 校验单个快捷键；拒绝保留键、不支持 Super 键和重复键。 */
export function validateShortcutChange(
	shortcuts: BottomInputShortcuts,
	key: BottomInputShortcutKey,
	candidate: string,
): ShortcutValidationResult {
	const normalized = normalizeShortcut(candidate);
	if (!normalized) return { ok: false, reason: "Unrecognized shortcut" };
	if (RESERVED_BOTTOM_INPUT_SHORTCUTS.has(shortcutConflictKey(normalized))) {
		return { ok: false, reason: "Reserved by Pi" };
	}
	if (shortcutUsesSuper(normalized) && !isSupportedSuperShortcut(normalized)) {
		return { ok: false, reason: "Only Super/Command arrow shortcuts are supported" };
	}
	const conflictKey = shortcutConflictKey(normalized);
	for (const otherKey of SHORTCUT_KEYS) {
		if (otherKey === key) continue;
		if (shortcutConflictKey(shortcuts[otherKey]) === conflictKey) {
			return { ok: false, reason: `Conflicts with ${SHORTCUT_LABELS[otherKey]}` };
		}
	}
	return { ok: true, shortcut: normalized };
}

/** 将捕获模式收到的 raw input 转成配置文本；无法稳定表达时返回 null。 */
export function shortcutFromRawInput(data: string): string | null {
	if (isKeyRelease(data)) return null;
	for (const shortcut of enumerateKnownShortcuts()) {
		if (matchesConfiguredShortcut(data, shortcut)) return shortcut;
	}
	const csiU = parseCsiUShortcut(data);
	if (csiU) return csiU;
	if (/^\x1b.$/s.test(data)) {
		return normalizeShortcut(`alt+${data.slice(1)}`) || null;
	}
	if (data.length === 1) {
		const code = data.charCodeAt(0);
		if (code >= 1 && code <= 26) return `ctrl+${String.fromCharCode(code + 96)}`;
		if (code >= 32 && code < 127) return normalizeShortcut(data);
	}
	return null;
}

function normalizeKey(key: string): string {
	if (key === "esc") return "escape";
	if (key === "return") return "enter";
	if (key === "pgup") return "pageup";
	if (key === "pgdn") return "pagedown";
	if (/^[a-z0-9]$/.test(key) || NAMED_KEYS.has(key) || SYMBOL_KEYS.has(key)) return key;
	return "";
}

function parseCsiUShortcut(data: string): string | null {
	const match = /^\x1b\[(\d+);(\d+)u$/.exec(data);
	if (!match) return null;
	const code = Number(match[1]);
	const modifierValue = Number(match[2]);
	if (!Number.isFinite(code) || !Number.isFinite(modifierValue)) return null;
	const key = keyFromCodepoint(code);
	if (!key) return null;
	return normalizeShortcut([...modifiersFromCsiValue(modifierValue), key].join("+")) || null;
}

function keyFromCodepoint(code: number): string | null {
	if (code >= 65 && code <= 90) return String.fromCharCode(code + 32);
	if (code >= 97 && code <= 122) return String.fromCharCode(code);
	if (code >= 48 && code <= 57) return String.fromCharCode(code);
	const named: Record<number, string> = {
		13: "enter",
		27: "escape",
		32: "space",
		127: "backspace",
		57399: "delete",
		57419: "up",
		57420: "down",
		57421: "pageup",
		57422: "pagedown",
		57423: "home",
		57424: "end",
	};
	return named[code] ?? (SYMBOL_KEYS.has(String.fromCharCode(code)) ? String.fromCharCode(code) : null);
}

function modifiersFromCsiValue(value: number): string[] {
	const mask = value - 1;
	const modifiers: string[] = [];
	if (mask & 4) modifiers.push("ctrl");
	if (mask & 2) modifiers.push("alt");
	if (mask & 8) modifiers.push("super");
	if (mask & 1) modifiers.push("shift");
	return modifiers;
}

function enumerateKnownShortcuts(): string[] {
	const keys = ["s", "c", "x", "u", "i", "g", ",", ".", "up", "down", "home", "end", "pageup", "pagedown"];
	const modifiers = ["ctrl", "alt", "super", "shift", "ctrl+alt", "ctrl+shift", "super+shift"];
	return [...new Set([
		...Object.values(DEFAULT_BOTTOM_INPUT_SHORTCUTS),
		...modifiers.flatMap((modifier) => keys.map((key) => `${modifier}+${key}`)),
	])].map(normalizeShortcut).filter(Boolean);
}
