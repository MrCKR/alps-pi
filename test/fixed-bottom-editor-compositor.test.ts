/** 功能：验证 fixed bottom editor 最小 compositor 实现者：alps 实现日期：2026-05-27 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	FixedBottomEditorCompositor,
	beginSynchronizedOutput,
	clearLine,
	disableAlternateScrollMode,
	enableAlternateScrollMode,
	endSynchronizedOutput,
	enterAlternateScreen,
	exitAlternateScreen,
	moveCursor,
	resetScrollRegion,
	setScrollRegion,
	showCursor,
	type FixedEditorTerminal,
} from "../src/features/fixed-bottom-editor/compositor.ts";
import type { FixedEditorCluster } from "../src/features/fixed-bottom-editor/cluster.ts";

function createHarness(options: { overlay?: boolean; overlayStack?: unknown[]; rootLines?: string[] } = {}) {
	const writes: string[] = [];
	const renderCalls: number[] = [];
	const doRenderCalls: string[] = [];
	let backingRows = 10;
	const terminal: FixedEditorTerminal = {
		columns: 20,
		get rows() {
			return backingRows;
		},
		set rows(value: number) {
			backingRows = value;
		},
		write(data: string) {
			writes.push(data);
		},
	};
	const tui = {
		hardwareCursorRow: 4,
		cursorRow: 2,
		previousViewportTop: 1,
		overlayStack: options.overlayStack ?? [],
		hasOverlay: options.overlay === undefined ? undefined : () => options.overlay,
		render(width: number) {
			renderCalls.push(width);
			return options.rootLines ?? ["root-1", "root-2", "root-3", "root-4"];
		},
		doRender() {
			doRenderCalls.push("doRender");
		},
	};
	const cluster: FixedEditorCluster = {
		lines: ["editor", "footer"],
		cursor: { row: 0, col: 2 },
	};
	let renderClusterCalls = 0;
	const compositor = new FixedBottomEditorCompositor({
		tui,
		terminal,
		renderCluster: () => {
			renderClusterCalls += 1;
			return cluster;
		},
	});

	return {
		cluster,
		compositor,
		doRenderCalls,
		getRenderClusterCalls: () => renderClusterCalls,
		renderCalls,
		terminal,
		tui,
		writes,
		setRawRows(value: number) {
			backingRows = value;
		},
	};
}

test("terminal.write 在 setScrollRegion 后、普通 data 前对齐 cursor", () => {
	const harness = createHarness();
	harness.tui.hardwareCursorRow = 6;
	harness.tui.previousViewportTop = 2;

	harness.compositor.install();
	harness.terminal.write("payload");

	const output = harness.writes[1]!;
	const scrollRegionIndex = output.indexOf(setScrollRegion(1, 8));
	const cursorIndex = output.indexOf(moveCursor(5, 1));
	const payloadIndex = output.indexOf("payload");
	assert.ok(scrollRegionIndex >= 0);
	assert.ok(cursorIndex > scrollRegionIndex);
	assert.ok(payloadIndex > cursorIndex);
});

test("install 后进入 alternate screen、替换 terminal.write，并在 dispose 后恢复", () => {
	const harness = createHarness();
	const originalWrite = harness.terminal.write;

	harness.compositor.install();
	assert.notEqual(harness.terminal.write, originalWrite);
	assert.equal(harness.writes[0], beginSynchronizedOutput() + enterAlternateScreen() + disableAlternateScrollMode() + endSynchronizedOutput());

	harness.terminal.write("hello");
	assert.equal(harness.writes.length, 2);
	assert.equal(harness.writes[1], beginSynchronizedOutput()
		+ setScrollRegion(1, 8)
		+ moveCursor(4, 1)
		+ "hello"
		+ resetScrollRegion()
		+ moveCursor(9, 1)
		+ clearLine()
		+ "editor"
		+ moveCursor(10, 1)
		+ clearLine()
		+ "footer"
		+ moveCursor(9, 3)
		+ showCursor()
		+ endSynchronizedOutput());

	harness.compositor.dispose();
	assert.equal(harness.terminal.write, originalWrite);
	assert.ok(harness.writes.at(-1)?.includes(enableAlternateScrollMode() + exitAlternateScreen()));
	harness.terminal.write("after");
	assert.equal(harness.writes.at(-1), "after");
});

test("已有 compositor owner 时 install fail closed", () => {
	const harness = createHarness();
	const ownerSymbol = Object.getOwnPropertySymbols(harness.terminal)
		.find((symbol) => String(symbol).includes("fixedBottomEditor.compositorOwner"));
	assert.equal(ownerSymbol, undefined);

	const first = new FixedBottomEditorCompositor({
		tui: harness.tui,
		terminal: harness.terminal,
		renderCluster: () => ({ lines: ["first"] }),
	});
	first.install();
	assert.throws(() => harness.compositor.install(), /already owned/);
	assert.equal(harness.writes.length, 1);
	first.dispose();
});

test("install 中途失败时回滚已写入的 terminal/TUI patch", () => {
	const harness = createHarness();
	const originalWrite = harness.terminal.write;
	const originalRowsDescriptor = Object.getOwnPropertyDescriptor(harness.terminal, "rows");
	const originalRender = harness.tui.render;
	const originalDoRender = harness.tui.doRender;

	Object.preventExtensions(harness.tui);

	assert.throws(() => harness.compositor.install(), /not extensible|Cannot define property/);
	assert.equal(harness.terminal.write, originalWrite);
	assert.deepEqual(Object.getOwnPropertyDescriptor(harness.terminal, "rows"), originalRowsDescriptor);
	assert.equal(harness.tui.render, originalRender);
	assert.equal(harness.tui.doRender, originalDoRender);
	assert.equal(harness.terminal.rows, 10);
	assert.doesNotThrow(() => harness.terminal.write("after-failed-install"));
	assert.ok(harness.writes[0]?.includes(enterAlternateScreen()));
	assert.ok(harness.writes.some((write) => write.includes(exitAlternateScreen())));
	assert.equal(harness.writes.at(-1), "after-failed-install");
});

test("dispose 不覆盖后装 terminal.write", () => {
	const harness = createHarness();
	harness.compositor.install();
	const installWrites = [...harness.writes];
	const laterWrite = function laterWrite(data: string) {
		harness.writes.push(`later:${data}`);
	};
	harness.terminal.write = laterWrite;

	harness.compositor.dispose();

	assert.equal(harness.terminal.write, laterWrite);
	harness.terminal.write("after");
	assert.deepEqual(harness.writes, [
		...installWrites,
		beginSynchronizedOutput() + resetScrollRegion() + enableAlternateScrollMode() + exitAlternateScreen() + showCursor() + endSynchronizedOutput(),
		"later:after",
	]);
});

test("install 后重定义 terminal.rows，返回扣除 cluster 高度后的行数且最低保留 1", () => {
	const harness = createHarness();
	const originalRowsDescriptor = Object.getOwnPropertyDescriptor(harness.terminal, "rows");

	harness.compositor.install();
	assert.equal(harness.terminal.rows, 8);

	harness.setRawRows(2);
	assert.equal(harness.terminal.rows, 1);

	harness.compositor.dispose();
	assert.deepEqual(Object.getOwnPropertyDescriptor(harness.terminal, "rows"), originalRowsDescriptor);
	assert.equal(harness.terminal.rows, 2);
});

test("terminal.rows 来自原型 getter 时，dispose 删除实例 patch 并恢复原型 getter", () => {
	const writes: string[] = [];
	class TerminalWithPrototypeRows {
		columns = 20;
		private rawRows = 10;
		get rows() {
			return this.rawRows;
		}
		setRows(value: number) {
			this.rawRows = value;
		}
		write(data: string) {
			writes.push(data);
		}
	}
	const terminal = new TerminalWithPrototypeRows() as FixedEditorTerminal & TerminalWithPrototypeRows;
	const tui = {
		overlayStack: [],
		render: () => [],
		doRender() {},
	};
	const compositor = new FixedBottomEditorCompositor({
		tui,
		terminal,
		renderCluster: () => ({ lines: ["editor", "footer"] }),
	});

	compositor.install();
	assert.equal(Object.hasOwn(terminal, "rows"), true);
	assert.equal(terminal.rows, 8);
	terminal.setRows(3);
	assert.equal(terminal.rows, 1);

	compositor.dispose();
	assert.equal(Object.hasOwn(terminal, "rows"), false);
	assert.equal(terminal.rows, 3);
	assert.ok(writes.at(-1)?.includes(resetScrollRegion()));
});

test("render 超过可滚动区域时裁剪为最后的普通内容行", () => {
	const rootLines = Array.from({ length: 12 }, (_, index) => `root-${index + 1}`);
	const harness = createHarness({ rootLines });

	harness.compositor.install();

	assert.deepEqual(harness.tui.render(20), ["root-5", "root-6", "root-7", "root-8", "root-9", "root-10", "root-11", "root-12"]);
});

test("render 内容不足可滚动区域时补空行撑满 viewport", () => {
	const harness = createHarness({ rootLines: ["root-1", "root-2"] });

	harness.compositor.install();

	assert.deepEqual(harness.tui.render(20), ["root-1", "root-2", "", "", "", "", "", ""]);
});

test("install 后替换 tui.render 和 tui.doRender，并在 dispose 后恢复", () => {
	const harness = createHarness();
	const originalRender = harness.tui.render;
	const originalDoRender = harness.tui.doRender;

	harness.compositor.install();
	assert.notEqual(harness.tui.render, originalRender);
	assert.notEqual(harness.tui.doRender, originalDoRender);

	const lines = harness.tui.render(20);
	assert.deepEqual(lines, ["root-1", "root-2", "root-3", "root-4", "", "", "", ""]);
	harness.tui.doRender();
	assert.deepEqual(harness.doRenderCalls, ["doRender"]);
	assert.ok(harness.writes.some((write) => write.includes("editor")));

	harness.compositor.dispose();
	assert.equal(harness.tui.render, originalRender);
	assert.equal(harness.tui.doRender, originalDoRender);
});

test("hideRenderable 隐藏原 editor container，renderHidden 可调用原始 render", () => {
	const harness = createHarness();
	const editor = {
		calls: [] as number[],
		render(width: number) {
			this.calls.push(width);
			return [`editor:${width}`];
		},
	};
	const originalRender = editor.render;

	harness.compositor.install();
	harness.compositor.hideRenderable(editor);
	assert.notEqual(editor.render, originalRender);
	assert.deepEqual(editor.render(20), []);
	assert.deepEqual(harness.compositor.renderHidden(editor, 12), ["editor:12"]);
	assert.deepEqual(editor.calls, [12]);

	harness.compositor.dispose();
	assert.equal(editor.render, originalRender);
	assert.deepEqual(editor.render(8), ["editor:8"]);
});

test("dispose 重复调用不抛异常，并尽力写入 reset sequence", () => {
	const harness = createHarness();
	harness.compositor.install();

	assert.doesNotThrow(() => harness.compositor.dispose());
	assert.doesNotThrow(() => harness.compositor.dispose());

	const resetWrite = harness.writes.at(-1) ?? "";
	assert.ok(resetWrite.includes(resetScrollRegion()));
	assert.ok(resetWrite.includes(showCursor()));
});

test("tui.hasOverlay() 为 true 时，render/write/doRender 均让路给原始入口且不重绘 cluster", () => {
	const harness = createHarness({ overlay: true });
	const originalRender = harness.tui.render;
	const originalWrite = harness.terminal.write;

	harness.compositor.install();
	assert.equal(harness.terminal.rows, 10);
	assert.deepEqual(harness.tui.render(20), originalRender.call(harness.tui, 20));
	harness.terminal.write("overlay-write");
	harness.tui.doRender();

	assert.deepEqual(harness.writes, [beginSynchronizedOutput() + enterAlternateScreen() + disableAlternateScrollMode() + endSynchronizedOutput(), "overlay-write"]);
	assert.deepEqual(harness.doRenderCalls, ["doRender"]);
	assert.equal(harness.getRenderClusterCalls(), 0);

	harness.compositor.dispose();
	assert.equal(harness.terminal.write, originalWrite);
});

test("tui.overlayStack 有可见元素时，render/doRender/write/rows 均让路给原始入口", () => {
	const harness = createHarness({ overlayStack: [{}] });
	const originalRender = harness.tui.render;
	harness.compositor.install();

	assert.equal(harness.terminal.rows, 10);
	assert.deepEqual(harness.tui.render(20), originalRender.call(harness.tui, 20));
	harness.terminal.write("stack-write");
	harness.tui.doRender();

	assert.deepEqual(harness.writes, [beginSynchronizedOutput() + enterAlternateScreen() + disableAlternateScrollMode() + endSynchronizedOutput(), "stack-write"]);
	assert.deepEqual(harness.doRenderCalls, ["doRender"]);
	assert.equal(harness.getRenderClusterCalls(), 0);
});

test("tui.overlayStack hidden 或 visible=false 时不让路", () => {
	const harness = createHarness({ overlayStack: [{ hidden: true }, { options: { visible: () => false } }] });
	harness.compositor.install();

	assert.equal(harness.terminal.rows, 8);
	harness.terminal.write("normal-write");

	assert.equal(harness.writes.length, 2);
	assert.ok(harness.writes[1]?.includes("normal-write"));
	assert.ok(harness.writes[1]?.includes("editor"));
	assert.ok(harness.getRenderClusterCalls() > 0);
});

test("存在 tui.hasOverlay 时直接信任其 boolean，不 fallback 到 overlayStack", () => {
	const harness = createHarness({ overlay: false, overlayStack: [{}] });
	harness.compositor.install();

	harness.terminal.write("normal-write");

	assert.equal(harness.writes.length, 2);
	assert.ok(harness.writes[1]?.includes("normal-write"));
	assert.ok(harness.writes[1]?.includes("editor"));
});
