/** 功能：使用真实 Pi ToolExecutionComponent 验证内联图片被抑制且 Alps 工具框保持紧凑。 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

const agentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const agentRequire = createRequire(agentEntry);
const agentTui = await import(pathToFileURL(agentRequire.resolve("@earendil-works/pi-tui")).href);
const {
	getCapabilities,
	getCellDimensions,
	setCapabilities,
	setCellDimensions,
	Text,
	stripTerminalSequences,
} = agentTui;
import { isImageEscapeLine } from "../src/features/chrome-frame/image.ts";
import { createInitialPatchState, disablePatch, enablePatch, PATCH_KEY } from "../src/features/chrome-frame/patch.ts";

function createRealTool(payload: string, content: any[] = [{ type: "text", text: "image" }]): ToolExecutionComponent {
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
	component.updateResult({ content, isError: false });
	return component;
}

for (const [protocol, payload] of [
	["Kitty", "\x1b_Gf=100,a=T;AAAA\x1b\\"],
	["iTerm", "\x1b]1337;File=name=test.png;inline=1:AAAA\x07"],
] as const) {
	test(`真实 ToolExecutionComponent ${protocol} payload 被移除且保留工具框`, () => {
		initTheme("dark");
		(globalThis as any)[PATCH_KEY] = createInitialPatchState();
		enablePatch();
		try {
			const lines = createRealTool(payload).render(80);
			const joined = lines.join("\n");
			assert.equal(joined.split(payload).length - 1, 0);
			assert.match(stripTerminalSequences(lines[0] ?? ""), /TOOL image-test/);
		} finally {
			disablePatch();
			(globalThis as any)[PATCH_KEY] = createInitialPatchState();
		}
	});
}

test("真实 Image 子组件输出被移除，并折叠图片高度占位", () => {
	const previousCapabilities = getCapabilities();
	const previousCellDimensions = getCellDimensions();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	setCellDimensions({ widthPx: 9, heightPx: 18 });
	initTheme("dark");
	(globalThis as any)[PATCH_KEY] = createInitialPatchState();
	enablePatch();
	try {
		const pngHeader = Buffer.alloc(24);
		Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(pngHeader);
		pngHeader.writeUInt32BE(256, 16);
		pngHeader.writeUInt32BE(256, 20);
		const component = createRealTool("image preview", [
			{ type: "text", text: "image preview" },
			{ type: "image", data: pngHeader.toString("base64"), mimeType: "image/png" },
		]);
		const image = (component as any).imageComponents[0];
		assert.ok(image, "expected ToolExecutionComponent to create an Image child");
		const widths: number[] = [];
		const renderedRowCounts: number[] = [];
		const originalImageRender = image.render.bind(image);
		image.render = (width: number) => {
			widths.push(width);
			const rendered = originalImageRender(width);
			renderedRowCounts.push(rendered.length);
			return rendered;
		};

		const first = component.render(80);
		const second = component.render(80);

		assert.equal(widths.length, 2);
		assert.equal(widths[0], widths[1]);
		assert.ok(renderedRowCounts.every((count) => count > 1), "fixture should produce image height placeholders");
		assert.ok(first.every((line) => !isImageEscapeLine(line)));
		assert.ok(second.every((line) => !isImageEscapeLine(line)));
		assert.equal(first.filter((line) => line === "").length, 0);
		assert.equal(second.filter((line) => line === "").length, 0);
		assert.match(stripTerminalSequences(first[0] ?? ""), /TOOL image-test/);
	} finally {
		disablePatch();
		(globalThis as any)[PATCH_KEY] = createInitialPatchState();
		setCapabilities(previousCapabilities);
		setCellDimensions(previousCellDimensions);
	}
});
