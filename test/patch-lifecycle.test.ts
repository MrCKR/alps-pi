/** 功能：验证 monkey patch 生命周期与安全回退 实现者：alps 实现日期：2026-05-26 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	PATCH_KEY,
	createInitialPatchState,
	createWrappedRender,
	disablePatch,
	enablePatch,
	getGlobalPatchState,
	type ComponentTarget,
} from "../src/features/chrome-frame/patch.ts";
import { createFakeTheme, stripAnsi } from "./helpers.test.ts";

class UserFake {
	render(width: number) {
		return [`user:${width}`];
	}
}

class AssistantFake {
	render(width: number) {
		return [`assistant:${width}`];
	}
}

class OtherFake {
	render(width: number) {
		return [`other:${width}`];
	}
}

function targets(theme = createFakeTheme()): ComponentTarget[] {
	return [
		{ id: "UserMessageComponent", kind: "user", ctor: UserFake, core: true, getTheme: () => theme },
		{ id: "AssistantMessageComponent", kind: "assistant", ctor: AssistantFake, core: true, getTheme: () => theme },
		{ id: "CustomMessageComponent", kind: "custom", ctor: OtherFake, getTheme: () => theme },
	];
}

function resetPrototypes() {
	UserFake.prototype.render = function render(width: number) {
		return [`user:${width}`];
	};
	AssistantFake.prototype.render = function render(width: number) {
		return [`assistant:${width}`];
	};
	OtherFake.prototype.render = function render(width: number) {
		return [`other:${width}`];
	};
}

test.beforeEach(() => {
	resetPrototypes();
	(globalThis as any)[PATCH_KEY] = createInitialPatchState();
});

test.afterEach(() => {
	disablePatch(targets());
	resetPrototypes();
	(globalThis as any)[PATCH_KEY] = createInitialPatchState();
});

test("初始状态 disabled 且保存在 Symbol.for 下", () => {
	const state = getGlobalPatchState();
	assert.equal(state.enabled, false);
	assert.equal((globalThis as any)[Symbol.for("alps.pi.patch.v1")], state);
});

test("enablePatch 保存原始 render 并替换 prototype render", () => {
	const list = targets();
	const original = UserFake.prototype.render;
	const state = enablePatch(list);
	assert.equal(state.enabled, true);
	assert.equal(state.originals.get("UserMessageComponent"), original);
	assert.notEqual(UserFake.prototype.render, original);
	assert.ok(state.patched.has("UserMessageComponent"));
});

test("重复 enablePatch 不会重复包裹", () => {
	const list = targets();
	enablePatch(list);
	const first = UserFake.prototype.render;
	const originalCount = getGlobalPatchState().originals.size;
	enablePatch(list);
	assert.equal(UserFake.prototype.render, first);
	assert.equal(getGlobalPatchState().originals.size, originalCount);
});

test("disablePatch 会恢复原始 render，重复 disable 不抛异常", () => {
	const list = targets();
	const original = UserFake.prototype.render;
	enablePatch(list);
	disablePatch(list);
	assert.equal(UserFake.prototype.render, original);
	assert.equal(getGlobalPatchState().enabled, false);
	assert.equal(getGlobalPatchState().patched.size, 0);
	assert.doesNotThrow(() => disablePatch(list));
});

test("disablePatch 遇到后续第三方 wrapper 时跳过恢复，避免覆盖其它扩展", () => {
	const list = targets();
	enablePatch(list);
	const alpsWrapped = UserFake.prototype.render;
	function thirdPartyWrapped(this: UserFake, width: number) {
		return alpsWrapped.call(this, width);
	}
	UserFake.prototype.render = thirdPartyWrapped as typeof UserFake.prototype.render;

	const state = disablePatch(list);

	assert.equal(UserFake.prototype.render, thirdPartyWrapped);
	assert.equal(state.patched.has("UserMessageComponent"), false);
	assert.match(state.failures.get("UserMessageComponent") ?? "", /skip restore/);
});



test("disable-skip 后再次 enable 对未知 wrapper fail closed 且不叠加 alps wrapper", () => {
	const list = targets();
	enablePatch(list);
	const alpsWrapped = UserFake.prototype.render;
	function thirdPartyWrapped(this: UserFake, width: number) {
		return alpsWrapped.call(this, width);
	}
	UserFake.prototype.render = thirdPartyWrapped as typeof UserFake.prototype.render;
	disablePatch(list);

	const state = enablePatch(list);
	const output = new UserFake().render(28).map(stripAnsi).join("\n");

	assert.equal(UserFake.prototype.render, thirdPartyWrapped);
	assert.equal(state.enabled, false);
	assert.match(state.failures.get("UserMessageComponent") ?? "", /skip enable/);
	assert.equal((output.match(/USER/g) ?? []).length, 1);
});

test("部分组件缺失时记录 failure，不影响其他组件", () => {
	const list = targets();
	list.push({ id: "MissingComponent", kind: "branch", ctor: undefined, getTheme: () => createFakeTheme() });
	const state = enablePatch(list);
	assert.equal(state.enabled, true);
	assert.ok(state.failures.has("MissingComponent"));
	assert.ok(state.patched.has("UserMessageComponent"));
});

test("核心组件 patch 失败时自动回滚全部 patch", () => {
	class BrokenCore {}
	const list: ComponentTarget[] = [
		{ id: "UserMessageComponent", kind: "user", ctor: UserFake, core: true, getTheme: () => createFakeTheme() },
		{ id: "AssistantMessageComponent", kind: "assistant", ctor: BrokenCore, core: true, getTheme: () => createFakeTheme() },
	];
	const original = UserFake.prototype.render;
	const state = enablePatch(list);
	assert.equal(state.enabled, false);
	assert.equal(UserFake.prototype.render, original);
	assert.ok(state.failures.has("AssistantMessageComponent"));
	assert.equal(state.patched.size, 0);
});

test("patched render 抛异常时回退原始 render", () => {
	const list = targets();
	enablePatch(list);
	const instance = new UserFake();
	const lines = instance.render(1);
	assert.deepEqual(lines.map(stripAnsi), ["u"]);
});


test("实际 wrapper 窄宽度 fallback 会净化危险 terminal escape", () => {
	class DangerousFake {
		render(_width: number) {
			return ["A\x1b]52;c;AAAA\x07B\x1b[2JC\x1bPpayload\x1b\\D\x1b_payload\x1b\\E\x1b^pm\x1b\\F\x1b[31mG"];
		}
	}
	const list: ComponentTarget[] = [
		{ id: "DangerousMessageComponent", kind: "custom", ctor: DangerousFake, core: true, getTheme: () => createFakeTheme() },
	];
	enablePatch(list);

	for (const width of [1, 5, 7]) {
		const output = new DangerousFake().render(width).join("");
		assert.doesNotMatch(output, /\x1b\]52/);
		assert.doesNotMatch(output, /\x1b\[2J/);
		assert.doesNotMatch(output, /\x1bP/);
		assert.doesNotMatch(output, /\x1b_/);
		assert.doesNotMatch(output, /\x1b\^/);
		assert.doesNotMatch(output, /payload|pm/);
		assert.doesNotMatch(output, /\x1b\[(?![0-9;:]*m)/);
		assert.ok(output.length <= width + 16, output);
	}
});

test("模拟 reload 后再次加载模块不重复 patch", () => {
	const list = targets();
	enablePatch(list);
	const first = UserFake.prototype.render;
	const state = getGlobalPatchState();
	assert.equal(state.enabled, true);
	const secondState = enablePatch(list);
	assert.equal(secondState, state);
	assert.equal(UserFake.prototype.render, first);
});

test("模拟缺少元数据的 wrapper 热重载后会迁移到当前 wrapper 且保留原始 render", () => {
	const list = targets();
	const original = UserFake.prototype.render;
	// 模拟已 patch 但没有当前 wrapper 元数据的 render。
	const oldWrapped = function oldAlpsChromeWrappedRender(this: UserFake, width: number) {
		return original.call(this, width);
	};
	UserFake.prototype.render = oldWrapped as typeof UserFake.prototype.render;
	const state = getGlobalPatchState();
	state.enabled = true;
	state.patched.add("UserMessageComponent");
	state.originals.set("UserMessageComponent", original);

	enablePatch(list);

	assert.notEqual(UserFake.prototype.render, oldWrapped);
	assert.notEqual(UserFake.prototype.render, original);
	disablePatch(list);
	assert.equal(UserFake.prototype.render, original);
});

test("模拟同 key 不同版本 wrapper 热重载后会重新包裹", () => {
	const list = targets();
	const original = UserFake.prototype.render;
	const oldWrapped = function oldVersionWrappedRender(this: UserFake, width: number) {
		return original.call(this, width);
	};
	Object.defineProperty(oldWrapped, Symbol.for("alps.pi.wrappedRender.v2"), {
		value: { id: "UserMessageComponent", version: 2, originalRender: original },
		configurable: false,
	});
	UserFake.prototype.render = oldWrapped as typeof UserFake.prototype.render;
	const state = getGlobalPatchState();
	state.enabled = true;
	state.patched.add("UserMessageComponent");
	state.originals.set("UserMessageComponent", original);

	enablePatch(list);

	assert.notEqual(UserFake.prototype.render, oldWrapped);
	disablePatch(list);
	assert.equal(UserFake.prototype.render, original);
});

test("patched render 产生单层 box", () => {
	const list = targets();
	enablePatch(list);
	const lines = new AssistantFake().render(28);
	const plain = lines.map(stripAnsi).join("\n");
	assert.match(plain, /ASSISTANT/);
	assert.equal((plain.match(/ASSISTANT/g) ?? []).length, 1);
});
