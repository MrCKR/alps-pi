/** 功能：使用 Pi 0.84.4 真实消息组件验证 outputPad、CJK、窄宽与 Alps frame。 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	UserMessageComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createInitialPatchState, disablePatch, enablePatch, PATCH_KEY } from "../src/features/chrome-frame/patch.ts";

function plain(lines: string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line));
}

function contentColumn(lines: string[], text: string): number {
	const line = plain(lines).find((candidate) => candidate.includes(text));
	assert.ok(line, text);
	return line!.indexOf(text);
}

test("真实 User/Assistant/Thinking/Custom 组件遵循 outputPad=0/1 且宽度安全", () => {
	initTheme("dark");
	(globalThis as any)[PATCH_KEY] = createInitialPatchState();
	enablePatch();
	try {
		for (const [name, create, text, expectedDelta] of [
			["User", (pad: number) => new UserMessageComponent("中文用户", undefined, pad), "中文用户", 1],
			["Assistant", (pad: number) => new AssistantMessageComponent({ content: [{ type: "text", text: "中文助手" }] } as any, false, undefined, "Thinking...", pad), "中文助手", 1],
			["Thinking", (pad: number) => new AssistantMessageComponent({ content: [{ type: "thinking", thinking: "中文思考" }] } as any, false, undefined, "Thinking...", pad), "中文思考", 1],
			// Pi 的默认 CustomMessage renderer 在 0.84.4 不改变正文列；Alps 必须原样保留该宿主语义。
			["Custom", (pad: number) => new CustomMessageComponent({ role: "custom", customType: "test", content: "中文自定义", display: true } as any, undefined, undefined, pad), "中文自定义", 0],
		] as const) {
			const zero = create(0).render(48);
			const one = create(1).render(48);
			assert.equal(contentColumn(one, text), contentColumn(zero, text) + expectedDelta, name);
			assert.ok(zero.every((line) => visibleWidth(line) <= 48), `${name} pad0`);
			assert.ok(one.every((line) => visibleWidth(line) <= 48), `${name} pad1`);
			assert.ok(create(1).render(12).every((line) => visibleWidth(line) <= 12), `${name} narrow`);
		}
	} finally {
		disablePatch();
		(globalThis as any)[PATCH_KEY] = createInitialPatchState();
	}
});
