/** 功能：提供独立于 fixed compositor 的输入框美化 editor layer，实现者：alps 实现日期：2026-05-29 */

import * as PiAgent from "@earendil-works/pi-coding-agent";
import { Editor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeLike } from "../chrome-frame/styles.ts";
import { MIN_FRAME_WIDTH, renderBeautifiedEditorFrame } from "./frame.ts";
import type { BottomInputFrameStatus } from "./status.ts";

export type BottomInputEditorState = {
	/** 当前是否启用 Alps 输入框线框。 */
	beautifiedInputEnabled: boolean;
	/** 读取完整 Pi 主题；editor factory 传入的是 EditorTheme，不能直接用于 Alps 线框取色。 */
	getTheme(): ThemeLike;
	/** 读取当前边框状态；由 runtime 统一缓存和聚合。 */
	getFrameStatus(width: number): BottomInputFrameStatus;
};

export type BottomInputEditorOptions = {
	/** 测试注入 CustomEditor 构造器；生产默认读取 pi-coding-agent 导出。 */
	CustomEditor?: new (tui: any, theme: any, keybindings: any, options?: any) => any;
};

export type SplitEditorRenderResult = {
	/** 已剥离 Pi 原生上下线的 editor body。 */
	editorLines: string[];
	/** autocomplete/select-list 等弹出内容；必须保留在线框外。 */
	popupLines: string[];
};

/** 创建 bottom-input 自定义 editor；只改 render，不重写输入语义。 */
export function createBottomInputEditor(tui: any, theme: any, keybindings: any, state: BottomInputEditorState, options: BottomInputEditorOptions = {}): any {
	const BaseEditor = options.CustomEditor ?? (PiAgent as { CustomEditor?: new (tui: any, theme: any, keybindings: any, options?: any) => any }).CustomEditor;
	const editorTheme = theme ?? createFallbackEditorTheme();
	if (typeof BaseEditor === "function") {
		class AlpsBeautifiedEditor extends BaseEditor {
			private readonly stateRef: BottomInputEditorState;

			constructor() {
				super(tui, editorTheme, keybindings, { paddingX: 0 });
				this.stateRef = state;
			}

			/** render 是唯一视觉接管点；输入、提交、补全、历史和粘贴全部保留父类语义。 */
			render(width: number): string[] {
				if (!this.stateRef.beautifiedInputEnabled || width < MIN_FRAME_WIDTH) return super.render(width);
				const innerWidth = Math.max(1, Math.floor(width) - 4);
				const base = super.render(innerWidth);
				return renderBottomInputEditorLines({
					lines: base,
					width,
					theme: this.stateRef.getTheme(),
					borderColor: (text) => this.borderColor(text),
					state: this.stateRef,
				});
			}
		}
		return new AlpsBeautifiedEditor();
	}
	return new FallbackBeautifiedInputEditor(tui, editorTheme, state);
}

/** 判断一行是否是 Pi 原生 editor 的上下横线或带滚动提示横线。 */
export function isNativeEditorRule(line: string): boolean {
	const plain = stripAnsi(line).trim();
	return plain.includes("─") && [...plain].every((char) => "─↑↓ 0123456789more".includes(char));
}

/** 剥离 Pi 原生 editor 上下横线；popup/autocomplete 行保留给外层追加。 */
export function splitNativeEditorRender(lines: readonly string[]): SplitEditorRenderResult {
	if (lines.length === 0) return { editorLines: [], popupLines: [] };
	const withoutTop = isNativeEditorRule(lines[0] ?? "") ? lines.slice(1) : [...lines];
	const bottomRuleIndex = withoutTop.findIndex(isNativeEditorRule);
	if (bottomRuleIndex === -1) {
		return { editorLines: [...withoutTop], popupLines: [] };
	}
	return {
		editorLines: withoutTop.slice(0, bottomRuleIndex),
		popupLines: withoutTop.slice(bottomRuleIndex + 1),
	};
}

/** 包装原生 editor 输出；美化关闭时原样返回，美化开启时只包 editor body。 */
export function renderBottomInputEditorLines(input: { lines: readonly string[]; width: number; theme: ThemeLike; borderColor?: (text: string) => string; state: BottomInputEditorState }): string[] {
	const width = Number.isFinite(input.width) ? Math.max(0, Math.floor(input.width)) : 0;
	if (!input.state.beautifiedInputEnabled || width < MIN_FRAME_WIDTH) return [...input.lines];
	const { editorLines, popupLines } = splitNativeEditorRender(input.lines);
	return [
		...renderBeautifiedEditorFrame({
			editorLines,
			width,
			theme: input.theme,
			borderColor: input.borderColor,
			status: input.state.getFrameStatus(width),
		}),
		...fitPopupLines(popupLines, width),
	];
}

class FallbackBeautifiedInputEditor extends Editor {
	private readonly stateRef: BottomInputEditorState;

	constructor(tui: any, editorTheme: ThemeLike, stateRef: BottomInputEditorState) {
		super(tui, editorTheme as any, { paddingX: 0 });
		this.stateRef = stateRef;
	}

	/** 没有 CustomEditor 时只保留 pi-tui Editor 语义，并套用同一套 render 逻辑。 */
	render(width: number): string[] {
		if (!this.stateRef.beautifiedInputEnabled || width < MIN_FRAME_WIDTH) return super.render(width);
		const innerWidth = Math.max(1, Math.floor(width) - 4);
		const base = super.render(innerWidth);
		return renderBottomInputEditorLines({
			lines: base,
			width,
			theme: this.stateRef.getTheme(),
			borderColor: (text) => this.borderColor(text),
			state: this.stateRef,
		});
	}
}

function fitPopupLines(lines: readonly string[], width: number): string[] {
	return lines.map((line) => {
		const clipped = truncateToWidth(line, Math.max(1, width), "", true);
		const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
		return clipped + padding;
	});
}

function createFallbackEditorTheme(): ThemeLike {
	return {
		fg: (_token: string, text: string) => text,
		bg: (_token: string, text: string) => text,
		bold: (text: string) => text,
	};
}

function stripAnsi(input: string): string {
	return input.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "");
}
