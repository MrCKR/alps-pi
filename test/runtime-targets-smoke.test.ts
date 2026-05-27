/** 功能：验证真实导出组件 target smoke 与 enable/disable 可恢复 实现者：alps 实现日期：2026-05-26 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	PATCH_KEY,
	createInitialPatchState,
	createRuntimeTargets,
	disablePatch,
	enablePatch,
} from "../src/features/chrome-frame/patch.ts";
import { createFakeTheme } from "./helpers.test.ts";

test.beforeEach(() => {
	(globalThis as any)[PATCH_KEY] = createInitialPatchState();
});

test.afterEach(() => {
	disablePatch(createRuntimeTargets(createFakeTheme()));
	(globalThis as any)[PATCH_KEY] = createInitialPatchState();
});


test("createRuntimeTargets 使用真实导出组件且不包含基础 Loader", () => {
	const targets = createRuntimeTargets(createFakeTheme());
	assert.ok(targets.length >= 8);
	assert.equal(targets.some((target) => target.id === "Loader"), false);
	for (const target of targets) {
		assert.equal(typeof target.id, "string");
		assert.ok(target.ctor, `${target.id} ctor missing`);
		assert.ok(target.ctor.prototype, `${target.id} prototype missing`);
		assert.equal(typeof target.ctor.prototype.render, "function", `${target.id} prototype.render missing`);
	}
});


test("真实 targets enable/disable 能恢复 prototype.render", () => {
	const targets = createRuntimeTargets(createFakeTheme());
	const originals = new Map(targets.map((target) => [target.id, target.ctor.prototype.render]));
	const enabled = enablePatch(targets);
	assert.equal(enabled.enabled, true);
	for (const target of targets) {
		assert.notEqual(target.ctor.prototype.render, originals.get(target.id), target.id);
	}
	const disabled = disablePatch(targets);
	assert.equal(disabled.enabled, false);
	assert.equal(disabled.patched.size, 0);
	for (const target of targets) {
		assert.equal(target.ctor.prototype.render, originals.get(target.id), target.id);
	}
});
