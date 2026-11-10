/** 功能：验证 stdout 字节流诊断能识别被中断的未闭合转义序列 实现者：alps 实现日期：2026-11-10 */

import assert from "node:assert/strict";
import test from "node:test";
import { escapeForLog, scanOutputStream } from "../src/features/stream-diagnostic.ts";

test("正常写入结束后状态回到 ground", () => {
	const result = scanOutputStream("\x1b[?2026h\x1b[1;1H\x1b[2Khello\x1b[?2026l");
	assert.equal(result.state, "ground");
	assert.equal(result.interrupted, undefined);
	assert.equal(result.overlong, undefined);
});

test("分包写入不会被误报：未闭合序列延续到下一次写入", () => {
	const first = scanOutputStream("\x1b]1337;File=");
	assert.equal(first.state, "string");
	const second = scanOutputStream("payload\x07", first.state, first.openPrefix, first.csiLength);
	assert.equal(second.state, "ground");
	assert.equal(second.interrupted, undefined);
});

test("未闭合 OSC 后紧跟新 ESC 判定为中断，并记录开头", () => {
	const result = scanOutputStream("\x1b]1337;File=AAAA\x1b[?2026h");
	assert.ok(result.interrupted, "应识别为中断");
	assert.ok(result.interrupted?.openPrefix.startsWith("\x1b]1337;File="));
	// 中断后的 \x1b[?2026h 自身是完整序列，扫描最终回到 ground。
	assert.equal(result.state, "ground");
});

test("未闭合 CSI 后紧跟新 ESC 判定为中断", () => {
	const result = scanOutputStream("\x1b[38;2;106;111\x1b[0m");
	assert.ok(result.interrupted);
	assert.equal(result.interrupted?.openPrefix, "\x1b[38;2;106;111");
});

test("CSI 参数过长记录 overlong", () => {
	const result = scanOutputStream(`\x1b[${"1;".repeat(50)}`);
	assert.ok(result.overlong);
	assert.ok(result.overlong?.openPrefix.startsWith("\x1b[1;1;"));
});

test("escapeForLog 不输出原始控制字节", () => {
	const escaped = escapeForLog("\x1b]1337;File=\x07abc");
	assert.equal(escaped, "\\e]1337;File=\\aabc");
});
