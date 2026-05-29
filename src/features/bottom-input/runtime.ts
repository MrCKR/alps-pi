/** 功能：统一 bottom-input runtime，独占 editor/footer 并组装 fixed cluster 实现者：alps 实现日期：2026-05-28 */

import * as PiAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FixedBottomEditorStatus } from "../../settings.ts";
import { renderFixedEditorCluster } from "./cluster.ts";
import {
	FixedBottomEditorCompositor,
	type FixedBottomEditorCompositorOptions,
	type FixedEditorRenderable,
	type FixedEditorTerminal,
} from "./compositor.ts";
import {
	DEFAULT_BOTTOM_INPUT_SHORTCUTS,
	isStashShortcutInput,
	matchesConfiguredShortcut,
	resolveBottomInputShortcuts,
	type BottomInputShortcutKey,
	type BottomInputShortcuts,
} from "./shortcuts.ts";
import {
	getUsageTokenTotal,
	isAssistantUsage,
	normalizePromptText,
	renderBottomInputStatus,
	type AssistantUsage,
	type BottomInputFrameStatus,
} from "./status.ts";
import { createBottomInputEditor } from "./editor.ts";
import { getBottomInputIcons } from "./icons.ts";

export type { FixedBottomEditorStatus } from "../../settings.ts";

export type BottomInputRuntime = {
	/** 绑定当前 pi session context。 */
	bindSession(ctx: any): void;
	/** 启用或禁用 fixed editor 总开关。 */
	setEnabled(enabled: boolean): FixedBottomEditorStatus;
	/** 同步美化输入框与 fixed editor 两个独立开关。 */
	configure?(settings: { fixedEnabled?: boolean; beautifiedInputEnabled?: boolean }): FixedBottomEditorStatus;
	/** 释放所有运行时资源；重复调用安全。 */
	dispose(): void;
	/** 读取 fixed editor 状态快照。 */
	getStatus(): FixedBottomEditorStatus;
	/** 切换输入框线框美化。 */
	setBeautifiedInputEnabled?(enabled: boolean): void;
	/** 当前 UI session 重新开始计时。 */
	resetSessionStartTime(): void;
	/** 记录 latest prompt。 */
	setLastPrompt(prompt: unknown): void;
	/** 记录 thinking level。 */
	setThinkingLevel(level: unknown): void;
	/** agent_start：进入 streaming，清空 live usage。 */
	setStreaming?(streaming: boolean): void;
	/** message_update：记录 streaming usage。 */
	setLiveUsage(usage: unknown): void;
	/** message_end/turn_end：退出 streaming 并清理 live usage。 */
	clearLiveUsage(): void;
	/** 请求 fixed cluster 重绘；默认只重绘底部区域，避免整屏卡顿。 */
	requestRender(options?: { full?: boolean }): void;
	/** Alt+S 暂存/恢复当前 editor 文本。 */
	stashOrRestoreEditorText(ctx?: any): void;
	/** 复制当前 editor 文本。 */
	copyEditorText?(ctx?: any): void;
	/** 剪切当前 editor 文本。 */
	cutEditorText?(ctx?: any): void;
	/** 更新快捷键配置并立即生效。 */
	setShortcuts?(shortcuts: Partial<BottomInputShortcuts> | undefined): void;
};

type RuntimeUI = {
	setEditorComponent?: (factory: ((tui: any, theme: any, keybindings: any) => any) | undefined) => void;
	setFooter?: (factory: ((tui: any, theme: any, footerData: any) => any) | undefined) => void;
	setStatus?: (key: string, value: string | undefined) => void;
	theme?: any;
	onTerminalInput?: (handler: (data: string) => { consume?: boolean } | undefined) => (() => void) | void;
};

type CompositorLike = Pick<
	FixedBottomEditorCompositor,
	"install" | "dispose" | "hideRenderable" | "renderHidden" | "requestRepaint" | "setKeyboardScrollShortcuts" | "jumpToPreviousRootTarget" | "jumpToNextRootTarget" | "jumpToRootBottom"
>;

type FixedEditorContainers = {
	/** Pi 内置 statusContainer，包含 working 动画、todo 等状态区域。 */
	statusContainer: FixedEditorRenderable | null;
	/** Pi 内置 editor 上方 widget 容器；只接管原生/其他扩展 widget，不承载 alps-pi 自身状态栏。 */
	widgetContainerAbove: FixedEditorRenderable | null;
	/** custom editor 所在容器。 */
	editorContainer: FixedEditorRenderable;
	/** Pi 内置 editor 下方 widget 容器；只接管原生/其他扩展 widget，不承载 alps-pi 自身 last prompt。 */
	widgetContainerBelow: FixedEditorRenderable | null;
};

type BottomInputRuntimeOptions = {
	/** 测试注入点：生产环境使用真实 compositor。 */
	createCompositor?: (options: FixedBottomEditorCompositorOptions) => CompositorLike;
	/** 默认 true；测试可关闭定时器，避免进程悬挂。 */
	startClock?: boolean;
	/** 测试注入点：生产环境使用 Date.now。 */
	now?: () => number;
	/** 初始快捷键配置。 */
	shortcuts?: Partial<BottomInputShortcuts>;
	/** 测试注入点：生产环境使用 Pi 内置剪贴板 API。 */
	copyToClipboard?: (text: string) => Promise<void> | void;
};

const FALLBACK_EDITOR_THEME = {
	borderColor: (text: string) => text,
	selectList: {},
};
const STASH_STATUS_KEY = "alps-pi-stash";
const STATUS_RENDER_INTERVAL_MS = 1_000;
const STATUS_RENDER_DEBOUNCE_MS = 33;
const LAYOUT_CACHE_TTL_MS = 250;
const STREAMING_LAYOUT_CACHE_TTL_MS = 1000;

/** 创建统一 bottom-input runtime；调用方负责同步 settings 状态。 */
export function createBottomInputRuntime(options: BottomInputRuntimeOptions = {}): BottomInputRuntime {
	return new BottomInputRuntimeImpl(options);
}

/** bottom-input 的单一 runtime owner：只通过 setEditorComponent + setFooter 接管 UI。 */
class BottomInputRuntimeImpl implements BottomInputRuntime {
	private readonly createCompositor: (options: FixedBottomEditorCompositorOptions) => CompositorLike;
	private readonly startClock: boolean;
	private readonly now: () => number;
	private readonly copyToClipboardImpl: (text: string) => Promise<void> | void;
	private ctx: any;
	private ui: RuntimeUI | undefined;
	private generation = 0;
	private enabled = false;
	private beautifiedInputEnabled = true;
	private installed = false;
	private failure: string | undefined;
	private layoutInstalled = false;
	private creatingFooter = false;
	private compositor: CompositorLike | null = null;
	private editorInstance: any;
	private footerComponent: any;
	private footerData: any;
	private footerDataRestore: (() => void) | null = null;
	private theme: any;
	private editorTheme: any;
	private tui: any;
	private removeInputListener: (() => void) | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private renderTimer: ReturnType<typeof setTimeout> | null = null;
	private renderPending = false;
	private renderPendingFull = false;
	private cachedLayout: { key: string; expiresAt: number; result: { topLines: string[]; secondaryLines: string[]; lastPromptLines: string[]; frameStatus: BottomInputFrameStatus } } | null = null;
	private stashedEditorText: string | null = null;
	private liveUsage: AssistantUsage | null = null;
	private latestAssistantUsage: AssistantUsage | null = null;
	private isStreaming = false;
	private currentThinkingLevel: string | null = null;
	private lastPrompt = "";
	private sessionStartTime: number;
	private shortcuts: BottomInputShortcuts;

	constructor(options: BottomInputRuntimeOptions) {
		this.createCompositor = options.createCompositor ?? ((compositorOptions) => new FixedBottomEditorCompositor(compositorOptions));
		this.startClock = options.startClock !== false;
		this.now = options.now ?? (() => Date.now());
		this.copyToClipboardImpl = options.copyToClipboard ?? ((PiAgent as { copyToClipboard?: (text: string) => Promise<void> | void }).copyToClipboard ?? (() => undefined));
		this.sessionStartTime = this.now();
		this.shortcuts = resolveBottomInputShortcuts(options.shortcuts);
	}

	/** 保存当前 session context；切换 session 前先释放上一组 UI 资源，避免 stale ctx 继续被异步回调访问。 */
	bindSession(ctx: any): void {
		const previousCtx = this.ctx;
		const previousUi = this.ui;
		const nextUi = readRuntimeUI(ctx);
		const sameUiSession = Boolean(previousUi && nextUi && previousUi === nextUi);
		if (previousCtx && previousCtx !== ctx && !sameUiSession && (this.installed || this.layoutInstalled)) {
			this.disable();
		}
		if (!previousCtx && ctx) {
			this.sessionStartTime = this.now();
		}
		if (previousCtx !== ctx || previousUi !== nextUi) {
			this.generation += 1;
		}
		this.ctx = ctx;
		this.ui = nextUi;
		this.failure = undefined;
	}

	setEnabled(enabled: boolean): FixedBottomEditorStatus {
		return this.configure({ fixedEnabled: enabled });
	}

	configure(settings: { fixedEnabled?: boolean; beautifiedInputEnabled?: boolean }): FixedBottomEditorStatus {
		if (typeof settings.beautifiedInputEnabled === "boolean") {
			this.beautifiedInputEnabled = settings.beautifiedInputEnabled;
		}
		const fixedEnabled = settings.fixedEnabled ?? this.enabled;
		return this.syncLayout(fixedEnabled, this.beautifiedInputEnabled);
	}

	dispose(): void {
		this.generation += 1;
		this.disable();
		this.ctx = undefined;
		this.ui = undefined;
		this.editorInstance = undefined;
		this.footerComponent = undefined;
		this.restoreFooterDataHook();
		this.footerData = undefined;
		this.tui = undefined;
		this.theme = undefined;
		this.editorTheme = undefined;
		this.stashedEditorText = null;
		this.liveUsage = null;
		this.latestAssistantUsage = null;
		this.currentThinkingLevel = null;
		this.lastPrompt = "";
		this.sessionStartTime = this.now();
	}

	getStatus(): FixedBottomEditorStatus {
		return this.toStatus();
	}

	setBeautifiedInputEnabled(enabled: boolean): void {
		this.configure({ beautifiedInputEnabled: enabled });
	}

	resetSessionStartTime(): void {
		this.sessionStartTime = this.now();
		this.resetLayoutCache();
		this.requestRender();
	}

	setLastPrompt(prompt: unknown): void {
		this.lastPrompt = normalizePromptText(prompt);
		this.resetLayoutCache();
		this.requestRender();
	}

	setThinkingLevel(level: unknown): void {
		this.currentThinkingLevel = typeof level === "string" && level ? level : null;
		this.resetLayoutCache();
		this.requestRender();
	}

	setStreaming(streaming: boolean): void {
		this.isStreaming = streaming;
		if (streaming) this.liveUsage = null;
		this.resetLayoutCache();
		this.requestRender();
	}

	setLiveUsage(usage: unknown): void {
		if (isAssistantUsage(usage) && getUsageTokenTotal(usage) > 0) {
			this.liveUsage = usage;
			this.latestAssistantUsage = usage;
		}
		this.resetLayoutCache();
		this.requestRender();
	}

	clearLiveUsage(): void {
		this.isStreaming = false;
		this.liveUsage = null;
		this.resetLayoutCache();
		this.requestRender();
	}

	requestRender(options: { full?: boolean } = {}): void {
		if (!this.layoutInstalled) return;
		if (options.full) this.renderPendingFull = true;
		if (this.renderPending) return;
		const generation = this.generation;
		this.renderPending = true;
		this.renderTimer = setTimeout(() => {
			if (generation !== this.generation || !this.layoutInstalled) {
				this.renderPending = false;
				this.renderPendingFull = false;
				this.renderTimer = null;
				return;
			}
			const shouldRenderFull = this.renderPendingFull;
			this.renderPending = false;
			this.renderPendingFull = false;
			this.renderTimer = null;
			if (this.enabled && this.compositor) {
				if (shouldRenderFull && typeof this.tui?.requestRender === "function") {
					this.tui.requestRender();
					return;
				}
				this.compositor.requestRepaint();
				return;
			}
			if (typeof this.tui?.requestRender === "function") this.tui.requestRender();
		}, STATUS_RENDER_DEBOUNCE_MS);
		this.renderTimer.unref?.();
	}

	stashOrRestoreEditorText(ctx: any = this.ctx): void {
		if (!ctx?.hasUI || !ctx.ui) return;
		const rawText = getCurrentEditorText(ctx, this.editorInstance);
		const hasStash = this.stashedEditorText !== null;

		if (!hasNonWhitespaceText(rawText)) {
			if (!hasStash) {
				notify(ctx, "Nothing to stash", "info");
				return;
			}
			setEditorText(ctx, this.editorInstance, this.stashedEditorText ?? "");
			this.stashedEditorText = null;
			ctx.ui.setStatus?.(STASH_STATUS_KEY, undefined);
			notify(ctx, "Stash restored", "info");
			this.requestRender();
			return;
		}

		this.stashedEditorText = rawText;
		setEditorText(ctx, this.editorInstance, "");
		ctx.ui.setStatus?.(STASH_STATUS_KEY, "stash");
		notify(ctx, hasStash ? "Stash updated" : "Text stashed", "info");
		this.requestRender();
	}

	copyEditorText(ctx: any = this.ctx): void {
		const text = getCurrentEditorText(ctx, this.editorInstance);
		if (!hasNonWhitespaceText(text)) {
			notify(ctx, "Nothing to copy", "info");
			return;
		}
		void this.copyTextToClipboard(text)
			.then(() => notify(ctx, "Copied editor text", "info"))
			.catch(() => notify(ctx, "Copy failed", "warning"));
	}

	cutEditorText(ctx: any = this.ctx): void {
		const text = getCurrentEditorText(ctx, this.editorInstance);
		if (!hasNonWhitespaceText(text)) {
			notify(ctx, "Nothing to cut", "info");
			return;
		}
		void this.copyTextToClipboard(text)
			.then(() => {
				setEditorText(ctx, this.editorInstance, "");
				notify(ctx, "Cut editor text", "info");
				this.requestRender();
			})
			.catch(() => notify(ctx, "Cut failed", "warning"));
	}

	setShortcuts(shortcuts: Partial<BottomInputShortcuts> | undefined): void {
		this.shortcuts = resolveBottomInputShortcuts(shortcuts);
		this.compositor?.setKeyboardScrollShortcuts({
			up: this.shortcuts.scrollChatUp,
			down: this.shortcuts.scrollChatDown,
		});
	}

	/** 同步 editor layer 与 fixed compositor layer；两个开关互不隐式改写。 */
	private syncLayout(fixedEnabled: boolean, beautifiedInputEnabled: boolean): FixedBottomEditorStatus {
		this.enabled = fixedEnabled;
		this.beautifiedInputEnabled = beautifiedInputEnabled;
		this.resetLayoutCache();

		const needsLayout = fixedEnabled || beautifiedInputEnabled;
		if (!needsLayout) return this.disable();

		const ui = this.getBoundUI();
		if (!ui) {
			if (fixedEnabled) return this.failClosed("bottom input requires a bound UI session");
			this.enabled = false;
			return this.toStatus();
		}

		try {
			this.validateUI(ui);
			this.failure = undefined;
			if (!this.layoutInstalled) {
				this.editorInstance = undefined;
				this.footerComponent = undefined;
				this.restoreFooterDataHook();
				this.footerData = undefined;
				ui.setEditorComponent!(this.createEditorFactory());
				this.layoutInstalled = true;
				this.installInputListener();
				this.startClockTimer();

				this.creatingFooter = true;
				try {
					ui.setFooter!(this.createFooterFactory());
				} finally {
					this.creatingFooter = false;
				}
			} else if (fixedEnabled && this.tui && !this.installed) {
				this.installCompositor(this.tui);
			} else if (!fixedEnabled && this.installed) {
				this.teardownCompositor();
				this.installed = false;
				revealFixedEditorContainers(this.tui);
				if (!beautifiedInputEnabled) {
					this.stopClockTimer();
					this.stopRenderTimer();
					this.removeInputListener?.();
					this.removeInputListener = null;
					this.restoreDefaultLayout();
					this.layoutInstalled = false;
					this.editorInstance = undefined;
					this.footerComponent = undefined;
					this.restoreFooterDataHook();
					this.footerData = undefined;
					this.tui = undefined;
					this.theme = undefined;
					this.editorTheme = undefined;
				} else {
					this.tui?.requestRender?.(true);
				}
			}
			this.requestRender();
			return this.toStatus();
		} catch (error) {
			this.creatingFooter = false;
			return fixedEnabled ? this.failClosed(formatFailure(error)) : this.disableWithFailure(formatFailure(error));
		}
	}

	/** 禁用 fixed/editor layer，恢复 Pi 默认 editor/footer 布局。 */
	private disable(): FixedBottomEditorStatus {
		if (!this.enabled && !this.installed && !this.layoutInstalled && !this.failure) {
			return this.toStatus();
		}

		this.enabled = false;
		this.failure = undefined;
		this.stopClockTimer();
		this.stopRenderTimer();
		this.removeInputListener?.();
		this.removeInputListener = null;
		this.teardownCompositor();
		this.restoreDefaultLayout();
		this.installed = false;
		this.layoutInstalled = false;
		this.editorInstance = undefined;
		this.footerComponent = undefined;
		this.restoreFooterDataHook();
		this.footerData = undefined;
		this.tui = undefined;
		this.theme = undefined;
		this.editorTheme = undefined;
		this.resetLayoutCache();
		return this.toStatus();
	}

	private getBoundUI(): RuntimeUI | undefined {
		return this.ui;
	}

	private validateUI(ui: RuntimeUI): void {
		if (typeof ui.setEditorComponent !== "function") {
			throw new Error("bottom input expected ctx.ui.setEditorComponent(factory) to exist");
		}
		if (typeof ui.setFooter !== "function") {
			throw new Error("bottom input expected ctx.ui.setFooter(factory) to exist");
		}
	}

	private createEditorFactory(): (tui: any, theme: any, keybindings: any) => any {
		return (tui: any, theme: any, keybindings: any) => {
			this.tui = tui;
			this.editorTheme = theme ?? FALLBACK_EDITOR_THEME;
			const editorStateOwner = this;
			const editor = createBottomInputEditor(tui, this.editorTheme, keybindings, {
				get beautifiedInputEnabled() {
					return editorStateOwner.beautifiedInputEnabled;
				},
				getTheme: () => editorStateOwner.getRenderTheme(),
				getFrameStatus: (width) => editorStateOwner.getStatusLayout(width).frameStatus,
			});
			this.editorInstance = editor;
			this.patchEditorInput(editor);
			return editor;
		};
	}

	/** footer factory 是唯一 owner：捕获 tui/theme/footerData 并安装 compositor。 */
	private createFooterFactory(): (tui: any, theme: any, footerData: any) => any {
		return (tui: any, theme: any, footerData: any) => {
			this.tui = tui;
			this.theme = theme ?? FALLBACK_EDITOR_THEME;
			this.restoreFooterDataHook();
			this.footerData = footerData;
			this.installFooterStatusRepaintHook(footerData);
			if (this.enabled) {
				try {
					this.installCompositor(tui);
				} catch (error) {
					if (this.creatingFooter) throw error;
					this.failClosed(formatFailure(error));
				}
			}

			const unsubscribeBranch = typeof footerData?.onBranchChange === "function"
				? footerData.onBranchChange(() => {
					this.resetLayoutCache();
					this.requestRender();
				})
				: undefined;
			const footer = {
				dispose: () => {
					unsubscribeBranch?.();
					if (this.footerComponent === footer) {
						this.restoreFooterDataHook();
						this.teardownCompositor();
						this.installed = false;
					}
				},
				invalidate: () => this.requestRender(),
				/** fixed 关闭时，footer owner 负责保留下方 extension statuses 与 last prompt；fixed 开启时交给 cluster 渲染，避免双显。 */
				render: (width: number) => {
					if (this.enabled) return [];
					const rendered = this.getStatusLayout(width);
					return [...rendered.secondaryLines, ...rendered.lastPromptLines];
				},
			};
			this.footerComponent = footer;
			return footer;
		};
	}

	private installCompositor(tui: any): void {
		if (this.installed) return;
		const terminal = this.getTerminal(tui);
		const containers = findFixedEditorContainers(tui, this.editorInstance);
		if (!containers) {
			throw new Error("bottom input could not find the editor container in TUI children");
		}

		let compositor: CompositorLike | null = null;
		try {
			compositor = this.createCompositor({
				tui,
				terminal,
				getShowHardwareCursor: () => typeof tui?.getShowHardwareCursor === "function" ? Boolean(tui.getShowHardwareCursor()) : true,
				onCopySelection: (text) => {
					void this.copyTextToClipboard(text)
						.then(() => notify(this.ctx, "Copied selection", "info"))
						.catch(() => notify(this.ctx, "Copy selection failed", "warning"));
				},
				keyboardScrollShortcuts: {
					up: this.shortcuts.scrollChatUp,
					down: this.shortcuts.scrollChatDown,
				},
				renderCluster: (width, terminalRows) => this.renderCluster(compositor, containers, width, terminalRows),
			});
			hideRenderableIfPresent(compositor, containers.statusContainer);
			hideRenderableIfPresent(compositor, containers.widgetContainerAbove);
			compositor.hideRenderable(containers.editorContainer);
			hideRenderableIfPresent(compositor, containers.widgetContainerBelow);
			compositor.install();
			this.compositor = compositor;
			this.installed = true;
			this.failure = undefined;
			if (typeof tui?.requestRender === "function") tui.requestRender(true);
		} catch (error) {
			compositor?.dispose();
			throw error;
		}
	}

	private renderCluster(compositor: CompositorLike | null, containers: FixedEditorContainers, width: number, terminalRows: number) {
		const maxHeight = Math.max(1, Math.floor(terminalRows) - 1);
		const hiddenStatusLines = compositor ? renderHiddenLines(compositor, [containers.statusContainer], width) : [];
		const hiddenAboveWidgetLines = compositor ? renderHiddenLines(compositor, [containers.widgetContainerAbove], width) : [];
		const editorLines = compositor ? compositor.renderHidden(containers.editorContainer, width) : [];
		const hiddenBelowWidgetLines = compositor ? renderHiddenLines(compositor, [containers.widgetContainerBelow], width) : [];
		const rendered = this.getStatusLayout(width);
		return renderFixedEditorCluster({
			// 原生 working/status 始终位于主状态栏上方，避免插在 top 与 editor 之间。
			statusLines: hiddenStatusLines,
			topLines: hiddenAboveWidgetLines,
			editorLines: editorLines,
			secondaryLines: [...hiddenBelowWidgetLines, ...rendered.secondaryLines],
			lastPromptLines: rendered.lastPromptLines,
			width,
			maxHeight,
		});
	}

	private getRenderTheme(): any {
		return this.theme ?? this.ui?.theme ?? this.ctx?.ui?.theme ?? FALLBACK_EDITOR_THEME;
	}

	private getStatusLayout(width: number): { topLines: string[]; secondaryLines: string[]; lastPromptLines: string[]; frameStatus: BottomInputFrameStatus } {
		const now = this.now();
		if (this.cachedLayout && this.cachedLayout.expiresAt > now) {
			return cloneStatusLayout(this.cachedLayout.result);
		}

		const theme = this.getRenderTheme();
		const result = this.beautifiedInputEnabled ? renderBottomInputStatus({
			ctx: this.ctx,
			footerData: this.footerData,
			theme,
			width,
			beautifiedInputEnabled: this.beautifiedInputEnabled,
			isStreaming: this.isStreaming,
			liveUsage: this.liveUsage,
			latestAssistantUsage: this.latestAssistantUsage,
			currentThinkingLevel: this.currentThinkingLevel,
			sessionStartTime: this.sessionStartTime,
			now,
			lastPrompt: this.lastPrompt,
			icons: getBottomInputIcons(),
		}) : renderBottomInputStatus({
			ctx: undefined,
			footerData: this.footerData,
			theme,
			width,
			beautifiedInputEnabled: false,
			isStreaming: false,
			liveUsage: null,
			latestAssistantUsage: null,
			currentThinkingLevel: null,
			sessionStartTime: this.sessionStartTime,
			now,
			lastPrompt: this.lastPrompt,
			icons: { model: "", time: "◷" },
		});
		const ttl = this.isStreaming ? STREAMING_LAYOUT_CACHE_TTL_MS : LAYOUT_CACHE_TTL_MS;
		const layout = {
			topLines: [...result.topLines],
			secondaryLines: [...result.secondaryLines],
			lastPromptLines: [...result.lastPromptLines],
			frameStatus: { ...result.frameStatus },
		};
		this.cachedLayout = { key: result.cacheKey, expiresAt: now + ttl, result: layout };
		return cloneStatusLayout(layout);
	}

	private getTerminal(tui: any): FixedEditorTerminal {
		const terminal = tui?.terminal as FixedEditorTerminal | undefined;
		if (!terminal || typeof terminal.write !== "function") {
			throw new Error("bottom input could not find tui.terminal.write()");
		}
		return terminal;
	}

	private patchEditorInput(editor: any): void {
		if (!editor || typeof editor.handleInput !== "function" || editor.__alpsBottomInputPatched) return;
		const requestEditorRender = () => this.requestRender();
		const originalHandleInput = editor.handleInput.bind(editor);
		editor.handleInput = (data: string) => {
			if (this.handleShortcutInput(data)) return;
			originalHandleInput(data);
			// fixed 模式下原 editor 容器被隐藏，外层 TUI 偶发不重绘时也要主动刷新底部 cluster。
			requestEditorRender();
		};
		if (typeof editor.setText === "function") {
			const originalSetText = editor.setText.bind(editor);
			editor.setText = (text: string) => {
				const result = originalSetText(text);
				requestEditorRender();
				return result;
			};
		}
		if (typeof editor.insertTextAtCursor === "function") {
			const originalInsertTextAtCursor = editor.insertTextAtCursor.bind(editor);
			editor.insertTextAtCursor = (text: string) => {
				const result = originalInsertTextAtCursor(text);
				requestEditorRender();
				return result;
			};
		}
		editor.__alpsBottomInputPatched = true;
	}

	private installInputListener(): void {
		if (this.removeInputListener || typeof this.ui?.onTerminalInput !== "function") return;
		const generation = this.generation;
		this.removeInputListener = this.ui.onTerminalInput((data: string) => {
			if (generation !== this.generation) return undefined;
			return this.handleShortcutInput(data) ? { consume: true } : undefined;
		}) ?? null;
	}

	private handleShortcutInput(data: string): boolean {
		if ((!this.enabled && !this.beautifiedInputEnabled) || hasOverlay(this.ctx, this.tui)) return false;
		if (isStashShortcutInput(data, this.shortcuts.stashEditor)) {
			this.stashOrRestoreEditorText(this.ctx);
			return true;
		}
		if (matchesConfiguredShortcut(data, this.shortcuts.copyEditor)) {
			this.copyEditorText(this.ctx);
			return true;
		}
		if (matchesConfiguredShortcut(data, this.shortcuts.cutEditor)) {
			this.cutEditorText(this.ctx);
			return true;
		}
		if (matchesConfiguredShortcut(data, this.shortcuts.editorStart)) {
			return moveEditorToBoundary(this.editorInstance, "start");
		}
		if (matchesConfiguredShortcut(data, this.shortcuts.editorEnd)) {
			return moveEditorToBoundary(this.editorInstance, "end");
		}
		const jump = getJumpAction(data, this.shortcuts);
		if (jump) {
			this.runJumpAction(jump);
			return true;
		}
		return false;
	}

	private copyTextToClipboard(text: string): Promise<void> {
		return copyTextToClipboard(text, this.copyToClipboardImpl);
	}

	private runJumpAction(action: JumpAction): void {
		if (!this.compositor || !this.tui) return;
		if (action.kind === "bottom") {
			this.compositor.jumpToRootBottom?.();
			return;
		}
		const targets = collectChatMessageStartLines(this.tui, action.role);
		if (targets.length === 0) return;
		if (action.direction === "previous") {
			this.compositor.jumpToPreviousRootTarget?.(targets);
		} else {
			this.compositor.jumpToNextRootTarget?.(targets);
		}
	}

	/** 包装 footerData 状态写入，footer 变化后只触发当前 session 的重绘。 */
	private installFooterStatusRepaintHook(footerData: any): void {
		const generation = this.generation;
		const writableFooterData = footerData as {
			setExtensionStatus?: (key: string, text: string | undefined) => void;
			clearExtensionStatuses?: () => void;
		};
		if (typeof writableFooterData?.setExtensionStatus !== "function") return;
		const originalSetExtensionStatus = writableFooterData.setExtensionStatus;
		const originalClearExtensionStatuses = writableFooterData.clearExtensionStatuses;
		const request = () => {
			if (generation !== this.generation) return;
			this.resetLayoutCache();
			this.requestRender();
		};
		writableFooterData.setExtensionStatus = function setExtensionStatusAndRepaint(this: unknown, key: string, text: string | undefined) {
			originalSetExtensionStatus.call(this, key, text);
			request();
		};
		if (typeof originalClearExtensionStatuses === "function") {
			writableFooterData.clearExtensionStatuses = function clearExtensionStatusesAndRepaint(this: unknown) {
				originalClearExtensionStatuses.call(this);
				request();
			};
		}
		this.footerDataRestore = () => {
			writableFooterData.setExtensionStatus = originalSetExtensionStatus;
			if (originalClearExtensionStatuses) writableFooterData.clearExtensionStatuses = originalClearExtensionStatuses;
		};
	}

	private restoreFooterDataHook(): void {
		const restore = this.footerDataRestore;
		this.footerDataRestore = null;
		try {
			restore?.();
		} catch {
			// footerData hook 清理失败不能阻断 runtime teardown。
		}
	}

	private teardownCompositor(): void {
		const compositor = this.compositor;
		this.compositor = null;
		if (compositor) compositor.dispose();
	}

	private restoreDefaultLayout(): void {
		if (!this.layoutInstalled) return;
		const ui = this.ui;
		if (!ui) return;
		try {
			ui.setEditorComponent?.(undefined);
		} catch (error) {
			this.failure = formatFailure(error);
		}
		try {
			ui.setFooter?.(undefined);
		} catch (error) {
			this.failure = formatFailure(error);
		}
		try {
			ui.setStatus?.(STASH_STATUS_KEY, undefined);
		} catch {
			// 清理状态失败不影响 layout 恢复。
		}
	}

	private failClosed(reason: string): FixedBottomEditorStatus {
		this.enabled = false;
		this.installed = false;
		this.failure = reason;
		this.stopClockTimer();
		this.stopRenderTimer();
		this.removeInputListener?.();
		this.removeInputListener = null;
		this.teardownCompositor();
		this.restoreDefaultLayout();
		this.layoutInstalled = false;
		this.editorInstance = undefined;
		this.footerComponent = undefined;
		this.restoreFooterDataHook();
		this.footerData = undefined;
		return this.toStatus();
	}

	private disableWithFailure(reason: string): FixedBottomEditorStatus {
		this.disable();
		this.failure = reason;
		return this.toStatus();
	}

	private startClockTimer(): void {
		if (!this.startClock || this.timer) return;
		const generation = this.generation;
		this.timer = setInterval(() => {
			if (generation !== this.generation) return;
			this.requestRender();
		}, STATUS_RENDER_INTERVAL_MS);
		this.timer.unref?.();
	}

	private stopClockTimer(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	private stopRenderTimer(): void {
		if (!this.renderTimer) return;
		clearTimeout(this.renderTimer);
		this.renderTimer = null;
		this.renderPending = false;
		this.renderPendingFull = false;
	}

	private resetLayoutCache(): void {
		this.cachedLayout = null;
	}

	private toStatus(): FixedBottomEditorStatus {
		return this.failure
			? { enabled: this.enabled, installed: this.installed, failure: this.failure }
			: { enabled: this.enabled, installed: this.installed };
	}
}

type JumpAction =
	| { kind: "message"; role: "user" | "assistant"; direction: "previous" | "next" }
	| { kind: "bottom" };

type StatusLayout = { topLines: string[]; secondaryLines: string[]; lastPromptLines: string[]; frameStatus: BottomInputFrameStatus };

function createEmptyStatusLayout(): StatusLayout {
	return { topLines: [], secondaryLines: [], lastPromptLines: [], frameStatus: { model: null, thinking: null, context: null, elapsed: null } };
}

function cloneStatusLayout(layout: StatusLayout): StatusLayout {
	return {
		topLines: [...layout.topLines],
		secondaryLines: [...layout.secondaryLines],
		lastPromptLines: [...layout.lastPromptLines],
		frameStatus: { ...layout.frameStatus },
	};
}

/** 在 TUI 树中查找 editor 与其周边原生容器；这些容器都由唯一 footer owner 纳入 fixed cluster。 */
function findFixedEditorContainers(tui: any, editor: any): FixedEditorContainers | null {
	if (!editor) return null;
	const directContainer = tui?.editorContainer;
	if (isRenderable(directContainer)) {
		return {
			statusContainer: asRenderable(tui?.statusContainer),
			widgetContainerAbove: asRenderable(tui?.widgetContainerAbove),
			editorContainer: directContainer,
			widgetContainerBelow: asRenderable(tui?.widgetContainerBelow),
		};
	}

	const children = Array.isArray(tui?.children) ? tui.children : [];
	for (const [index, child] of children.entries()) {
		if (child === editor && isRenderable(child)) {
			return inferAdjacentContainers(children, index, child);
		}
		const nestedChildren = Array.isArray(child?.children) ? child.children : [];
		if (nestedChildren.includes(editor) && isRenderable(child)) {
			return inferAdjacentContainers(children, index, child);
		}
	}
	return null;
}

/** 按真实 Pi 顺序读取容器：statusContainer -> widgetAbove -> editorContainer -> widgetBelow。 */
function inferAdjacentContainers(children: any[], editorIndex: number, editorContainer: FixedEditorRenderable): FixedEditorContainers {
	return {
		statusContainer: asRenderable(children[editorIndex - 2]),
		widgetContainerAbove: asRenderable(children[editorIndex - 1]),
		editorContainer,
		widgetContainerBelow: asRenderable(children[editorIndex + 1]),
	};
}

function renderHiddenLines(compositor: CompositorLike, containers: Array<FixedEditorRenderable | null>, width: number): string[] {
	return containers.flatMap((container) => container ? compositor.renderHidden(container, width) : []);
}

function hideRenderableIfPresent(compositor: CompositorLike, container: FixedEditorRenderable | null): void {
	if (container) compositor.hideRenderable(container);
}

function revealFixedEditorContainers(tui: any): void {
	for (const container of [tui?.statusContainer, tui?.widgetContainerAbove, tui?.editorContainer, tui?.widgetContainerBelow]) {
		try {
			if (container && typeof container.render === "function") delete container.render;
		} catch {
			// 容器可能来自第三方组件；恢复失败时交给下一次 full render 自愈。
		}
	}
}

function asRenderable(value: unknown): FixedEditorRenderable | null {
	return isRenderable(value) ? value : null;
}

function isRenderable(value: unknown): value is FixedEditorRenderable {
	return typeof value === "object" && value !== null && typeof (value as FixedEditorRenderable).render === "function";
}

function getCurrentEditorText(ctx: any, editor: any): string {
	try {
		const text = typeof editor?.getText === "function" ? editor.getText() : ctx?.ui?.getEditorText?.();
		return typeof text === "string" ? text : "";
	} catch {
		return "";
	}
}

function setEditorText(ctx: any, editor: any, text: string): void {
	try {
		if (typeof editor?.setText === "function") {
			editor.setText(text);
			return;
		}
		ctx?.ui?.setEditorText?.(text);
	} catch {
		// 编辑器 API 不稳定时 fail-soft，不能破坏普通输入。
	}
}

function moveEditorToBoundary(editor: any, boundary: "start" | "end"): boolean {
	try {
		if (boundary === "start" && typeof editor?.moveToStart === "function") {
			editor.moveToStart();
			return true;
		}
		if (boundary === "end" && typeof editor?.moveToEnd === "function") {
			editor.moveToEnd();
			return true;
		}
		const state = editor?.state;
		if (state && Array.isArray(state.lines)) {
			if (boundary === "start") {
				state.cursorLine = 0;
				if (typeof editor.setCursorCol === "function") editor.setCursorCol(0);
				else state.cursorCol = 0;
			} else {
				state.cursorLine = Math.max(0, state.lines.length - 1);
				const col = String(state.lines[state.cursorLine] ?? "").length;
				if (typeof editor.setCursorCol === "function") editor.setCursorCol(col);
				else state.cursorCol = col;
			}
			return true;
		}
		if (boundary === "start" && typeof editor?.handleInput === "function") {
			editor.handleInput("\x1b[H");
			return true;
		}
		if (boundary === "end" && typeof editor?.handleInput === "function") {
			editor.handleInput("\x1b[F");
			return true;
		}
	} catch {
		return false;
	}
	return false;
}

function getJumpAction(data: string, shortcuts: BottomInputShortcuts): JumpAction | null {
	const table: Array<{ key: BottomInputShortcutKey; action: JumpAction }> = [
		{ key: "jumpPreviousUserMessage", action: { kind: "message", role: "user", direction: "previous" } },
		{ key: "jumpNextUserMessage", action: { kind: "message", role: "user", direction: "next" } },
		{ key: "jumpPreviousAssistantMessage", action: { kind: "message", role: "assistant", direction: "previous" } },
		{ key: "jumpNextAssistantMessage", action: { kind: "message", role: "assistant", direction: "next" } },
		{ key: "jumpChatBottom", action: { kind: "bottom" } },
	];
	return table.find((entry) => matchesConfiguredShortcut(data, shortcuts[entry.key]))?.action ?? null;
}

function collectChatMessageStartLines(tui: any, role: "user" | "assistant"): number[] {
	const children = Array.isArray(tui?.children) ? tui.children : [];
	const width = Math.max(1, tui?.terminal?.columns ?? 80);
	const targets: number[] = [];
	let offset = 0;
	for (const child of children) {
		const result = collectMessageStartLines(child, width, role, offset);
		targets.push(...result.targets);
		offset += result.lineCount;
	}
	return [...new Set(targets)].sort((a, b) => a - b);
}

function collectMessageStartLines(component: unknown, width: number, role: "user" | "assistant", offset: number): { targets: number[]; lineCount: number } {
	const lineCount = renderLineCount(component, width);
	if (isChatMessageComponentForRole(component, role)) return { targets: [offset], lineCount };
	const children = typeof component === "object" && component !== null ? Reflect.get(component, "children") : null;
	if (!Array.isArray(children) || children.length === 0) return { targets: [], lineCount };

	const targets: number[] = [];
	let childOffset = offset;
	let childrenLineCount = 0;
	for (const child of children) {
		const result = collectMessageStartLines(child, width, role, childOffset);
		targets.push(...result.targets);
		childOffset += result.lineCount;
		childrenLineCount += result.lineCount;
	}
	return { targets, lineCount: Math.max(lineCount, childrenLineCount) };
}

function isChatMessageComponentForRole(component: unknown, role: "user" | "assistant"): boolean {
	if (typeof component !== "object" || component === null) return false;
	const componentName = Reflect.get(component, "constructor")?.name;
	if (role === "assistant") return componentName === "AssistantMessageComponent";
	return componentName === "UserMessageComponent" || componentName === "SkillInvocationMessageComponent";
}

function renderLineCount(component: unknown, width: number): number {
	if (typeof component !== "object" || component === null) return 0;
	const render = Reflect.get(component, "render");
	if (typeof render !== "function") return 0;
	try {
		const lines = render.call(component, width);
		return Array.isArray(lines) ? lines.length : 0;
	} catch {
		return 0;
	}
}

function copyTextToClipboard(text: string, copyToClipboard: (text: string) => Promise<void> | void): Promise<void> {
	try {
		return Promise.resolve(copyToClipboard(text));
	} catch {
		// 剪贴板失败不能影响 editor 输入或滚动。
		return Promise.reject(new Error("copy failed"));
	}
}

/** 注册 bottom-input 输入框快捷键；raw terminal input 由 runtime 统一处理。 */
export function registerBottomInputShortcuts(pi: ExtensionAPI, runtime: BottomInputRuntime): void {
	pi.registerShortcut?.("alt+s", {
		description: "暂存/恢复当前输入框文本",
		handler: (ctx: any) => {
			runtime.stashOrRestoreEditorText(ctx);
		},
	});
}

function notify(ctx: any, message: string, level: "info" | "warning" | "error"): void {
	try {
		ctx?.ui?.notify?.(message, level);
	} catch {
		// 通知依赖 session UI；reload 后 stale ctx 失效时直接忽略。
	}
}

function hasOverlay(ctx: any, fallbackTui?: any): boolean {
	try {
		const tui = fallbackTui ?? ctx?.ui?.tui ?? ctx?.tui;
		if (typeof tui?.hasOverlay === "function") return Boolean(tui.hasOverlay());
		const overlayStack = Array.isArray(tui?.overlayStack) ? tui.overlayStack : [];
		return overlayStack.some((entry: any) => entry?.visible !== false && entry?.hidden !== true);
	} catch {
		return false;
	}
}

function readRuntimeUI(ctx: any): RuntimeUI | undefined {
	try {
		if (!ctx || ctx.hasUI !== true || !ctx.ui) return undefined;
		return ctx.ui as RuntimeUI;
	} catch {
		return undefined;
	}
}

function hasNonWhitespaceText(value: string): boolean {
	return /\S/.test(value);
}

function formatFailure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
