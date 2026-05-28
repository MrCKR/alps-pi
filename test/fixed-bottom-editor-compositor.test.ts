/** 功能：验证 fixed bottom editor 最小 compositor 实现者：alps 实现日期：2026-05-27 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	FixedBottomEditorCompositor,
	beginSynchronizedOutput,
	buildFixedEditorClusterPaint,
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

function installSequence(): string {
	return beginSynchronizedOutput() + enterAlternateScreen() + disableAlternateScrollMode() + "\x1b[?1002h\x1b[?1006h" + endSynchronizedOutput();
}

function resetSequence(): string {
	return beginSynchronizedOutput() + resetScrollRegion() + "\x1b[?1006l\x1b[?1002l\x1b[?1000l" + enableAlternateScrollMode() + exitAlternateScreen() + showCursor() + endSynchronizedOutput();
}

function createHarness(options: { overlay?: boolean; overlayStack?: unknown[]; rootLines?: string[]; cluster?: FixedEditorCluster } = {}) {
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
	const inputListeners = new Set<(data: string) => { consume?: boolean; data?: string } | undefined>();
	const tui = {
		hardwareCursorRow: 4,
		cursorRow: 2,
		previousViewportTop: 1,
		overlayStack: options.overlayStack ?? [],
		hasOverlay: options.overlay === undefined ? undefined : () => options.overlay,
		requestRenderCalls: 0,
		addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
			inputListeners.add(listener);
			return () => inputListeners.delete(listener);
		},
		requestRender() {
			this.requestRenderCalls += 1;
		},
		render(width: number) {
			renderCalls.push(width);
			return options.rootLines ?? ["root-1", "root-2", "root-3", "root-4"];
		},
		doRender() {
			doRenderCalls.push("doRender");
		},
	};
	const cluster: FixedEditorCluster = options.cluster ?? {
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
		input(data: string) {
			const results = [];
			for (const listener of inputListeners) {
				results.push(listener(data));
			}
			return results;
		},
		getInputListenerCount() {
			return inputListeners.size;
		},
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
	assert.equal(harness.writes[0], installSequence());

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
		+ resetScrollRegion()
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
		resetSequence(),
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

test("滚动路径复用 rootLines 缓存，不随历史消息数量重复整树 render", () => {
	const rootLines = Array.from({ length: 1000 }, (_, index) => `root-${index + 1}`);
	const harness = createHarness({ rootLines });
	harness.compositor.install();
	harness.tui.render(20);
	const renderCount = harness.renderCalls.length;

	harness.input("\x1b[5~");
	harness.input("\x1b[5~");
	harness.input("\x1b[6~");

	assert.equal(harness.renderCalls.length, renderCount);
});

test("一次键盘滚动只计算一次 cluster，普通滚动不重绘底部 cluster", () => {
	const rootLines = Array.from({ length: 30 }, (_, index) => `root-${index + 1}`);
	const harness = createHarness({ rootLines });
	harness.compositor.install();
	harness.tui.render(20);
	const clusterCalls = harness.getRenderClusterCalls();
	const writeCount = harness.writes.length;

	harness.input("\x1b[5~");

	assert.equal(harness.getRenderClusterCalls() - clusterCalls, 1);
	assert.equal(harness.writes.length, writeCount + 1);
	assert.doesNotMatch(harness.writes.at(-1) ?? "", /editor|footer/);
});

test("wheel burst 合并为一次滚动 repaint，并显著减少 cluster render", async () => {
	const rootLines = Array.from({ length: 60 }, (_, index) => `root-${index + 1}`);
	const harness = createHarness({ rootLines });
	harness.compositor.install();
	harness.tui.render(20);
	const clusterCalls = harness.getRenderClusterCalls();
	const writeCount = harness.writes.length;

	for (let index = 0; index < 10; index++) {
		assert.deepEqual(harness.input("\x1b[<64;1;1M"), [{ consume: true }]);
	}
	assert.equal(harness.writes.length, writeCount);

	await new Promise((resolve) => setTimeout(resolve, 20));

	assert.equal(harness.writes.length, writeCount + 1);
	assert.equal(harness.getRenderClusterCalls() - clusterCalls, 1);
	assert.doesNotMatch(harness.writes.at(-1) ?? "", /editor|footer/);
});

test("非 wheel 鼠标事件前会 flush pending wheel，保证事件顺序", () => {
	const rootLines = Array.from({ length: 40 }, (_, index) => `root-${index + 1}`);
	const harness = createHarness({ rootLines });
	harness.compositor.install();
	harness.tui.render(20);
	const writeCount = harness.writes.length;

	harness.input("\x1b[<64;1;1M");
	assert.equal(harness.writes.length, writeCount);
	harness.input("\x1b[<0;1;1M");

	assert.equal(harness.writes.length, writeCount + 2);
	assert.doesNotMatch(harness.writes.at(writeCount) ?? "", /editor|footer/);
});

test("cluster 区选中高亮后普通滚动会重绘底部，避免残留反色选区", () => {
	const rootLines = Array.from({ length: 40 }, (_, index) => `root-${index + 1}`);
	const harness = createHarness({ rootLines });
	harness.compositor.install();
	harness.tui.render(20);
	harness.input("\x1b[<0;3;9M\x1b[<0;6;9m");
	assert.match(harness.writes.at(-1) ?? "", /\x1b\[7m/);
	const writeCount = harness.writes.length;

	harness.input("\x1b[5~");

	assert.equal(harness.writes.length, writeCount + 1);
	assert.match(harness.writes.at(-1) ?? "", /editor|footer/);
	assert.doesNotMatch(harness.writes.at(-1) ?? "", /\x1b\[7m/);
});

test("cluster 区选中高亮后回到底部会重绘底部，避免残留反色选区", () => {
	const rootLines = Array.from({ length: 40 }, (_, index) => `root-${index + 1}`);
	const harness = createHarness({ rootLines });
	harness.compositor.install();
	harness.tui.render(20);
	harness.input("\x1b[5~");
	harness.input("\x1b[<0;3;9M\x1b[<0;6;9m");
	assert.match(harness.writes.at(-1) ?? "", /\x1b\[7m/);
	const writeCount = harness.writes.length;

	assert.equal(harness.compositor.jumpToRootBottom(), true);

	assert.equal(harness.writes.length, writeCount + 1);
	assert.match(harness.writes.at(-1) ?? "", /editor|footer/);
	assert.doesNotMatch(harness.writes.at(-1) ?? "", /\x1b\[7m/);
});

test("cluster 区选中高亮后 message jump 会重绘底部，避免残留反色选区", () => {
	const rootLines = Array.from({ length: 40 }, (_, index) => `root-${index + 1}`);
	const harness = createHarness({ rootLines });
	harness.compositor.install();
	harness.tui.render(20);
	harness.input("\x1b[5~");
	harness.input("\x1b[<0;3;9M\x1b[<0;6;9m");
	assert.match(harness.writes.at(-1) ?? "", /\x1b\[7m/);
	const writeCount = harness.writes.length;

	assert.equal(harness.compositor.jumpToPreviousRootTarget([10, 20, 30]), true);

	assert.equal(harness.writes.length, writeCount + 1);
	assert.match(harness.writes.at(-1) ?? "", /editor|footer/);
	assert.doesNotMatch(harness.writes.at(-1) ?? "", /\x1b\[7m/);
});

test("cluster 区选中高亮后右键点选区外会重绘底部，避免残留反色选区", () => {
	const rootLines = Array.from({ length: 40 }, (_, index) => `root-${index + 1}`);
	const harness = createHarness({ rootLines });
	harness.compositor.install();
	harness.tui.render(20);
	harness.input("\x1b[<0;3;9M\x1b[<0;6;9m");
	assert.match(harness.writes.at(-1) ?? "", /\x1b\[7m/);
	const writeCount = harness.writes.length;

	harness.input("\x1b[<2;1;9M");

	assert.equal(harness.writes.length, writeCount + 2);
	assert.match(harness.writes.at(writeCount) ?? "", /editor|footer/);
	assert.doesNotMatch(harness.writes.at(writeCount) ?? "", /\x1b\[7m/);
});

test("dispose 会清理 pending wheel timer，避免卸载后继续写入", async () => {
	const rootLines = Array.from({ length: 40 }, (_, index) => `root-${index + 1}`);
	const harness = createHarness({ rootLines });
	harness.compositor.install();
	harness.tui.render(20);
	harness.input("\x1b[<64;1;1M");
	const beforeDisposeWrites = harness.writes.length;

	harness.compositor.dispose();
	await new Promise((resolve) => setTimeout(resolve, 20));

	assert.equal(harness.writes.length, beforeDisposeWrites + 1);
	assert.ok(harness.writes.at(-1)?.includes(exitAlternateScreen()));
});

test("原版 PageUp/PageDown 快捷键驱动内部聊天区滚动", () => {
	const rootLines = Array.from({ length: 20 }, (_, index) => `root-${index + 1}`);
	const harness = createHarness({ rootLines });
	harness.compositor.install();
	harness.tui.render(20);

	const upResult = harness.input("\x1b[5~");
	assert.deepEqual(upResult, [{ consume: true }]);
	assert.deepEqual(harness.tui.render(20), ["root-3", "root-4", "root-5", "root-6", "root-7", "root-8", "root-9", "root-10"]);

	const downResult = harness.input("\x1b[6~");
	assert.deepEqual(downResult, [{ consume: true }]);
	assert.deepEqual(harness.tui.render(20), ["root-13", "root-14", "root-15", "root-16", "root-17", "root-18", "root-19", "root-20"]);
	// 滚动路径已同步重绘 viewport，不再额外排队完整 TUI render，避免滚轮不跟手。
	assert.equal(harness.tui.requestRenderCalls, 0);
});

test("原版 Super/Ctrl+Shift 方向键快捷键与鼠标滚轮共享滚动窗口", async () => {
	const rootLines = Array.from({ length: 20 }, (_, index) => `root-${index + 1}`);
	const harness = createHarness({ rootLines });
	harness.compositor.install();
	harness.tui.render(20);

	assert.deepEqual(harness.input("\x1b[1;6A"), [{ consume: true }]);
	assert.deepEqual(harness.input("\x1b[<65;1;1M"), [{ consume: true }]);
	await new Promise((resolve) => setTimeout(resolve, 12));
	assert.deepEqual(harness.tui.render(20), ["root-6", "root-7", "root-8", "root-9", "root-10", "root-11", "root-12", "root-13"]);

	assert.deepEqual(harness.input("\x1b[1;6B"), [{ consume: true }]);
	assert.deepEqual(harness.input("\x1b[<64;1;1M"), [{ consume: true }]);
	await new Promise((resolve) => setTimeout(resolve, 12));
	assert.deepEqual(harness.tui.render(20), ["root-10", "root-11", "root-12", "root-13", "root-14", "root-15", "root-16", "root-17"]);
});

test("安装后更新滚动快捷键立即生效", () => {
	const rootLines = Array.from({ length: 20 }, (_, index) => `root-${index + 1}`);
	const harness = createHarness({ rootLines });
	harness.compositor.install();
	harness.tui.render(20);

	assert.deepEqual(harness.input("\x1b[1;9A"), [{ consume: true }]);
	assert.deepEqual(harness.tui.render(20), ["root-3", "root-4", "root-5", "root-6", "root-7", "root-8", "root-9", "root-10"]);

	harness.compositor.jumpToRootBottom();
	harness.compositor.setKeyboardScrollShortcuts({ up: "ctrl+alt+u", down: "ctrl+alt+j" });
	assert.deepEqual(harness.input("\x1b[1;9A"), [undefined]);
	assert.deepEqual(harness.input("\x1b[117;7u"), [{ consume: true }]);
	assert.deepEqual(harness.tui.render(20), ["root-3", "root-4", "root-5", "root-6", "root-7", "root-8", "root-9", "root-10"]);
});

test("overlay 可见时滚动快捷键不消费，dispose 后移除 input listener", () => {
	const harness = createHarness({ overlay: true, rootLines: Array.from({ length: 20 }, (_, index) => `root-${index + 1}`) });
	harness.compositor.install();
	assert.equal(harness.getInputListenerCount(), 1);

	assert.deepEqual(harness.input("\x1b[5~"), [undefined]);
	harness.compositor.dispose();
	assert.equal(harness.getInputListenerCount(), 0);
});

test("requestRepaint 只重绘底部 cluster，不重复渲染上方聊天区", () => {
	const harness = createHarness();
	harness.compositor.install();
	harness.tui.render(20);
	const renderCount = harness.renderCalls.length;

	harness.compositor.requestRepaint();

	assert.equal(harness.renderCalls.length, renderCount);
	assert.ok(harness.writes.at(-1)?.includes("editor"));
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

	assert.deepEqual(harness.writes, [installSequence(), "overlay-write"]);
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

	assert.deepEqual(harness.writes, [installSequence(), "stack-write"]);
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
