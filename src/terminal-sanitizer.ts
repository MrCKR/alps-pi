/** 功能：提供 terminal display 边界文本净化，剥离用户/扩展可控文本里的危险控制序列 实现者：alps 实现日期：2026-05-30 */

const ESC = "\x1b";
const C1_STRING_START = /[\x90\x9d\x9e\x9f]/;
const C0_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const C1_CONTROL = /[\x80-\x8f\x91-\x9a\x9c]/g;

export type TerminalSanitizeOptions = {
	/** 是否允许换行参与后续布局；默认保留。 */
	allowNewline?: boolean;
	/** 是否允许 tab；默认保留。 */
	allowTab?: boolean;
	/** 是否保留 SGR 颜色/样式序列；主题层已生成的 ANSI 可通过该选项保留。 */
	preserveSgr?: boolean;
};

/**
 * 净化进入终端展示层的外部文本。
 * 时机：用户 prompt、extension status、工具正文等在拼接 UI 之前调用。
 * 约束：只保留可见文本、白名单空白与可选 SGR；OSC/DCS/APC/PM/非 SGR CSI 一律剥离。
 */
export function sanitizeTerminalText(value: unknown, options: TerminalSanitizeOptions = {}): string {
	const input = value === undefined || value === null ? "" : String(value);
	if (!input) return "";
	const preserveSgr = options.preserveSgr !== false;
	let result = "";
	for (let index = 0; index < input.length;) {
		const sequence = readAnsiSequence(input, index);
		if (sequence) {
			if (preserveSgr && isSgrSequence(sequence.code)) result += sequence.code;
			index += sequence.length;
			continue;
		}
		const char = input[index]!;
		if (char === "\n") {
			if (options.allowNewline !== false) result += char;
			index += 1;
			continue;
		}
		if (char === "\t") {
			if (options.allowTab !== false) result += char;
			index += 1;
			continue;
		}
		if (C0_CONTROL.test(char) || C1_CONTROL.test(char) || C1_STRING_START.test(char)) {
			C0_CONTROL.lastIndex = 0;
			C1_CONTROL.lastIndex = 0;
			C1_STRING_START.lastIndex = 0;
			index += 1;
			continue;
		}
		C0_CONTROL.lastIndex = 0;
		C1_CONTROL.lastIndex = 0;
		C1_STRING_START.lastIndex = 0;
		result += char;
		index += 1;
	}
	return result;
}

/** 将外部文本压缩为单行安全内容，适合 last prompt 与状态片段。 */
export function sanitizeTerminalSingleLineText(value: unknown, options: Omit<TerminalSanitizeOptions, "allowNewline" | "allowTab"> = {}): string {
	return sanitizeTerminalText(value, { ...options, allowNewline: false, allowTab: false }).replace(/\s+/g, " ").trim();
}

/** 判断一段 ANSI 是否为 SGR 样式序列；非 SGR CSI 不允许穿过展示边界。 */
function isSgrSequence(sequence: string): boolean {
	return /^\x1b\[[0-9;:]*m$/.test(sequence) || /^\x9b[0-9;:]*m$/.test(sequence);
}

/** 读取 ESC/C1 控制序列；不完整序列按 ESC 单字节剥离，避免残留控制前缀。 */
function readAnsiSequence(input: string, index: number): { code: string; length: number } | null {
	const char = input[index];
	if (char === ESC) return readEscSequence(input, index);
	if (char === "\x9b") return readCsiSequence(input, index, 1);
	if (char === "\x90" || char === "\x9d" || char === "\x9e" || char === "\x9f") return readStringControlSequence(input, index, 1);
	return null;
}

/** 读取 ESC 开头的 CSI/OSC/DCS/APC/PM 序列。 */
function readEscSequence(input: string, index: number): { code: string; length: number } {
	const next = input[index + 1];
	if (next === "[") return readCsiSequence(input, index, 2);
	if (next === "]" || next === "P" || next === "_" || next === "^") return readStringControlSequence(input, index, 2);
	return { code: input.slice(index, Math.min(input.length, index + 2)), length: Math.min(2, input.length - index) };
}

/** 读取 CSI 到最终字节；用于区分 SGR 与清屏/移动光标等危险控制。 */
function readCsiSequence(input: string, index: number, prefixLength: number): { code: string; length: number } {
	for (let end = index + prefixLength; end < input.length; end += 1) {
		const code = input.charCodeAt(end);
		if (code >= 0x40 && code <= 0x7e) return { code: input.slice(index, end + 1), length: end + 1 - index };
	}
	return { code: input.slice(index), length: input.length - index };
}

/** 读取 OSC/DCS/APC/PM 到 BEL 或 ST；未闭合时吞掉剩余文本，避免控制串泄漏。 */
function readStringControlSequence(input: string, index: number, prefixLength: number): { code: string; length: number } {
	for (let end = index + prefixLength; end < input.length; end += 1) {
		if (input[end] === "\x07") return { code: input.slice(index, end + 1), length: end + 1 - index };
		if (input[end] === ESC && input[end + 1] === "\\") return { code: input.slice(index, end + 2), length: end + 2 - index };
	}
	return { code: input.slice(index), length: input.length - index };
}
