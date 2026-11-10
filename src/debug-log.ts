/** 功能：为诊断日志提供有界、去重、限速的异步写入器，避免热路径同步写放大 实现者：alps 实现日期：2026-11-10 */

import { appendFile, appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type DebugLogSinkOptions = {
	/** 日志名；用于轮转/丢弃标记行。 */
	name: string;
	/** 返回绝对日志路径；返回空表示关闭。每次写入都会调用，实现方可自带缓存。 */
	getPath: () => string | undefined;
	/** 单个文件体积上限；超过则截断并写轮转标记。默认 8 MiB。 */
	maxBytes?: number;
	/** 每秒最多接受的条目数；超出的条目被丢弃并汇总计数。默认 20。 */
	maxEntriesPerSecond?: number;
	/** 相同内容在该时间窗内折叠为一次并计数。默认 1000ms。 */
	dedupeWindowMs?: number;
	/** 缓冲刷新间隔。默认 250ms。 */
	flushDelayMs?: number;
	/** 缓冲区行数上限；达到即提前刷新。默认 512。 */
	maxBufferedLines?: number;
};

export type DebugLogSink = {
	/** 写入一条已构建的条目。 */
	write(entry: Record<string, unknown>): void;
	/** 限速通过后才构建条目；用于热路径里构造代价高的诊断。 */
	writeLazy(produce: () => Record<string, unknown>): void;
	/** 清空缓冲与统计；路径变化时也会自动清空。 */
	reset(): void;
};

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES_PER_SECOND = 20;
const DEFAULT_DEDUPE_WINDOW_MS = 1000;
const DEFAULT_FLUSH_DELAY_MS = 250;
const DEFAULT_MAX_BUFFERED_LINES = 512;
const SIZE_RECHECK_MS = 5_000;
const SYNC_FLUSH_ENV = "ALPS_PI_DEBUG_LOG_SYNC";
const UNLIMITED_ENV = "ALPS_PI_DEBUG_LOG_UNLIMITED";

const sinks = new Set<DebugLogSinkImpl>();
let unlimited = process.env[UNLIMITED_ENV] === "1";

/** 关闭限速与去重；仅供直逼测试使用，避免断言被采样影响。 */
export function setDebugLogsUnlimited(enabled: boolean): void {
	unlimited = enabled;
}

/** 当前是否处于“不限速”测试模式。 */
export function isDebugLogsUnlimited(): boolean {
	return unlimited;
}

/** 立即把全部缓冲刷到磁盘；仅用于测试与进程退出前的收尾。 */
export function flushDebugLogsSync(): void {
	for (const sink of sinks) sink.flushSync();
}

/** 清空全部日志写入器的缓冲与统计；测试之间隔离使用。 */
export function resetDebugLogs(): void {
	for (const sink of sinks) sink.reset();
}

/** 创建有界诊断日志写入器；默认异步写入，异常一律吞掉。 */
export function createDebugLogSink(options: DebugLogSinkOptions): DebugLogSink {
	const sink = new DebugLogSinkImpl(options);
	sinks.add(sink);
	return sink;
}

class DebugLogSinkImpl implements DebugLogSink {
	private readonly name: string;
	private readonly getPath: () => string | undefined;
	private readonly maxBytes: number;
	private readonly maxEntriesPerSecond: number;
	private readonly dedupeWindowMs: number;
	private readonly flushDelayMs: number;
	private readonly maxBufferedLines: number;

	private activePath = "";
	private lines: string[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private flushing = false;
	private rateWindowStart = 0;
	private rateCount = 0;
	private suppressed = 0;
	private repeated = 0;
	private repeatedEvent = "";
	private lastSignature = "";
	private lastSignatureAt = 0;
	private preparedDirectory = "";
	private knownSize = -1;
	private sizeCheckedAt = 0;

	constructor(options: DebugLogSinkOptions) {
		this.name = options.name;
		this.getPath = options.getPath;
		this.maxBytes = Math.max(4096, options.maxBytes ?? DEFAULT_MAX_BYTES);
		this.maxEntriesPerSecond = Math.max(1, options.maxEntriesPerSecond ?? DEFAULT_MAX_ENTRIES_PER_SECOND);
		this.dedupeWindowMs = Math.max(0, options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS);
		this.flushDelayMs = Math.max(0, options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS);
		this.maxBufferedLines = Math.max(8, options.maxBufferedLines ?? DEFAULT_MAX_BUFFERED_LINES);
	}

	write(entry: Record<string, unknown>): void {
		this.enqueue(entry);
	}

	writeLazy(produce: () => Record<string, unknown>): void {
		const path = this.resolvePath();
		if (!path) return;
		if (!this.acceptRate()) {
			this.suppressed += 1;
			this.schedule();
			return;
		}
		let entry: Record<string, unknown>;
		try {
			entry = produce();
		} catch {
			return;
		}
		this.enqueueAccepted(path, entry);
	}

	reset(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.lines = [];
		this.activePath = "";
		this.rateWindowStart = 0;
		this.rateCount = 0;
		this.suppressed = 0;
		this.repeated = 0;
		this.repeatedEvent = "";
		this.lastSignature = "";
		this.lastSignatureAt = 0;
		this.knownSize = -1;
		this.sizeCheckedAt = 0;
	}

	flushSync(): void {
		const path = this.activePath || this.resolvePath();
		if (!path) return;
		const payload = this.takePayload();
		if (!payload) return;
		try {
			this.ensureDirectory(path);
			this.rotateIfNeeded(path, payload.length);
			appendFileSync(path, payload, "utf8");
			this.knownSize = this.knownSize + payload.length;
		} catch {
			// 诊断失败不得影响调用方；丢弃该批次。
		}
	}

	private enqueue(entry: Record<string, unknown>): void {
		const path = this.resolvePath();
		if (!path) return;
		if (!this.acceptRate()) {
			this.suppressed += 1;
			this.schedule();
			return;
		}
		this.enqueueAccepted(path, entry);
	}

	private enqueueAccepted(path: string, entry: Record<string, unknown>): void {
		try {
			if (path !== this.activePath) {
				this.flushSync();
				this.activePath = path;
				this.lines = [];
				this.lastSignature = "";
				this.lastSignatureAt = 0;
				this.knownSize = -1;
			}
			const signature = signatureOf(entry);
			const now = Date.now();
			if (
				!unlimited
				&& this.dedupeWindowMs > 0
				&& signature === this.lastSignature
				&& now - this.lastSignatureAt <= this.dedupeWindowMs
			) {
				this.repeated += 1;
				this.repeatedEvent = typeof entry.event === "string" ? entry.event : "";
				this.lastSignatureAt = now;
				this.schedule();
				return;
			}
			this.lastSignature = signature;
			this.lastSignatureAt = now;
			this.lines.push(JSON.stringify(entry));
			if (this.lines.length >= this.maxBufferedLines) {
				this.flushAsync();
				return;
			}
			this.schedule();
		} catch {
			// 条目构建/序列化失败时不记录，也不影响调用方。
		}
	}

	private acceptRate(): boolean {
		if (unlimited) return true;
		const now = Date.now();
		if (now - this.rateWindowStart >= 1000) {
			this.rateWindowStart = now;
			this.rateCount = 0;
		}
		if (this.rateCount >= this.maxEntriesPerSecond) return false;
		this.rateCount += 1;
		return true;
	}

	private schedule(): void {
		if (this.timer || this.flushing) return;
		const delay = process.env[SYNC_FLUSH_ENV] === "1" ? 0 : this.flushDelayMs;
		if (delay === 0) {
			this.flushAsync();
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.flushAsync();
		}, delay);
		this.timer.unref?.();
	}

	private flushAsync(): void {
		if (this.flushing) return;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const path = this.activePath || this.resolvePath();
		if (!path) return;
		const payload = this.takePayload();
		if (!payload) return;
		this.flushing = true;
		try {
			this.ensureDirectory(path);
			this.rotateIfNeeded(path, payload.length);
			appendFile(path, payload, "utf8", () => {
				this.flushing = false;
				if (this.lines.length > 0 || this.suppressed > 0 || this.repeated > 0) this.schedule();
			});
			this.knownSize = this.knownSize + payload.length;
		} catch {
			this.flushing = false;
		}
	}

	private takePayload(): string {
		let payload = "";
		if (this.lines.length > 0) {
			payload += `${this.lines.join("\n")}\n`;
			this.lines = [];
		}
		if (this.repeated > 0) {
			payload += `${JSON.stringify({ event: "debug-log-repeat", name: this.name, repeats: this.repeated, lastEvent: this.repeatedEvent })}\n`;
			this.repeated = 0;
			this.repeatedEvent = "";
		}
		if (this.suppressed > 0) {
			payload += `${JSON.stringify({ event: "debug-log-suppressed", name: this.name, dropped: this.suppressed })}\n`;
			this.suppressed = 0;
		}
		return payload;
	}

	private ensureDirectory(path: string): void {
		const directory = dirname(path);
		if (directory === this.preparedDirectory) return;
		mkdirSync(directory, { recursive: true });
		this.preparedDirectory = directory;
	}

	private rotateIfNeeded(path: string, incomingBytes: number): void {
		const now = Date.now();
		if (this.knownSize < 0 || now - this.sizeCheckedAt > SIZE_RECHECK_MS) {
			this.knownSize = readSize(path);
			this.sizeCheckedAt = now;
		}
		if (this.knownSize < 0) {
			this.knownSize = 0;
			return;
		}
		if (this.knownSize + incomingBytes <= this.maxBytes) return;
		// 超限时截断重建，保证单文件体积有界；旧内容由轮转标记说明。
		try {
			writeFileSync(path, "", "utf8");
		} catch {
			this.knownSize = 0;
			return;
		}
		this.knownSize = 0;
		try {
			appendFileSync(path, `${JSON.stringify({ event: "debug-log-rotated", name: this.name, limitBytes: this.maxBytes })}\n`, "utf8");
		} catch {
			// 标记写入失败不阻塞主日志。
		}
	}

	private resolvePath(): string {
		try {
			const value = this.getPath();
			return typeof value === "string" ? value : "";
		} catch {
			return "";
		}
	}
}

function readSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return -1;
	}
}

/** 生成不含易变字段的签名，用于折叠连续重复条目。 */
function signatureOf(entry: Record<string, unknown>): string {
	let hash = 2166136261;
	const text = stableStringify(entry);
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).filter((key) => key !== "seq" && key !== "timestamp").sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
