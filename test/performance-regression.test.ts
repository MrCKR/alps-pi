/** 功能：验证 pi chrome 缓存能压低重复 TUI 帧渲染开销 实现者：alps 实现日期：2026-05-26 */

import assert from "node:assert/strict";
import test from "node:test";
import { createWrappedRender } from "../src/features/chrome-frame/patch.ts";
import { createFakeTheme } from "./helpers.test.ts";

class HeavyComponent {
	private readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	// 模拟真实历史消息：原始组件可稳定返回同样内容，外层 chrome 应复用缓存。
	render(_width: number) {
		return this.lines;
	}
}

function createHistory(count: number) {
	const original = HeavyComponent.prototype.render;
	const theme = createFakeTheme();
	const wrapped = createWrappedRender("Heavy", "assistant", original, () => theme);
	const blocks = Array.from({ length: count }, (_, index) => {
		const lines = [
			`历史消息 ${index} ${"中文内容".repeat(12)}`,
			`code ${index}: ${"const value = true; ".repeat(8)}`,
		];
		return new HeavyComponent(lines);
	});
	return { blocks, wrapped, theme };
}

test("重复渲染同一批历史块时，第二帧不再重复执行 box 样式计算", () => {
	const { blocks, wrapped, theme } = createHistory(135);
	for (const block of blocks) {
		wrapped.call(block, 100);
	}
	const callsAfterFirstFrame = theme.calls.length;

	for (const block of blocks) {
		wrapped.call(block, 100);
	}

	assert.ok(callsAfterFirstFrame > 0);
	assert.equal(theme.calls.length, callsAfterFirstFrame);
});

test("重复历史帧渲染应保持在轻量级预算内", () => {
	const { blocks, wrapped } = createHistory(135);
	for (const block of blocks) {
		wrapped.call(block, 100);
	}

	let totalLines = 0;
	let elapsed = Number.POSITIVE_INFINITY;
	// Use the best of three equal samples so parallel test-worker scheduling does
	// not turn a single preemption into a cache-path performance regression.
	for (let sample = 0; sample < 3; sample++) {
		const start = performance.now();
		for (let frame = 0; frame < 20; frame++) {
			for (const block of blocks) {
				totalLines += wrapped.call(block, 100).length;
			}
		}
		elapsed = Math.min(elapsed, performance.now() - start);
	}

	assert.ok(totalLines > 0);
	assert.ok(elapsed < 80, `best cached repeated-frame sample took ${elapsed.toFixed(2)}ms`);
});
