/** 功能：使用真实 Pi ToolExecutionComponent 验证图片 escape 原生回退。 */

import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import { createInitialPatchState, disablePatch, enablePatch, PATCH_KEY } from "../src/features/chrome-frame/patch.ts";

function createRealTool(payload: string): ToolExecutionComponent {
	const tui: any = {
		mode: "regular",
		terminal: { columns: 80, rows: 24, write() {} },
		requestRender() {},
	};
	const definition: any = {
		name: "image-test",
		label: "Image Test",
		description: "test",
		parameters: { type: "object", properties: {} },
		renderResult: () => new Text(payload, 0, 0),
	};
	const component = new ToolExecutionComponent("image-test", "tool-1", {}, { showImages: true }, definition, tui, process.cwd());
	component.markExecutionStarted();
	component.setArgsComplete();
	component.updateResult({ content: [{ type: "text", text: "image" }], isError: false });
	return component;
}

for (const [protocol, payload] of [
	["Kitty", "\x1b_Gf=100,a=T;AAAA\x1b\\"],
	["iTerm", "\x1b]1337;File=name=test.png;inline=1:AAAA\x07"],
] as const) {
	test(`真实 ToolExecutionComponent ${protocol} payload 原生回退且仅出现一次`, () => {
		initTheme("dark");
		(globalThis as any)[PATCH_KEY] = createInitialPatchState();
		enablePatch();
		try {
			const lines = createRealTool(payload).render(80);
			const joined = lines.join("\n");
			assert.equal(joined.split(payload).length - 1, 1);
			assert.doesNotMatch(stripTerminalSequences(joined), /TOOL image-test/);
		} finally {
			disablePatch();
			(globalThis as any)[PATCH_KEY] = createInitialPatchState();
		}
	});
}
