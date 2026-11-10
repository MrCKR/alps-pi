/** 功能：捕获 stdout 字节流里被"中断"的转义序列，定位协议字节被打印成文本的来源 实现者：alps 实现日期：2026-11-10 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDebugLogSink, type DebugLogSink } from "../debug-log.ts";

export type StreamState = "ground" | "esc" | "csi" | "string";

export type StreamScanResult = {
	/** 扫描结束后的状态；ground 表示没有未闭合序列。 */
	state: StreamState;
	/** 未闭合序列的起始文本（截断到 48 字符），用于识别来源。 */
	openPrefix: string;
	/** 未闭合序列累积的字节数。 */
	csiLength: number;
	/** 中断事件：在未闭合序列中又出现新的 ESC。 */
	interrupted: { openPrefix: string; openLength: number } | undefined;
	/** CSI 参数过长：正常 CSI 不会超过 64 字节。 */
	overlong: { openPrefix: string; openLength: number } | undefined;
};

const CSI_MAX_LENGTH = 64;
const STRING_MAX_LENGTH = 8 * 1024 * 1024;
const PREVIEW_LIMIT = 48;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PATH_FILE = resolve(PACKAGE_ROOT, ".temp", "stream-debug.path");
const PATCHED = Symbol.for("alps.pi.streamDiagnostic.patched");

/** 增量扫描一段输出，返回末尾未闭合序列的状态与异常事件。 */
export function scanOutputStream(input: string, state: StreamState = "ground", openPrefix = "", openLength = 0): StreamScanResult {
	let nextState = state;
	let nextPrefix = openPrefix;
	let length = openLength;
	let interrupted: StreamScanResult["interrupted"];
	let overlong: StreamScanResult["overlong"];

	const openWith = (prefix: string) => {
		nextPrefix = prefix.slice(0, PREVIEW_LIMIT);
		length = prefix.length;
	};

	for (let index = 0; index < input.length; index += 1) {
		const char = input[index]!;
		const code = input.charCodeAt(index);

		if (nextState === "ground") {
			if (char === "\x1b") {
				nextState = "esc";
				nextPrefix = "";
				length = 0;
			}
			continue;
		}

		if (nextState === "esc") {
			if (char === "[") {
				nextState = "csi";
				openWith("\x1b[");
				continue;
			}
			if (char === "]" || char === "_" || char === "P" || char === "^") {
				nextState = "string";
				openWith(`\x1b${char}`);
				continue;
			}
			// ESC + 单字节；回到 ground。
			nextState = "ground";
			nextPrefix = "";
			length = 0;
			continue;
		}

		if (nextState === "csi") {
			if (char === "\x1b") {
				interrupted = { openPrefix: nextPrefix, openLength: length };
				nextState = "esc";
				nextPrefix = "";
				length = 0;
				continue;
			}
			length += 1;
			if (nextPrefix.length < PREVIEW_LIMIT) nextPrefix += char;
			if (code >= 0x40 && code <= 0x7e) {
				nextState = "ground";
				nextPrefix = "";
				length = 0;
				continue;
			}
			if (char === "\x1b") {
				interrupted = { openPrefix: nextPrefix, openLength: length };
				nextState = "esc";
				nextPrefix = "";
				length = 0;
				continue;
			}
			if (length > CSI_MAX_LENGTH) {
				overlong = { openPrefix: nextPrefix, openLength: length };
			}
			continue;
		}

		// string（OSC/DCS/APC/PM）：BEL 或 ST 结束。
		if (char === "\x1b") {
			const following = input[index + 1];
			if (following === "\\") {
				index += 1;
				nextState = "ground";
				nextPrefix = "";
				length = 0;
				continue;
			}
			// 未闭合字符串里出现新 ESC：终端会中断字符串，后续字节被当作正文打印。
			interrupted = { openPrefix: nextPrefix, openLength: length };
			nextState = "esc";
			nextPrefix = "";
			length = 0;
			continue;
		}
		length += 1;
		if (nextPrefix.length < PREVIEW_LIMIT) nextPrefix += char;
		if (char === "\x07") {
			nextState = "ground";
			nextPrefix = "";
			length = 0;
			continue;
		}
		if (char === "\x1b") {
			const following = input[index + 1];
			if (following === "\\") {
				index += 1;
				nextState = "ground";
				nextPrefix = "";
				length = 0;
				continue;
			}
			// 未闭合字符串里出现新 ESC：终端会中断字符串，后续字节被当作正文打印。
			interrupted = { openPrefix: nextPrefix, openLength: length };
			nextState = "esc";
			nextPrefix = "";
			length = 0;
			continue;
		}
		if (length > STRING_MAX_LENGTH) {
			overlong = { openPrefix: nextPrefix, openLength: length };
			nextState = "ground";
			nextPrefix = "";
			length = 0;
		}
	}

	return { state: nextState, openPrefix: nextPrefix, csiLength: length, interrupted, overlong };
}

export function isStreamDiagnosticEnabled(): boolean {
	return Boolean(resolveStreamLogPath());
}

/** 优先读取环境变量；没有时读 .temp/stream-debug.path，方便不重启 pi 启用。 */
export function resolveStreamLogPath(): string {
	const fromEnv = process.env.ALPS_PI_STREAM_DEBUG_LOG?.trim();
	if (fromEnv && isAbsolute(fromEnv)) return fromEnv;
	try {
		if (!existsSync(PATH_FILE)) return "";
		const fromFile = readFileSync(PATH_FILE, "utf8").replace(/^\uFEFF/, "").trim();
		return fromFile && isAbsolute(fromFile) ? fromFile : "";
	} catch {
		return "";
	}
}

/**
 * 挂钩 process.stdout.write，逐次检查写入尾部是否留下未闭合序列。
 * 只记录异常（未闭合字符串被中断、CSI 过长），正常的分包不记录。
 */
export function installOutputStreamDiagnostic(): () => void {
	const logPath = resolveStreamLogPath();
	if (!logPath) return () => undefined;
	const current = process.stdout.write as any;
	// reload 可能重复调用；已经挂钩时直接返回，不叠加包装。
	if (current[PATCHED]) return () => undefined;
	const sink: DebugLogSink = createDebugLogSink({
		name: "stream",
		getPath: () => logPath,
		maxBytes: 4 * 1024 * 1024,
		maxEntriesPerSecond: 10,
	});

	const original = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
	let state: StreamState = "ground";
	let prefix = "";
	let length = 0;
	let writeIndex = 0;

	// 安装标记：日志文件存在即证明钩子已生效，避免“无日志”被误读为正常。
	sink.write({
		event: "installed",
		pid: process.pid,
		columns: process.stdout.columns ?? null,
		rows: process.stdout.rows ?? null,
		source: process.env.ALPS_PI_STREAM_DEBUG_LOG ? "env" : "path-file",
	});

	const patched = ((chunk: any, encoding?: any, callback?: any): boolean => {
		writeIndex += 1;
		try {
			const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("latin1") : String(chunk);
			const result = scanOutputStream(text, state, prefix, length);
			if (result.interrupted || result.overlong) {
				sink.write({
					event: result.interrupted ? "interrupted-string" : "overlong-sequence",
					writeIndex,
					state: result.state,
					openPrefix: escapeForLog(result.interrupted?.openPrefix ?? result.overlong?.openPrefix ?? ""),
					openLength: result.interrupted?.openLength ?? result.overlong?.openLength ?? 0,
					tail: escapeForLog(text.slice(-160)),
				});
			}
			state = result.state;
			prefix = result.openPrefix;
			length = result.csiLength;
		} catch {
			// 诊断不得影响终端输出。
		}
		return original(chunk, encoding, callback);
	}) as typeof process.stdout.write;

	process.stdout.write = patched;
	Object.defineProperty(patched, PATCHED, { value: true });
	return () => {
		if (process.stdout.write === patched) process.stdout.write = original;
	};
}

/** 把控制字符转成可见形式，避免日志本身带原始 ESC。 */
export function escapeForLog(input: string): string {
	let output = "";
	for (const char of input) {
		const code = char.codePointAt(0)!;
		if (code === 0x1b) output += "\\e";
		else if (code === 0x07) output += "\\a";
		else if (code < 0x20 || code === 0x7f) output += `\\x${code.toString(16).padStart(2, "0")}`;
		else output += char;
	}
	return output.slice(0, 400);
}
