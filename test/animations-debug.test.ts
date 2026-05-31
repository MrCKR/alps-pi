/** 功能：验证 Animations 生命周期诊断日志默认关闭、脱敏与事件摘要。 实现者：alps 实现日期：2026-05-31 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureAnimations, disposeAnimations, getAnimationsRuntimeState, recordAnimationsLifecycleEvent, resumeAnimationsRuntime } from "../src/features/animations/index.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";

function withAnimDebugEnv<T>(value: string | undefined, callback: () => T): T {
	const previous = process.env.ALPS_PI_ANIM_DEBUG_LOG;
	if (value === undefined) delete process.env.ALPS_PI_ANIM_DEBUG_LOG;
	else process.env.ALPS_PI_ANIM_DEBUG_LOG = value;
	try {
		return callback();
	} finally {
		if (previous === undefined) delete process.env.ALPS_PI_ANIM_DEBUG_LOG;
		else process.env.ALPS_PI_ANIM_DEBUG_LOG = previous;
	}
}

function tempLogPath(): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "alps-anim-debug-"));
	return { dir, path: join(dir, "anim.jsonl") };
}

function readEntries(path: string): any[] {
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test.afterEach(() => {
	disposeAnimations();
});

test("未设置 ALPS_PI_ANIM_DEBUG_LOG 时不创建日志且不影响动画", () => {
	const { dir, path } = tempLogPath();
	try {
		withAnimDebugEnv(undefined, () => {
			configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "matrix3", width: "default" });
			const state = getAnimationsRuntimeState();
			state.currentCtx = { ui: { setWorkingMessage() {} } };
			resumeAnimationsRuntime();
			recordAnimationsLifecycleEvent("tool_execution_start", { id: "ctx" }, { toolCallId: "secret-tool-id", input: "SECRET_PROMPT" });
			assert.equal(state.animating, true);
			assert.equal(existsSync(path), false);
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("开启 ALPS_PI_ANIM_DEBUG_LOG 后写入脱敏 JSONL 摘要", () => {
	const { dir, path } = tempLogPath();
	try {
		withAnimDebugEnv(path, () => {
			configureAnimations({ ...DEFAULT_SETTINGS.animations, working: "matrix3", width: "default" });
			const state = getAnimationsRuntimeState();
			state.currentCtx = {
				id: "ctx-secret-id",
				ui: {
					requestRender() {},
					setWorkingIndicator() {},
					setWorkingMessage() {},
				},
			};
			resumeAnimationsRuntime();
			recordAnimationsLifecycleEvent("tool_execution_start", state.currentCtx, {
				toolCallId: "tool-secret-id",
				message: { content: "SECRET_PROMPT", usage: { input: 1 } },
			});
		});
		const raw = readFileSync(path, "utf8");
		assert.doesNotMatch(raw, /SECRET_PROMPT|tool-secret-id|ctx-secret-id/);
		const entries = readEntries(path);
		assert.ok(entries.some((entry) => entry.event === "configure"));
		assert.ok(entries.some((entry) => entry.event === "resume"));
		assert.ok(entries.some((entry) => entry.event === "working_render"));
		const toolEntry = entries.find((entry) => entry.event === "tool_execution_start");
		assert.equal(toolEntry.payload.toolCallIdHash.length, 8);
		assert.equal(toolEntry.payload.hasMessage, true);
		assert.equal(toolEntry.uiApi.setWorkingMessage, true);
		assert.equal(toolEntry.workingIndicatorHidden, true);
		assert.equal(toolEntry.lastWorkingLines.count, 3);
		assert.deepEqual(toolEntry.toolCallIds, { count: 0, hashes: [] });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
