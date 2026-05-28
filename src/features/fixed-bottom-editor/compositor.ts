/** 功能：fixed bottom editor 最小 terminal split compositor 实现者：alps 实现日期：2026-05-27 */

import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FixedEditorCluster } from "./cluster.ts";
import { matchesConfiguredShortcut } from "../bottom-input/shortcuts.ts";

type ProcessWithExit = Pick<typeof process, "once" | "removeListener">;

export type FixedEditorTerminal = {
	columns?: number;
	rows: number;
	write(data: string): void;
};

export type FixedEditorRenderable = {
	render(width: number): string[];
};

export type FixedBottomEditorCompositorOptions = {
	/** Pi TUI 实例，compositor 会临时接管 render/doRender。 */
	tui: any;
	/** 目标 terminal，compositor 会临时接管 write/rows。 */
	terminal: FixedEditorTerminal;
	/** 按当前终端尺寸渲染底部固定区域。 */
	renderCluster: (width: number, terminalRows: number) => FixedEditorCluster;
	/** 控制是否把硬件光标移动到 cluster cursor 位置。 */
	getShowHardwareCursor?: () => boolean;
	/** 聊天区滚动快捷键；由 bottom-input settings 注入。 */
	keyboardScrollShortcuts?: { up: string; down: string };
	/** 鼠标选区 release 后的复制回调。 */
	onCopySelection?: (text: string) => void;
	/** 测试注入点：生产环境使用 process 注册 exit 兜底恢复。 */
	processLike?: ProcessWithExit;
};

type TerminalWrite = (data: string) => void;
type TuiRender = (width: number, ...args: unknown[]) => string[];
type TuiDoRender = (...args: unknown[]) => unknown;

type RenderPatch = {
	target: FixedEditorRenderable;
	originalRender: (width: number) => string[];
	hiddenRender: (width: number) => string[];
};

type SgrMousePacket = {
	code: number;
	col: number;
	row: number;
	final: "M" | "m";
};

type SelectionPoint = {
	line: number;
	col: number;
};

type SelectionArea = "root" | "cluster";

type SelectionLocation = {
	area: SelectionArea;
	point: SelectionPoint;
};

const COMPOSITOR_OWNER = Symbol("alps.pi.fixedBottomEditor.compositorOwner.v1");
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const DOUBLE_CLICK_MS = 500;
const CONTEXT_MENU_MOUSE_REPORTING_PAUSE_MS = 1200;

/** 进入 alternate screen，让固定输入框拥有可控视口并避免污染主屏滚动历史。 */
export function enterAlternateScreen(): string {
	return "\x1b[?1049h";
}

/** 退出 alternate screen，dispose/reload 后回到主屏。 */
export function exitAlternateScreen(): string {
	return "\x1b[?1049l";
}

/** 禁用 alternate scroll，避免滚轮直接冲刷 fixed editor 所在的终端视口。 */
export function disableAlternateScrollMode(): string {
	return "\x1b[?1007l";
}

/** 启用 SGR mouse reporting，滚轮事件由 compositor 自己解释，避免滚走固定输入框。 */
export function enableMouseReporting(): string {
	return "\x1b[?1002h\x1b[?1006h";
}

/** 关闭 mouse reporting，释放终端鼠标输入。 */
export function disableMouseReporting(): string {
	return "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
}

/** 恢复 alternate scroll，交回 Pi 默认终端行为。 */
export function enableAlternateScrollMode(): string {
	return "\x1b[?1007h";
}

/** 开启 synchronized output，降低分段绘制闪烁。 */
export function beginSynchronizedOutput(): string {
	return "\x1b[?2026h";
}

/** 关闭 synchronized output。 */
export function endSynchronizedOutput(): string {
	return "\x1b[?2026l";
}

/** 设置终端滚动区域，参数使用终端 1-based 行号。 */
export function setScrollRegion(top: number, bottom: number): string {
	return `\x1b[${top};${bottom}r`;
}

/** 重置终端滚动区域，避免 dispose 后污染 shell。 */
export function resetScrollRegion(): string {
	return "\x1b[r";
}

/** 移动硬件光标，参数使用终端 1-based 坐标。 */
export function moveCursor(row: number, col: number): string {
	return `\x1b[${row};${col}H`;
}

/** 清空当前行。 */
export function clearLine(): string {
	return "\x1b[2K";
}

/** 隐藏硬件光标。 */
export function hideCursor(): string {
	return "\x1b[?25l";
}

/** 显示硬件光标。 */
export function showCursor(): string {
	return "\x1b[?25h";
}

/** dispose 时使用的最小终端恢复序列。 */
export function resetFixedBottomEditorTerminalState(): string {
	return beginSynchronizedOutput() + resetScrollRegion() + disableMouseReporting() + enableAlternateScrollMode() + exitAlternateScreen() + showCursor() + endSynchronizedOutput();
}

/** 生成底部 fixed cluster 的绘制序列：重置滚动区、定位、清行、写行并处理光标。 */
export function buildFixedEditorClusterPaint(
	cluster: FixedEditorCluster,
	terminalRows: number,
	width: number,
	showHardwareCursor: boolean,
): string {
	if (cluster.lines.length === 0) return "";

	const safeRows = Math.max(1, Math.floor(terminalRows));
	const safeWidth = Math.max(1, Math.floor(width));
	const startRow = Math.max(1, safeRows - cluster.lines.length + 1);
	let buffer = resetScrollRegion();

	for (let index = 0; index < cluster.lines.length; index++) {
		buffer += moveCursor(startRow + index, 1);
		buffer += clearLine();
		buffer += sanitizeLine(cluster.lines[index] ?? "", safeWidth);
	}

	if (cluster.cursor && showHardwareCursor) {
		const cursorRow = Math.max(0, Math.min(cluster.cursor.row, cluster.lines.length - 1));
		const cursorCol = Math.max(0, Math.min(cluster.cursor.col, safeWidth - 1));
		buffer += moveCursor(startRow + cursorRow, cursorCol + 1);
		buffer += showCursor();
	} else {
		buffer += hideCursor();
	}

	return buffer;
}

/** fixed bottom editor 的最小 compositor：只负责 terminal split、引用恢复和隐藏原 editor。 */
export class FixedBottomEditorCompositor {
	private readonly tui: any;
	private readonly terminal: FixedEditorTerminal;
	private readonly renderCluster: (width: number, terminalRows: number) => FixedEditorCluster;
	private readonly getShowHardwareCursor: () => boolean;
	private keyboardScrollShortcuts: { up: string; down: string };
	private readonly onCopySelection: ((text: string) => void) | null;
	private readonly processLike: ProcessWithExit;
	private readonly patchedRenders: RenderPatch[] = [];
	private originalWrite: TerminalWrite | null = null;
	private originalRender: TuiRender | null = null;
	private originalDoRender: TuiDoRender | null = null;
	private originalOwnRowsDescriptor: PropertyDescriptor | undefined;
	private originalRowsDescriptor: PropertyDescriptor | undefined;
	private writeWrapper: TerminalWrite | null = null;
	private renderWrapper: TuiRender | null = null;
	private doRenderWrapper: TuiDoRender | null = null;
	private rowsGetter: (() => number) | null = null;
	private removeInputListener: (() => void) | null = null;
	private mouseReportingResumeTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly ownerToken = Symbol("alps.pi.fixedBottomEditor.compositor.instance");
	private installed = false;
	private disposed = false;
	private writing = false;
	private renderingCluster = false;
	private renderingScrollableRoot = false;
	private checkingOverlay = false;
	private emergencyCleanup: (() => void) | null = null;
	private scrollOffset = 0;
	private maxScrollOffset = 0;
	private lastRootLineCount = 0;
	private rootLines: string[] = [];
	private visibleRootStart = 0;
	private visibleRootLines: string[] = [];
	private visibleClusterLines: string[] = [];
	private visibleScrollableRows = 0;
	private selectionArea: SelectionArea | null = null;
	private selectionAnchor: SelectionPoint | null = null;
	private selectionFocus: SelectionPoint | null = null;
	private selectionDragging = false;
	private preserveSelectionFocusOnRelease = false;
	private lastLeftPress: { area: SelectionArea; line: number; at: number } | null = null;

	constructor(options: FixedBottomEditorCompositorOptions) {
		this.tui = options.tui;
		this.terminal = options.terminal;
		this.renderCluster = options.renderCluster;
		this.getShowHardwareCursor = options.getShowHardwareCursor ?? (() => true);
		this.keyboardScrollShortcuts = options.keyboardScrollShortcuts ?? { up: "super+up", down: "super+down" };
		this.onCopySelection = options.onCopySelection ?? null;
		this.processLike = options.processLike ?? process;
	}

	/** 安装 compositor，接管 terminal.write/rows 与 TUI render 入口。 */
	install(): void {
		if (this.installed) return;
		if (this.disposed) {
			throw new Error("[alps-pi] fixed bottom editor compositor has been disposed");
		}
		if (typeof this.terminal.write !== "function") {
			throw new Error("[alps-pi] fixed bottom editor compositor expected terminal.write(data) to exist");
		}
		this.assertCanOwnCompositor();

		this.originalWrite = this.terminal.write;
		this.originalRender = typeof this.tui.render === "function" ? this.tui.render : null;
		this.originalDoRender = typeof this.tui.doRender === "function" ? this.tui.doRender : null;
		this.originalOwnRowsDescriptor = Object.getOwnPropertyDescriptor(this.terminal, "rows");
		this.originalRowsDescriptor = findRowsDescriptor(this.terminal);

		try {
			this.writeOriginal(
				beginSynchronizedOutput()
				+ enterAlternateScreen()
				+ disableAlternateScrollMode()
				+ enableMouseReporting()
				+ endSynchronizedOutput(),
			);
			this.emergencyCleanup = () => {
				if (!this.disposed) {
					this.writeResetSequenceBestEffort();
				}
			};
			this.processLike.once("exit", this.emergencyCleanup);

			this.rowsGetter = () => this.getScrollableRows();
			Object.defineProperty(this.terminal, "rows", {
				configurable: true,
				get: this.rowsGetter,
			});

			this.renderWrapper = (width: number, ...args: unknown[]) => this.renderScrollableRoot(width, ...args);
			this.doRenderWrapper = (...args: unknown[]) => this.doRender(...args);
			this.writeWrapper = (data: string) => this.write(data);

			if (this.originalRender) {
				this.tui.render = this.renderWrapper;
			}
			if (this.originalDoRender) {
				this.tui.doRender = this.doRenderWrapper;
			}
			if (typeof this.tui.addInputListener === "function") {
				this.removeInputListener = this.tui.addInputListener((data: string) => this.handleInput(data));
			}
			this.terminal.write = this.writeWrapper;
			this.markOwner();
			this.installed = true;
		} catch (error) {
			// 安装中途失败也必须回滚已写入的 terminal/TUI patch 和 terminal mode，保证 fail closed。
			this.restorePatches(true);
			throw error;
		}
	}

	/** 隐藏某个 renderable，使原 editor container 不再出现在普通 TUI 树中。 */
	hideRenderable(target: FixedEditorRenderable): void {
		if (this.patchedRenders.some((patch) => patch.target === target)) return;
		if (typeof target.render !== "function") {
			throw new Error("[alps-pi] hideRenderable expected target.render(width) to exist");
		}

		const originalRender = target.render;
		const hiddenRender = () => [];
		this.patchedRenders.push({ target, originalRender, hiddenRender });
		target.render = hiddenRender;
	}

	/** 使用隐藏前的 render 函数渲染目标，供后续 fixed editor cluster 复用原 editor。 */
	renderHidden(target: FixedEditorRenderable, width: number): string[] {
		const patch = this.patchedRenders.find((candidate) => candidate.target === target);
		const render = patch?.originalRender ?? target.render;
		return render.call(target, width);
	}

	/** 主动重绘底部 fixed cluster；overlay 可见时让路。 */
	requestRepaint(): void {
		if (this.disposed || this.hasVisibleOverlay()) return;

		const rawRows = this.getRawRows();
		const width = this.getTerminalWidth();
		const cluster = this.getCluster(width, rawRows);
		if (cluster.lines.length === 0) return;
		this.refreshRootWindow(width);

		this.writeOriginal(
			beginSynchronizedOutput()
			+ buildFixedEditorClusterPaint(this.decorateCluster(cluster), rawRows, width, this.getShowHardwareCursor())
			+ endSynchronizedOutput(),
		);
	}

	/** 更新聊天区滚动快捷键；设置界面保存后无需重装 compositor 即可生效。 */
	setKeyboardScrollShortcuts(shortcuts: { up: string; down: string }): void {
		this.keyboardScrollShortcuts = shortcuts;
	}

	/** 释放所有 monkey patch，并尽力恢复终端滚动区和光标状态；重复调用安全。 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;

		for (const patch of this.patchedRenders.splice(0)) {
			if (patch.target.render === patch.hiddenRender) {
				patch.target.render = patch.originalRender;
			}
		}

		this.restorePatches(true);
	}

	/** 按当前 wrapper 状态逐项恢复，支持安装中途失败后的 partial rollback。 */
	private restorePatches(writeResetSequence: boolean): void {
		const shouldRestoreWrite = this.originalWrite && this.terminal.write === this.writeWrapper;
		const shouldRestoreRows = Object.getOwnPropertyDescriptor(this.terminal, "rows")?.get === this.rowsGetter;
		if (this.originalWrite && shouldRestoreWrite) {
			this.terminal.write = this.originalWrite;
		}
		if (this.emergencyCleanup) {
			this.processLike.removeListener("exit", this.emergencyCleanup);
			this.emergencyCleanup = null;
		}
		this.removeInputListener?.();
		this.removeInputListener = null;
		if (this.mouseReportingResumeTimer) {
			clearTimeout(this.mouseReportingResumeTimer);
			this.mouseReportingResumeTimer = null;
		}
		this.clearSelection();
		if (this.originalRender && this.tui.render === this.renderWrapper) {
			this.tui.render = this.originalRender;
		}
		if (this.originalDoRender && this.tui.doRender === this.doRenderWrapper) {
			this.tui.doRender = this.originalDoRender;
		}
		if (shouldRestoreRows) {
			this.restoreRowsDescriptor();
		}
		this.clearOwner();
		this.installed = false;
		if (writeResetSequence && this.originalWrite) {
			this.writeResetSequenceBestEffort();
		}
	}

	/** 包装 TUI doRender：先执行原渲染，再补绘底部 cluster。 */
	private doRender(...args: unknown[]): unknown {
		if (!this.originalDoRender) return undefined;
		if (this.disposed || this.hasVisibleOverlay()) {
			return this.originalDoRender.apply(this.tui, args);
		}

		const result = this.originalDoRender.apply(this.tui, args);
		this.refreshRootWindow(this.getTerminalWidth());
		this.requestRepaint();
		return result;
	}

	/** 包装 TUI render：普通内容只保留可滚动区域，避免覆盖底部 fixed cluster。 */
	private renderScrollableRoot(width: number, ...args: unknown[]): string[] {
		if (!this.originalRender) return [];
		if (this.disposed || this.renderingScrollableRoot || this.hasVisibleOverlay()) {
			return this.originalRender.call(this.tui, width, ...args);
		}

		this.renderingScrollableRoot = true;
		try {
			this.refreshRootWindow(coercePositiveInteger(width, DEFAULT_COLUMNS), ...args);
			return this.visibleRootLines.map((line, index) => this.renderSelectionHighlight(line, this.visibleRootStart + index, "root"));
		} finally {
			this.renderingScrollableRoot = false;
		}
	}

	/** 包装 terminal.write：把普通输出限制在上方滚动区，并在底部补绘 fixed cluster。 */
	private write(data: string): void {
		if (this.disposed || this.writing || this.hasVisibleOverlay()) {
			this.writeOriginal(data);
			return;
		}

		this.writing = true;
		try {
			const rawRows = this.getRawRows();
			const width = this.getTerminalWidth();
			const cluster = this.getCluster(width, rawRows);
			if (cluster.lines.length === 0) {
				this.writeOriginal(data);
				return;
			}

			const scrollBottom = Math.max(1, rawRows - cluster.lines.length);
			const screenRow = this.getCurrentScreenRow(scrollBottom);
			this.writeOriginal(
				beginSynchronizedOutput()
				+ setScrollRegion(1, scrollBottom)
				+ moveCursor(screenRow, 1)
				+ data
				+ buildFixedEditorClusterPaint(this.decorateCluster(cluster), rawRows, width, this.getShowHardwareCursor())
				+ endSynchronizedOutput(),
			);
		} finally {
			this.writing = false;
		}
	}

	/** 接管滚动快捷键、鼠标滚轮与稳定选区；其他输入继续交给 Pi editor。 */
	private handleInput(data: string): { consume?: boolean; data?: string } | undefined {
		if (this.disposed || this.hasVisibleOverlay()) return undefined;

		const mousePackets = parseSgrMousePackets(data);
		if (mousePackets) {
			for (const packet of mousePackets) {
				this.handleMousePacket(packet);
			}
			return { consume: true };
		}

		const keyboardDelta = parseKeyboardScrollDelta(data, this.keyboardScrollShortcuts);
		if (keyboardDelta === 0) return undefined;

		this.scrollBy(keyboardDelta);
		return { consume: true };
	}

	/** 读取给 TUI 暴露的可滚动行数；overlay 或内部渲染期间返回真实行数。 */
	private getScrollableRows(): number {
		const rawRows = this.getRawRows();
		if (
			this.disposed
			|| this.writing
			|| this.renderingCluster
			|| this.checkingOverlay
			|| this.hasVisibleOverlay()
		) {
			return rawRows;
		}

		const cluster = this.getCluster(this.getTerminalWidth(), rawRows);
		return Math.max(1, rawRows - cluster.lines.length);
	}

	/** 刷新上方聊天区窗口，scrollOffset=0 表示贴底，正数表示向历史上方偏移。 */
	private refreshRootWindow(width: number, ...args: unknown[]): void {
		if (!this.originalRender) return;

		const rawRows = this.getRawRows();
		const renderWidth = Math.max(1, Math.floor(width));
		const cluster = this.getCluster(renderWidth, rawRows);
		const scrollableRows = Math.max(1, rawRows - cluster.lines.length);
		const lines = this.originalRender.call(this.tui, renderWidth, ...args);
		this.rootLines = Array.isArray(lines) ? lines : [];
		if (this.scrollOffset > 0 && this.lastRootLineCount > 0 && this.rootLines.length > this.lastRootLineCount) {
			this.scrollOffset += this.rootLines.length - this.lastRootLineCount;
		}
		this.lastRootLineCount = this.rootLines.length;
		this.maxScrollOffset = Math.max(0, this.rootLines.length - scrollableRows);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.maxScrollOffset));
		this.updateVisibleRootWindow(scrollableRows);
	}

	/** 按当前 scrollOffset 计算可见聊天行，并补空行撑满可滚动区域。 */
	private updateVisibleRootWindow(scrollableRows = this.visibleScrollableRows): number {
		const rows = Math.max(1, scrollableRows);
		const start = Math.max(0, this.rootLines.length - rows - this.scrollOffset);
		const visibleLines = this.rootLines.slice(start, start + rows);
		while (visibleLines.length < rows) {
			visibleLines.push("");
		}
		this.visibleRootStart = start;
		this.visibleScrollableRows = rows;
		this.visibleRootLines = visibleLines;
		return start;
	}

	/** 原版语义：正数向上看历史，负数回到底部；滚动后只重绘上方 viewport 与底部 cluster。 */
	private scrollBy(delta: number): void {
		const width = this.getTerminalWidth();
		this.refreshRootWindow(width);
		const nextOffset = Math.max(0, Math.min(this.scrollOffset + delta, this.maxScrollOffset));
		if (nextOffset === this.scrollOffset) return;

		this.clearSelection();
		this.lastLeftPress = null;
		this.scrollOffset = nextOffset;
		// 滚轮/快捷键滚动已经同步重绘 viewport；避免再排队完整 TUI render，降低滚动延迟。
		this.repaintScrollableViewport(width);
	}

	/** 只重绘上方聊天区，避免滚动操作影响底部 fixed editor。 */
	private repaintScrollableViewport(width: number): void {
		if (this.disposed || this.writing || this.hasVisibleOverlay() || !this.installed) return;

		const rawRows = this.getRawRows();
		const cluster = this.getCluster(width, rawRows);
		const scrollableRows = Math.max(1, rawRows - cluster.lines.length);
		const start = this.updateVisibleRootWindow(scrollableRows);
		let buffer = beginSynchronizedOutput() + setScrollRegion(1, scrollableRows) + moveCursor(1, 1);

		for (let row = 0; row < scrollableRows; row++) {
			if (row > 0) buffer += "\r\n";
			buffer += clearLine();
			buffer += sanitizeLine(this.renderSelectionHighlight(this.visibleRootLines[row] ?? "", start + row, "root"), width);
		}

		buffer += buildFixedEditorClusterPaint(this.decorateCluster(cluster), rawRows, width, this.getShowHardwareCursor());
		buffer += endSynchronizedOutput();
		this.writeOriginal(buffer);
	}

	/** 调用 renderCluster 并规整输出，确保至少保留一行可滚动区域。 */
	private getCluster(width: number, terminalRows: number): FixedEditorCluster {
		const wasRenderingCluster = this.renderingCluster;
		this.renderingCluster = true;
		try {
			const rendered = this.renderCluster(width, terminalRows) ?? { lines: [] };
			const cluster = normalizeCluster(rendered, width, terminalRows);
			this.visibleClusterLines = cluster.lines;
			return cluster;
		} finally {
			this.renderingCluster = wasRenderingCluster;
		}
	}

	/** 跳到上一条聊天消息起始行。 */
	jumpToPreviousRootTarget(targetLines: readonly number[]): boolean {
		return this.jumpToRootTarget(targetLines, "previous");
	}

	/** 跳到下一条聊天消息起始行。 */
	jumpToNextRootTarget(targetLines: readonly number[]): boolean {
		return this.jumpToRootTarget(targetLines, "next");
	}

	/** 回到聊天底部。 */
	jumpToRootBottom(): boolean {
		if (this.disposed || this.hasVisibleOverlay() || this.scrollOffset === 0) return false;
		this.clearSelection();
		this.lastLeftPress = null;
		this.scrollOffset = 0;
		this.repaintScrollableViewport(this.getTerminalWidth());
		return true;
	}

	private jumpToRootTarget(targetLines: readonly number[], direction: "previous" | "next"): boolean {
		if (this.disposed || targetLines.length === 0 || this.hasVisibleOverlay()) return false;
		this.refreshRootWindow(this.getTerminalWidth());
		const start = this.visibleRootStart;
		const candidates = direction === "previous"
			? targetLines.filter((line) => line < start).sort((a, b) => b - a)
			: targetLines.filter((line) => line > start).sort((a, b) => a - b);
		for (const target of candidates) {
			const nextOffset = Math.max(0, Math.min(this.lastRootLineCount - Math.max(1, this.visibleScrollableRows) - target, this.maxScrollOffset));
			if (nextOffset === this.scrollOffset) continue;
			this.clearSelection();
			this.lastLeftPress = null;
			this.scrollOffset = nextOffset;
			this.repaintScrollableViewport(this.getTerminalWidth());
			return true;
		}
		return false;
	}

	/** 从安装前保存的 descriptor 读取真实 rows，避免访问被 patch 后的 getter。 */
	private getRawRows(): number {
		const descriptor = this.originalRowsDescriptor;
		if (descriptor?.get) {
			return coercePositiveInteger(descriptor.get.call(this.terminal), DEFAULT_ROWS);
		}
		if (descriptor && "value" in descriptor) {
			return coercePositiveInteger(descriptor.value, DEFAULT_ROWS);
		}
		return DEFAULT_ROWS;
	}

	/** 读取 terminal columns，并规整为正整数。 */
	private getTerminalWidth(): number {
		return coercePositiveInteger(Reflect.get(this.terminal, "columns"), DEFAULT_COLUMNS);
	}

	/** 把 Pi TUI 的内部光标行换算为当前滚动区内的 1-based 屏幕行。 */
	private getCurrentScreenRow(scrollBottom: number): number {
		const cursorRow = typeof this.tui?.hardwareCursorRow === "number"
			? this.tui.hardwareCursorRow
			: typeof this.tui?.cursorRow === "number"
				? this.tui.cursorRow
				: 0;
		const viewportTop = typeof this.tui?.previousViewportTop === "number" ? this.tui.previousViewportTop : 0;
		return Math.max(1, Math.min(scrollBottom, cursorRow - viewportTop + 1));
	}

	private handleMousePacket(packet: SgrMousePacket): void {
		const delta = mouseScrollDelta(packet);
		if (delta !== 0) {
			this.selectionDragging = false;
			this.scrollBy(delta);
			return;
		}

		const location = this.selectionLocationForPacket(packet);
		if (isRightPress(packet)) {
			this.selectionDragging = false;
			this.preserveSelectionFocusOnRelease = false;
			const selectedText = this.isLocationInsideSelection(location) ? this.getSelectedText() : "";
			if (selectedText) {
				// 右键只让路给终端菜单；选区已在 release 时复制，避免重复写剪贴板。
				this.pauseMouseReportingForContextMenu();
				return;
			}
			this.clearSelection();
			this.lastLeftPress = null;
			this.pauseMouseReportingForContextMenu();
			return;
		}

		if (this.scrollSelectionAtViewportEdge(packet)) return;
		if (this.selectionDragging && isMouseRelease(packet)) {
			this.finishSelection(packet, location);
			return;
		}
		if (!location) return;
		if (isLeftPress(packet)) {
			this.startSelection(location);
			return;
		}
		if (this.selectionDragging && isLeftDrag(packet) && location.area === this.selectionArea) {
			this.lastLeftPress = null;
			this.preserveSelectionFocusOnRelease = false;
			this.selectionFocus = location.point;
			this.repaintScrollableViewport(this.getTerminalWidth());
		}
	}

	private startSelection(location: SelectionLocation): void {
		const now = Date.now();
		const line = location.point.line;
		if (this.lastLeftPress && this.lastLeftPress.area === location.area && this.lastLeftPress.line === line && now - this.lastLeftPress.at <= DOUBLE_CLICK_MS) {
			this.selectionArea = location.area;
			this.selectionAnchor = { line, col: 0 };
			this.selectionFocus = { line, col: this.selectionLineWidth(location.area, line) };
			this.selectionDragging = true;
			this.preserveSelectionFocusOnRelease = true;
			this.lastLeftPress = null;
			this.repaintScrollableViewport(this.getTerminalWidth());
			return;
		}

		this.selectionArea = location.area;
		this.selectionAnchor = location.point;
		this.selectionFocus = location.point;
		this.selectionDragging = true;
		this.preserveSelectionFocusOnRelease = false;
		this.lastLeftPress = { area: location.area, line, at: now };
		this.repaintScrollableViewport(this.getTerminalWidth());
	}

	private finishSelection(packet: SgrMousePacket, location: SelectionLocation | null): void {
		if (!this.preserveSelectionFocusOnRelease) {
			this.selectionFocus = location?.area === this.selectionArea
				? location.point
				: this.clampedSelectionPointForPacket(packet, this.selectionArea);
		}
		this.preserveSelectionFocusOnRelease = false;
		this.selectionDragging = false;
		const selectedText = this.getSelectedText();
		if (selectedText) {
			this.lastLeftPress = null;
			this.onCopySelection?.(selectedText);
		} else {
			this.clearSelection();
		}
		this.repaintScrollableViewport(this.getTerminalWidth());
	}

	private selectionLocationForPacket(packet: SgrMousePacket): SelectionLocation | null {
		if (packet.row < 1) return null;
		const col = Math.max(0, packet.col - 1);
		if (packet.row <= this.visibleScrollableRows) {
			return { area: "root", point: { line: this.visibleRootStart + packet.row - 1, col } };
		}
		const clusterLine = packet.row - this.visibleScrollableRows - 1;
		if (clusterLine < 0 || clusterLine >= this.visibleClusterLines.length) return null;
		return { area: "cluster", point: { line: clusterLine, col } };
	}

	private scrollSelectionAtViewportEdge(packet: SgrMousePacket): boolean {
		if (!this.selectionDragging || this.selectionArea !== "root" || !isLeftDrag(packet)) return false;
		const delta = packet.row <= 1 ? 1 : packet.row >= this.visibleScrollableRows ? -1 : 0;
		if (delta === 0) return false;
		const nextOffset = Math.max(0, Math.min(this.scrollOffset + delta, this.maxScrollOffset));
		if (nextOffset === this.scrollOffset) return false;
		this.lastLeftPress = null;
		this.preserveSelectionFocusOnRelease = true;
		this.scrollOffset = nextOffset;
		const start = this.updateVisibleRootWindow();
		const edgeLine = delta > 0 ? start : start + Math.max(0, this.visibleScrollableRows - 1);
		this.selectionFocus = { line: edgeLine, col: Math.max(0, packet.col - 1) };
		this.repaintScrollableViewport(this.getTerminalWidth());
		return true;
	}

	private clampedSelectionPointForPacket(packet: SgrMousePacket, area: SelectionArea | null): SelectionPoint {
		if (area === "cluster") {
			return {
				line: Math.max(0, Math.min(packet.row - this.visibleScrollableRows - 1, Math.max(0, this.visibleClusterLines.length - 1))),
				col: Math.max(0, packet.col - 1),
			};
		}
		const row = Math.max(1, Math.min(packet.row, this.visibleScrollableRows));
		return { line: this.visibleRootStart + row - 1, col: Math.max(0, packet.col - 1) };
	}

	private decorateCluster(cluster: FixedEditorCluster): FixedEditorCluster {
		if (this.selectionArea !== "cluster") return cluster;
		return {
			...cluster,
			lines: cluster.lines.map((line, index) => this.renderSelectionHighlight(line, index, "cluster")),
		};
	}

	private renderSelectionHighlight(line: string, lineIndex: number, area: SelectionArea): string {
		const range = this.getSelectionRangeForLine(lineIndex, area);
		if (!range) return line;
		const plain = stripAnsi(line);
		const startCol = Math.max(0, Math.min(range.startCol, visibleWidth(plain)));
		const endCol = Math.max(startCol, Math.min(range.endCol, visibleWidth(plain)));
		if (startCol === endCol) return line;
		const before = sliceColumns(plain, 0, startCol);
		const selected = sliceColumns(plain, startCol, endCol);
		const after = sliceColumns(plain, endCol, Number.POSITIVE_INFINITY);
		return `${before}\x1b[7m${selected}\x1b[27m${after}`;
	}

	private selectionLineWidth(area: SelectionArea, lineIndex: number): number {
		const lines = area === "root" ? this.visibleRootLines : this.visibleClusterLines;
		const firstLine = area === "root" ? this.visibleRootStart : 0;
		return visibleWidth(stripAnsi(lines[lineIndex - firstLine] ?? ""));
	}

	private getSelectedText(): string {
		if (!this.selectionArea || !this.selectionAnchor || !this.selectionFocus) return "";
		const start = compareSelectionPoints(this.selectionAnchor, this.selectionFocus) <= 0 ? this.selectionAnchor : this.selectionFocus;
		const end = start === this.selectionAnchor ? this.selectionFocus : this.selectionAnchor;
		if (start.line === end.line && start.col === end.col) return "";
		const lines = this.selectionArea === "root" ? this.rootLines : this.visibleClusterLines;
		const selected: string[] = [];
		for (let lineIndex = start.line; lineIndex <= end.line; lineIndex++) {
			const line = stripAnsi(lines[lineIndex] ?? "");
			const startCol = lineIndex === start.line ? start.col : 0;
			const endCol = lineIndex === end.line ? end.col : Number.POSITIVE_INFINITY;
			selected.push(sliceColumns(line, startCol, endCol));
		}
		return selected.join("\n").replace(/[ \t]+$/gm, "").trimEnd();
	}

	private getSelectionRangeForLine(lineIndex: number, area: SelectionArea): { startCol: number; endCol: number } | null {
		if (this.selectionArea !== area || !this.selectionAnchor || !this.selectionFocus) return null;
		const start = compareSelectionPoints(this.selectionAnchor, this.selectionFocus) <= 0 ? this.selectionAnchor : this.selectionFocus;
		const end = start === this.selectionAnchor ? this.selectionFocus : this.selectionAnchor;
		if (lineIndex < start.line || lineIndex > end.line) return null;
		return {
			startCol: lineIndex === start.line ? start.col : 0,
			endCol: lineIndex === end.line ? end.col : Number.POSITIVE_INFINITY,
		};
	}

	private isLocationInsideSelection(location: SelectionLocation | null): boolean {
		if (!location || location.area !== this.selectionArea) return false;
		const range = this.getSelectionRangeForLine(location.point.line, location.area);
		return Boolean(range && location.point.col >= range.startCol && location.point.col < range.endCol);
	}

	private pauseMouseReportingForContextMenu(): void {
		if (this.mouseReportingResumeTimer) clearTimeout(this.mouseReportingResumeTimer);
		this.writeOriginal(beginSynchronizedOutput() + disableMouseReporting() + endSynchronizedOutput());
		this.mouseReportingResumeTimer = setTimeout(() => {
			this.mouseReportingResumeTimer = null;
			if (!this.disposed) this.writeOriginal(beginSynchronizedOutput() + enableMouseReporting() + endSynchronizedOutput());
		}, CONTEXT_MENU_MOUSE_REPORTING_PAUSE_MS);
		this.mouseReportingResumeTimer.unref?.();
	}

	private clearSelection(): void {
		this.selectionArea = null;
		this.selectionAnchor = null;
		this.selectionFocus = null;
		this.selectionDragging = false;
		this.preserveSelectionFocusOnRelease = false;
	}

	/** 用原始 terminal.write 输出，保证 this 仍指向 terminal。 */
	private writeOriginal(data: string): void {
		const write = this.originalWrite ?? this.terminal.write;
		write.call(this.terminal, data);
	}

	/** 恢复安装前的 rows descriptor；若原 rows 来自原型链，则删除本实例 patch。 */
	private restoreRowsDescriptor(): void {
		if (this.originalOwnRowsDescriptor) {
			Object.defineProperty(this.terminal, "rows", this.originalOwnRowsDescriptor);
			return;
		}

		Reflect.deleteProperty(this.terminal, "rows");
	}

	/** dispose 期间尽力写恢复序列，恢复失败不阻断引用回滚。 */
	private writeResetSequenceBestEffort(): void {
		try {
			this.writeOriginal(resetFixedBottomEditorTerminalState());
		} catch {
			// 清理路径不能抛出，避免 reload/shutdown 时留下半恢复状态。
		}
	}

	/** 安装前检查 terminal/tui 是否已被其他 compositor 接管。 */
	private assertCanOwnCompositor(): void {
		for (const target of [this.terminal, this.tui]) {
			const owner = getOwner(target);
			if (owner && owner !== this.ownerToken) {
				throw new Error("[alps-pi] fixed bottom editor compositor conflict: terminal/TUI is already owned by another fixed editor");
			}
		}
		if (this.hasTerminalWriteConflict() || this.hasRowsConflict() || this.hasTuiRenderConflict()) {
			throw new Error("[alps-pi] fixed bottom editor compositor conflict: terminal/TUI is already patched by another compositor");
		}
	}

	/** 检测真实 terminal.write 是否已被实例级 wrapper 覆盖。 */
	private hasTerminalWriteConflict(): boolean {
		const prototypeWrite = findPrototypeDescriptor(this.terminal, "write")?.value;
		return typeof prototypeWrite === "function"
			&& Object.prototype.hasOwnProperty.call(this.terminal, "write")
			&& this.terminal.write !== prototypeWrite;
	}

	/** 检测真实 terminal.rows 是否已被实例级 getter 接管。 */
	private hasRowsConflict(): boolean {
		const ownRows = Object.getOwnPropertyDescriptor(this.terminal, "rows");
		return Boolean(ownRows?.get && !ownRows.set && findPrototypeDescriptor(this.terminal, "rows"));
	}

	/** 检测真实 TUI render/doRender 是否已被实例级 wrapper 覆盖。 */
	private hasTuiRenderConflict(): boolean {
		return hasPrototypeMethodOverride(this.tui, "render") || hasPrototypeMethodOverride(this.tui, "doRender");
	}

	/** 在 terminal 和 tui 上记录私有 owner，避免多个 fixed editor 同时接管。 */
	private markOwner(): void {
		setOwner(this.terminal, this.ownerToken);
		setOwner(this.tui, this.ownerToken);
	}

	/** 只清理本实例写入的 owner sentinel。 */
	private clearOwner(): void {
		clearOwner(this.terminal, this.ownerToken);
		clearOwner(this.tui, this.ownerToken);
	}

	/** 判断 Pi overlay 是否可见；可见时 compositor 必须完全让路。 */
	private hasVisibleOverlay(): boolean {
		if (this.checkingOverlay) return false;

		this.checkingOverlay = true;
		try {
			if (typeof this.tui?.hasOverlay === "function") {
				return Boolean(this.tui.hasOverlay());
			}

			const overlayStack = Reflect.get(this.tui ?? {}, "overlayStack");
			return Array.isArray(overlayStack) && overlayStack.some((entry) => isOverlayEntryVisible(entry, this.terminal));
		} finally {
			this.checkingOverlay = false;
		}
	}
}

/** 匹配聊天区滚动快捷键：用户配置即时生效，PageUp/PageDown 与 Ctrl+Shift 方向键保留原版兜底。 */
function parseKeyboardScrollDelta(data: string, shortcuts: { up: string; down: string } = { up: "super+up", down: "super+down" }): number {
	if (isKeyRelease(data)) return 0;
	if (
		matchesConfiguredShortcut(data, shortcuts.up)
		|| matchesKey(data, "pageUp")
		|| matchesKey(data, "ctrl+shift+up")
		|| /^\x1b\[(?:5;9(?::[12])?~|1;6(?::[12])?A|57421;9(?::[12])?u|57419;6(?::[12])?u)$/.test(data)
	) return 10;
	if (
		matchesConfiguredShortcut(data, shortcuts.down)
		|| matchesKey(data, "pageDown")
		|| matchesKey(data, "ctrl+shift+down")
		|| /^\x1b\[(?:6;9(?::[12])?~|1;6(?::[12])?B|57422;9(?::[12])?u|57420;6(?::[12])?u)$/.test(data)
	) return -10;
	return 0;
}

/** 解析 SGR mouse reporting 包；非完整鼠标输入返回 null 并交给 editor。 */
function parseSgrMousePackets(data: string): SgrMousePacket[] | null {
	const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
	const packets: SgrMousePacket[] = [];
	let offset = 0;

	for (const match of data.matchAll(pattern)) {
		if (match.index !== offset) return null;
		offset = match.index + match[0].length;
		packets.push({
			code: Number(match[1]),
			col: Number(match[2]),
			row: Number(match[3]),
			final: match[4] as "M" | "m",
		});
	}

	return packets.length > 0 && offset === data.length ? packets : null;
}

/** 提取鼠标基础按钮，匹配原版对修饰位的处理。 */
function mouseBaseButton(code: number): number {
	return code & ~(4 | 8 | 16 | 32);
}

/** 原版滚轮步长：上滚 +3，下滚 -3。 */
function mouseScrollDelta(packet: SgrMousePacket): number {
	if (packet.final !== "M") return 0;
	const baseButton = mouseBaseButton(packet.code);
	if (baseButton === 64) return 3;
	if (baseButton === 65) return -3;
	return 0;
}

function isLeftPress(packet: SgrMousePacket): boolean {
	return packet.final === "M" && mouseBaseButton(packet.code) === 0 && (packet.code & 32) === 0;
}

function isLeftDrag(packet: SgrMousePacket): boolean {
	return packet.final === "M" && mouseBaseButton(packet.code) === 0 && (packet.code & 32) !== 0;
}

function isRightPress(packet: SgrMousePacket): boolean {
	return packet.final === "M" && mouseBaseButton(packet.code) === 2 && (packet.code & 32) === 0;
}

function isMouseRelease(packet: SgrMousePacket): boolean {
	return packet.final === "m";
}

function compareSelectionPoints(a: SelectionPoint, b: SelectionPoint): number {
	return a.line === b.line ? a.col - b.col : a.line - b.line;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function sliceColumns(text: string, startCol: number, endCol: number): string {
	let col = 0;
	let result = "";
	for (const { segment } of graphemeSegmenter.segment(text)) {
		const width = Math.max(0, visibleWidth(segment));
		if (col >= startCol && col < endCol) result += segment;
		col += width;
	}
	return result;
}

function stripAnsi(line: string): string {
	return line.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** 沿原型链查找 rows descriptor，用于读取真实终端高度。 */
function findRowsDescriptor(terminal: FixedEditorTerminal): PropertyDescriptor | undefined {
	return findDescriptor(terminal, "rows");
}

/** 沿原型链查找指定属性 descriptor。 */
function findDescriptor(target: unknown, property: PropertyKey): PropertyDescriptor | undefined {
	if (!isObjectLike(target)) return undefined;
	let owner: object | null = target;
	while (owner) {
		const descriptor = Object.getOwnPropertyDescriptor(owner, property);
		if (descriptor) return descriptor;
		owner = Object.getPrototypeOf(owner);
	}
	return undefined;
}

/** 只查找原型链上的 descriptor，用于判断实例级覆盖。 */
function findPrototypeDescriptor(target: unknown, property: PropertyKey): PropertyDescriptor | undefined {
	if (!isObjectLike(target)) return undefined;
	let owner: object | null = Object.getPrototypeOf(target);
	while (owner) {
		const descriptor = Object.getOwnPropertyDescriptor(owner, property);
		if (descriptor) return descriptor;
		owner = Object.getPrototypeOf(owner);
	}
	return undefined;
}

/** 判断实例方法是否覆盖了原型方法。 */
function hasPrototypeMethodOverride(target: unknown, method: PropertyKey): boolean {
	if (!isObjectLike(target) || !Object.prototype.hasOwnProperty.call(target, method)) return false;
	const prototypeMethod = findPrototypeDescriptor(target, method)?.value;
	return typeof prototypeMethod === "function" && Reflect.get(target, method) !== prototypeMethod;
}

/** 读取外部 compositor owner sentinel。 */
function getOwner(target: unknown): symbol | undefined {
	if (!isObjectLike(target)) return undefined;
	return Reflect.get(target, COMPOSITOR_OWNER) as symbol | undefined;
}

/** 写入 owner sentinel；不可写对象会自然抛错并触发 fail closed。 */
function setOwner(target: unknown, owner: symbol): void {
	if (!isObjectLike(target)) return;
	Object.defineProperty(target, COMPOSITOR_OWNER, {
		configurable: true,
		value: owner,
	});
}

/** 仅当 owner 仍属于本实例时清理 sentinel。 */
function clearOwner(target: unknown, owner: symbol): void {
	if (isOwner(target, owner)) {
		Reflect.deleteProperty(target as object, COMPOSITOR_OWNER);
	}
}

/** 判断 target 是否仍由本实例持有。 */
function isOwner(target: unknown, owner: symbol): boolean {
	return getOwner(target) === owner;
}

/** 判断 unknown 是否可承载属性。 */
function isObjectLike(value: unknown): value is object {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** fallback overlay 可见性判断，模拟 Pi hasOverlay 的 hidden 与 visible 规则。 */
function isOverlayEntryVisible(entry: any, terminal: FixedEditorTerminal): boolean {
	if (!entry || entry.hidden === true) return false;
	const visible = entry.options?.visible;
	if (typeof visible === "function") {
		return Boolean(visible(Reflect.get(terminal, "columns"), Reflect.get(terminal, "rows")));
	}
	return true;
}

/** 把任意数字规整为正整数，非法时使用 fallback。 */
function coercePositiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

/** 宽度安全裁剪单行，避免 cluster 覆盖右侧边界。 */
function sanitizeLine(line: string, width: number): string {
	return visibleWidth(line) > width ? truncateToWidth(line, width, "", false) : line;
}

/** 对 cluster 做最终兜底裁剪，并在高度裁剪后校正 cursor 行号。 */
function normalizeCluster(cluster: FixedEditorCluster, width: number, terminalRows: number): FixedEditorCluster {
	const maxClusterRows = Math.max(0, Math.floor(terminalRows) - 1);
	const sourceLines = Array.isArray(cluster.lines) ? cluster.lines : [];
	const start = Math.max(0, sourceLines.length - maxClusterRows);
	const lines = sourceLines.slice(start).map((line) => sanitizeLine(line, Math.max(1, Math.floor(width))));
	const cursor = cluster.cursor && cluster.cursor.row >= start && cluster.cursor.row < sourceLines.length
		? {
			row: cluster.cursor.row - start,
			col: Math.max(0, cluster.cursor.col),
		}
		: undefined;

	return cursor ? { lines, cursor } : { lines };
}
