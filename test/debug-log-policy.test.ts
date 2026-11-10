/** 功能：验证诊断日志写入器的有界、去重、限速与异步语义 实现者：alps 实现日期：2026-11-10 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDebugLogSink, flushDebugLogsSync, resetDebugLogs, setDebugLogsUnlimited } from "../src/debug-log.ts";

function tempDir(): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "alps-debug-log-"));
	return { dir, path: join(dir, "log.jsonl") };
}

function readLines(path: string): any[] {
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("默认异步写入：写入后同一 tick 不产生文件，flush 后才落盘", () => {
	const { dir, path } = tempDir();
	const sink = createDebugLogSink({ name: "async", getPath: () => path, flushDelayMs: 5_000, maxEntriesPerSecond: 100 });
	try {
		sink.write({ event: "a", value: 1 });
		assert.equal(existsSync(path), false);
		flushDebugLogsSync();
		assert.equal(existsSync(path), true);
		assert.equal(readLines(path).length, 1);
	} finally {
		resetDebugLogs();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("连续相同条目折叠为一次并记录 repeats", () => {
	const { dir, path } = tempDir();
	setDebugLogsUnlimited(false);
	const sink = createDebugLogSink({ name: "dedupe", getPath: () => path, flushDelayMs: 5_000, maxEntriesPerSecond: 1_000, dedupeWindowMs: 5_000 });
	try {
		for (let index = 0; index < 200; index += 1) sink.write({ event: "bind_session", note: "same" });
		flushDebugLogsSync();
		const lines = readLines(path);
		assert.equal(lines.length, 2);
		assert.equal(lines[0].event, "bind_session");
		assert.equal(lines[1].event, "debug-log-repeat");
		assert.equal(lines[1].repeats, 199);
		assert.equal(lines[1].lastEvent, "bind_session");
	} finally {
		resetDebugLogs();
		setDebugLogsUnlimited(true);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("超过每秒上限的条目被丢弃并汇总 dropped 计数", () => {
	const { dir, path } = tempDir();
	setDebugLogsUnlimited(false);
	const sink = createDebugLogSink({ name: "rate", getPath: () => path, flushDelayMs: 5_000, maxEntriesPerSecond: 3, dedupeWindowMs: 0 });
	try {
		for (let index = 0; index < 50; index += 1) sink.write({ event: "tick", index });
		flushDebugLogsSync();
		const lines = readLines(path);
		const ticks = lines.filter((line) => line.event === "tick");
		const dropped = lines.find((line) => line.event === "debug-log-suppressed");
		assert.equal(ticks.length, 3);
		assert.equal(dropped.dropped, 47);
	} finally {
		resetDebugLogs();
		setDebugLogsUnlimited(true);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("单文件体积超过上限时截断并写轮转标记", () => {
	const { dir, path } = tempDir();
	setDebugLogsUnlimited(true);
	const sink = createDebugLogSink({ name: "rotate", getPath: () => path, maxBytes: 4096, flushDelayMs: 5_000, maxEntriesPerSecond: 1_000 });
	try {
		const padding = "x".repeat(600);
		for (let index = 0; index < 40; index += 1) {
			sink.write({ event: "big", index, padding });
			flushDebugLogsSync();
		}
		assert.ok(statSync(path).size <= 4096 * 2, `log size ${statSync(path).size}`);
		assert.ok(readLines(path).some((line) => line.event === "debug-log-rotated"));
	} finally {
		resetDebugLogs();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("路径解析为空时不写文件，reset 丢弃未刷新缓冲", () => {
	const { dir, path } = tempDir();
	const sink = createDebugLogSink({ name: "disabled", getPath: () => undefined, flushDelayMs: 5_000 });
	sink.write({ event: "ignored" });
	flushDebugLogsSync();
	assert.equal(existsSync(path), false);

	const enabled = createDebugLogSink({ name: "drop", getPath: () => path, flushDelayMs: 5_000 });
	try {
		enabled.write({ event: "pending" });
		resetDebugLogs();
		flushDebugLogsSync();
		assert.equal(existsSync(path), false);
	} finally {
		resetDebugLogs();
		rmSync(dir, { recursive: true, force: true });
	}
});
