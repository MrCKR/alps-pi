/** 功能：验证 Pi 0.84+ 平台能力检测与 TUI mode 边界。 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	PI_COMPONENTS,
	formatPiCapabilityFailures,
	inspectPiRuntimeCapabilities,
	isTuiSessionContext,
	readPiTuiMode,
} from "../src/pi-compat.ts";

test("真实 Pi 0.84.4 组件满足 chrome-frame 与 animations 能力", () => {
	const capabilities = inspectPiRuntimeCapabilities({ mode: "fullscreen" });
	assert.equal(capabilities.chromeFrame.supported, true);
	assert.equal(capabilities.chromeFrame.failures.size, 0);
	assert.equal(capabilities.animations.supported, true);
	assert.equal(capabilities.animations.failure, undefined);
	assert.equal(capabilities.tui.supported, true);
	assert.equal(capabilities.tuiMode, "fullscreen");
});

test("缺少 render/updateContent 时返回精确的功能级失败", () => {
	class MissingRender {}
	class MissingUpdate {
		render() { return []; }
	}
	const capabilities = inspectPiRuntimeCapabilities(undefined, {
		...PI_COMPONENTS,
		UserMessageComponent: MissingRender,
		AssistantMessageComponent: MissingUpdate,
	});

	assert.equal(capabilities.chromeFrame.supported, false);
	assert.equal(capabilities.chromeFrame.failures.get("UserMessageComponent"), "prototype.render missing");
	assert.equal(capabilities.animations.supported, false);
	assert.match(capabilities.animations.failure ?? "", /updateContent missing/);
	assert.deepEqual(formatPiCapabilityFailures(capabilities), [
		"chrome-frame UserMessageComponent: prototype.render missing",
		"animations: AssistantMessageComponent.prototype.updateContent missing",
	]);
});

test("仅 Pi 0.84+ TUI context 和已知 renderer mode 被接受", () => {
	assert.equal(isTuiSessionContext({ mode: "tui", hasUI: true }), true);
	assert.equal(isTuiSessionContext({ mode: "rpc", hasUI: true }), false);
	assert.equal(isTuiSessionContext({ hasUI: true }), false);
	assert.equal(readPiTuiMode({ mode: "regular" }), "regular");
	assert.equal(readPiTuiMode({ mode: "fullscreen" }), "fullscreen");
	assert.equal(readPiTuiMode({ mode: "other" }), undefined);
	const unsupported = inspectPiRuntimeCapabilities({ mode: "other" });
	assert.equal(unsupported.tui.supported, false);
	assert.equal(unsupported.tui.failure, "unsupported Pi TUI renderer mode");
	assert.ok(formatPiCapabilityFailures(unsupported).includes("tui: unsupported Pi TUI renderer mode"));
});
