/** 功能：验证 chrome-frame 调试 JSONL 日志默认关闭、摘要脱敏与分支记录 实现者：alps 实现日期：2026-05-31 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderNeonBox } from "../src/features/chrome-frame/chrome.ts";
import { createInitialPatchState, createWrappedRender, PATCH_KEY } from "../src/features/chrome-frame/patch.ts";
import { createFakeTheme } from "./helpers.test.ts";

const START = "\x1b]133;A\x07";
const END = "\x1b]133;B\x07";

class DebugComponent {
	content: string[];
	constructor(content: string[]) {
		this.content = content;
	}
	render(_width?: number) {
		return this.content;
	}
}

class ThinkingComponent extends DebugComponent {
	hideThinkingBlock = true;
	lastMessage = { content: [{ type: "thinking", thinking: "hidden thought" }] };
}

class WidthDebugComponent extends DebugComponent {
	seenWidth = 0;
	render(width: number) {
		this.seenWidth = width;
		return this.content;
	}
}

class ThrowOnceDebugComponent {
	calls = 0;
	fallbackLines: string[];
	constructor(fallbackLines: string[]) {
		this.fallbackLines = fallbackLines;
	}
	render(_width: number) {
		this.calls += 1;
		if (this.calls === 1) throw new Error("boom");
		return this.fallbackLines;
	}
}

function withDebugEnv<T>(value: string | undefined, callback: () => T): T {
	const previous = process.env.ALPS_PI_FRAME_DEBUG_LOG;
	if (value === undefined) delete process.env.ALPS_PI_FRAME_DEBUG_LOG;
	else process.env.ALPS_PI_FRAME_DEBUG_LOG = value;
	try {
		(globalThis as any)[PATCH_KEY] = createInitialPatchState();
		return callback();
	} finally {
		if (previous === undefined) delete process.env.ALPS_PI_FRAME_DEBUG_LOG;
		else process.env.ALPS_PI_FRAME_DEBUG_LOG = previous;
		(globalThis as any)[PATCH_KEY] = createInitialPatchState();
	}
}

function tempLogPath(): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "alps-frame-debug-"));
	return { dir, path: join(dir, "frame.jsonl") };
}

function readEntries(path: string): any[] {
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("未设置 ALPS_PI_FRAME_DEBUG_LOG 时不创建日志且渲染保持 chrome-frame 基线", () => {
	const { dir, path } = tempLogPath();
	try {
		withDebugEnv(undefined, () => {
			const wrapped = createWrappedRender("DebugUser", "user", WidthDebugComponent.prototype.render, () => createFakeTheme());
			const instance = new WidthDebugComponent(["hello"]);
			const lines = wrapped.call(instance, 40);
			assert.deepEqual(lines, renderNeonBox("user", ["hello"], 40, createFakeTheme()));
			assert.equal(instance.seenWidth, 36);
			assert.ok(lines.every((line) => visibleWidth(line) <= 40));
			assert.ok(lines.some((line) => visibleWidth(line) === 40));
			assert.equal(existsSync(path), false);
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("error fallback 在调试关闭时返回原始 fallback 且不创建日志", () => {
	const { dir, path } = tempLogPath();
	const fallbackLines = ["\x1b]52;c;AAAA\x07raw fallback line that must stay intact", "second fallback line"];
	try {
		withDebugEnv(undefined, () => {
			const wrapped = createWrappedRender("DebugErrorFallbackOff", "user", ThrowOnceDebugComponent.prototype.render, () => createFakeTheme());
			const instance = new ThrowOnceDebugComponent(fallbackLines);
			assert.deepEqual(wrapped.call(instance, 30), fallbackLines);
			assert.equal(instance.calls, 2);
			assert.equal(existsSync(path), false);
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("error fallback 在调试开启时记录 errorFallback 但仍返回原始 fallback", () => {
	const { dir, path } = tempLogPath();
	const fallbackLines = ["\x1b]52;c;AAAA\x07raw fallback line that must stay intact", "second fallback line"];
	try {
		withDebugEnv(path, () => {
			const wrapped = createWrappedRender("DebugErrorFallbackOn", "assistant", ThrowOnceDebugComponent.prototype.render, () => createFakeTheme());
			const instance = new ThrowOnceDebugComponent(fallbackLines);
			assert.deepEqual(wrapped.call(instance, 30), fallbackLines);
			assert.equal(instance.calls, 2);
		});
		const [entry] = readEntries(path);
		assert.equal(entry.targetId, "DebugErrorFallbackOn");
		assert.equal(entry.branch, "errorFallback");
		assert.equal(entry.error, "Error");
		assert.equal(entry.boxedLineCount, fallbackLines.length);
		assert.equal(entry.lines.length, fallbackLines.length);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("设置绝对路径时写 JSONL render 与 line 摘要并记录 OSC133/visibleWidth/branch", () => {
	const { dir, path } = tempLogPath();
	try {
		withDebugEnv(path, () => {
			const wrapped = createWrappedRender("DebugAssistant", "assistant", DebugComponent.prototype.render, () => createFakeTheme());
			wrapped.call(new DebugComponent([`${START}hello`, `${END}world`]), 48);
		});
		const [entry] = readEntries(path);
		assert.equal(entry.event, "chrome-frame-render");
		assert.equal(entry.targetId, "DebugAssistant");
		assert.equal(entry.targetKind, "assistant");
		assert.equal(entry.inputWidth, 48);
		assert.equal(entry.resolvedFrameWidth, 48);
		assert.equal(entry.originalLineCount, 2);
		assert.equal(entry.displayedLineCount, 2);
		assert.equal(entry.boxedLineCount, entry.lines.length);
		assert.equal(entry.branch, "normal");
		assert.ok(entry.cacheKeySummary.startsWith("len:"));
		const topLine = entry.lines.find((line: any) => line.role === "top");
		const contentLines = entry.lines.filter((line: any) => line.role === "content");
		const bottomLine = entry.lines.find((line: any) => line.role === "bottom");
		assert.ok(topLine);
		assert.ok(contentLines.length > 0);
		assert.ok(bottomLine);
		assert.ok(entry.lines.every((line: any) => typeof line.visibleWidth === "number"));
		assert.equal(topLine.startsWithOsc133, true);
		assert.equal(topLine.containsOsc133, true);
		assert.equal(bottomLine.startsWithOsc133, true);
		assert.equal(bottomLine.containsOsc133, true);
		assert.ok(contentLines.every((line: any) => line.startsWithOsc133 === false));
		assert.ok(entry.lines.every((line: any) => Array.isArray(line.tailCodepoints)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("调试日志不写短文本 literal 或普通正文可还原 codepoints", () => {
	const { dir, path } = tempLogPath();
	try {
		withDebugEnv(path, () => {
			const wrapped = createWrappedRender("DebugRedacted", "user", DebugComponent.prototype.render, () => createFakeTheme());
			wrapped.call(new DebugComponent(["SECRET", "短中文"]), 80);
		});
		const rawLog = readFileSync(path, "utf8");
		assert.doesNotMatch(rawLog, /SECRET/);
		assert.doesNotMatch(rawLog, /短中文/);
		assert.doesNotMatch(rawLog, /U\+0053|U\+0045|U\+0043|U\+0052|U\+0054/);
		assert.doesNotMatch(rawLog, /U\+77ED|U\+4E2D|U\+6587/);
		const [entry] = readEntries(path);
		for (const line of entry.lines) {
			assert.ok(line.prefixPreview.length <= 24);
			assert.ok(line.suffixPreview.length <= 24);
			assert.match(line.prefixPreview, /^[BLDOPSUW]*$/);
			assert.match(line.suffixPreview, /^[BLDOPSUW]*$/);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("调试日志不写 OSC/DCS/APC/PM/image payload literal 或可还原尾部正文 codepoints", () => {
	const { dir, path } = tempLogPath();
	const oscPayload = "\x1b]52;c;" + "OSC-PAYLOAD".repeat(6) + "\x07";
	const dcsPayload = "\x1bP" + "DCS-PAYLOAD".repeat(6) + "\x1b\\";
	const apcPayload = "\x1b_" + "APC-PAYLOAD".repeat(6) + "\x1b\\";
	const pmPayload = "\x1b^" + "PM-PAYLOAD".repeat(6) + "\x1b\\";
	const imagePayload = "\x1b_Gf=100,a=T;IMAGE-PAYLOAD\x1b\\";
	try {
		withDebugEnv(path, () => {
			const wrapped = createWrappedRender("DebugPayload", "tool", DebugComponent.prototype.render, () => createFakeTheme(), { suppressInlineImages: true });
			const instance = new DebugComponent([`${oscPayload}${dcsPayload}${apcPayload}${pmPayload}`, imagePayload]);
			(instance as any).expanded = true;
			wrapped.call(instance, 80);
		});
		const rawLog = readFileSync(path, "utf8");
		assert.doesNotMatch(rawLog, /OSC-PAYLOAD|DCS-PAYLOAD|APC-PAYLOAD|PM-PAYLOAD|IMAGE-PAYLOAD/);
		assert.doesNotMatch(rawLog, /U\+004F|U\+0053|U\+0043|U\+0050|U\+0041|U\+0059|U\+004C|U\+004F|U\+0044/);
		const [entry] = readEntries(path);
		assert.equal(entry.branch, "imageSuppressed");
		assert.equal(entry.hasImageLine, true);
		assert.ok(entry.lines.every((line: any) => !line.isImageLine));
		for (const line of entry.lines) {
			assert.ok(Array.isArray(line.tailCodepoints));
			if (line.isImageLine) assert.deepEqual(line.tailCodepoints, []);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("debug JSONL 在 cacheHit 和 streaming thinking 中证明 content 行不以 OSC133 开头", () => {
	const { dir, path } = tempLogPath();
	try {
		withDebugEnv(path, () => {
			const cached = createWrappedRender("DebugOscCache", "assistant", DebugComponent.prototype.render, () => createFakeTheme());
			const instance = new DebugComponent([`${START}cache`, `${END}hit`]);
			cached.call(instance, 50);
			cached.call(instance, 50);

			class StreamingThinkingDebugComponent extends DebugComponent {
				hideThinkingBlock = false;
				lastMessage = { content: [{ type: "thinking", thinking: "visible thought" }] };
			}
			const streaming = createWrappedRender("DebugStreamingThinking", "assistant", StreamingThinkingDebugComponent.prototype.render, () => createFakeTheme());
			streaming.call(new StreamingThinkingDebugComponent([`${START}thinking`, `${END}still thinking`]), 50);
		});
		const entries = readEntries(path);
		for (const entry of entries.filter((item) => item.targetId === "DebugOscCache" || item.targetId === "DebugStreamingThinking")) {
			const topLine = entry.lines.find((line: any) => line.role === "top");
			const bottomLine = entry.lines.find((line: any) => line.role === "bottom");
			const contentLines = entry.lines.filter((line: any) => line.role === "content");
			assert.ok(topLine?.containsOsc133, entry.targetId);
			assert.ok(bottomLine?.containsOsc133, entry.targetId);
			assert.ok(contentLines.length > 0, entry.targetId);
			assert.ok(contentLines.every((line: any) => line.startsWithOsc133 === false), entry.targetId);
			assert.equal(entry.lines.reduce((total: number, line: any) => total + line.controlSummary.osc133, 0), 2, entry.targetId);
		}
		assert.ok(entries.some((entry) => entry.targetId === "DebugOscCache" && entry.branch === "cacheHit"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("可区分 compactThinking、cacheHit 与 imageSuppressed 分支", () => {
	const { dir, path } = tempLogPath();
	try {
		withDebugEnv(path, () => {
			const normal = createWrappedRender("DebugCache", "assistant", DebugComponent.prototype.render, () => createFakeTheme());
			const instance = new DebugComponent(["cache me"]);
			normal.call(instance, 50);
			normal.call(instance, 50);

			const compact = createWrappedRender("DebugThinking", "assistant", ThinkingComponent.prototype.render, () => createFakeTheme());
			compact.call(new ThinkingComponent(["hidden thought"]), 50);

			const image = createWrappedRender("DebugImage", "tool", DebugComponent.prototype.render, () => createFakeTheme(), { suppressInlineImages: true });
			const imageInstance = new DebugComponent(["\x1b_Gf=100,a=T;IMAGE-PAYLOAD\x1b\\"]);
			(imageInstance as any).expanded = true;
			image.call(imageInstance, 50);
		});
		const entries = readEntries(path);
		assert.ok(entries.some((entry) => entry.branch === "normal"));
		assert.ok(entries.some((entry) => entry.branch === "cacheHit"));
		assert.ok(entries.some((entry) => entry.branch === "compactThinking"));
		assert.ok(entries.some((entry) => entry.branch === "imageSuppressed"));
		const imageEntry = entries.find((entry) => entry.branch === "imageSuppressed");
		assert.equal(imageEntry.hasImageLine, true);
		assert.ok(imageEntry.lines.every((line: any) => !line.isImageLine));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("日志路径不可写时 render 不抛出", () => {
	withDebugEnv(tmpdir(), () => {
		const wrapped = createWrappedRender("DebugFailOpen", "assistant", DebugComponent.prototype.render, () => createFakeTheme());
		const lines = wrapped.call(new DebugComponent(["hello"]), 40);
		assert.ok(lines.length >= 3);
	});
});
