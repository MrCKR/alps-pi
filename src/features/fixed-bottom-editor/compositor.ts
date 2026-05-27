/** 功能：fixed bottom editor 最小 terminal split compositor 实现者：alps 实现日期：2026-05-27 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FixedEditorCluster } from "./cluster.ts";

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

const COMPOSITOR_OWNER = Symbol("alps.pi.fixedBottomEditor.compositorOwner.v1");
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

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
	return beginSynchronizedOutput() + resetScrollRegion() + enableAlternateScrollMode() + exitAlternateScreen() + showCursor() + endSynchronizedOutput();
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
	private readonly ownerToken = Symbol("alps.pi.fixedBottomEditor.compositor.instance");
	private installed = false;
	private disposed = false;
	private writing = false;
	private renderingCluster = false;
	private checkingOverlay = false;
	private emergencyCleanup: (() => void) | null = null;

	constructor(options: FixedBottomEditorCompositorOptions) {
		this.tui = options.tui;
		this.terminal = options.terminal;
		this.renderCluster = options.renderCluster;
		this.getShowHardwareCursor = options.getShowHardwareCursor ?? (() => true);
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

		this.writeOriginal(
			beginSynchronizedOutput()
			+ buildFixedEditorClusterPaint(cluster, rawRows, width, this.getShowHardwareCursor())
			+ endSynchronizedOutput(),
		);
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
		this.requestRepaint();
		return result;
	}

	/** 包装 TUI render：普通内容只保留可滚动区域，避免覆盖底部 fixed cluster。 */
	private renderScrollableRoot(width: number, ...args: unknown[]): string[] {
		if (!this.originalRender) return [];
		if (this.disposed || this.hasVisibleOverlay()) {
			return this.originalRender.call(this.tui, width, ...args);
		}

		const renderWidth = coercePositiveInteger(width, DEFAULT_COLUMNS);
		const rawRows = this.getRawRows();
		const cluster = this.getCluster(renderWidth, rawRows);
		const scrollableRows = Math.max(1, rawRows - cluster.lines.length);
		const lines = this.originalRender.call(this.tui, renderWidth, ...args);
		if (!Array.isArray(lines)) return [];
		const visibleLines = lines.length <= scrollableRows ? [...lines] : lines.slice(lines.length - scrollableRows);
		while (visibleLines.length < scrollableRows) {
			visibleLines.push("");
		}
		return visibleLines;
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
				+ buildFixedEditorClusterPaint(cluster, rawRows, width, this.getShowHardwareCursor())
				+ endSynchronizedOutput(),
			);
		} finally {
			this.writing = false;
		}
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

	/** 调用 renderCluster 并规整输出，确保至少保留一行可滚动区域。 */
	private getCluster(width: number, terminalRows: number): FixedEditorCluster {
		const wasRenderingCluster = this.renderingCluster;
		this.renderingCluster = true;
		try {
			const rendered = this.renderCluster(width, terminalRows) ?? { lines: [] };
			return normalizeCluster(rendered, width, terminalRows);
		} finally {
			this.renderingCluster = wasRenderingCluster;
		}
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
