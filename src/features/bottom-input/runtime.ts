/** 功能：Pi 0.84+ bottom-input runtime，仅通过公开 editor/footer/input API 提供输入美化与状态。 */

import * as PiAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_BOTTOM_INPUT_SHORTCUTS,
	isStashShortcutInput,
	matchesConfiguredShortcut,
	resolveBottomInputShortcuts,
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
import { writeBottomInputDebugLog } from "./debug.ts";
import { getBottomInputIcons } from "./icons.ts";
import { formatPiCapabilityFailures, inspectPiRuntimeCapabilities } from "../../pi-compat.ts";

export type BottomInputRuntimeStatus = {
	enabled: boolean;
	installed: boolean;
	failure?: string;
};

export type BottomInputRuntime = {
	bindSession(ctx: any): void;
	configure(settings: { beautifiedInputEnabled?: boolean }): BottomInputRuntimeStatus;
	dispose(): void;
	getStatus(): BottomInputRuntimeStatus;
	setBeautifiedInputEnabled(enabled: boolean): void;
	resetSessionStartTime(): void;
	setLastPrompt(prompt: unknown): void;
	setThinkingLevel(level: unknown): void;
	setStreaming?(streaming: boolean): void;
	setLiveUsage(usage: unknown, assistantMessageEvent?: unknown): void;
	clearLiveUsage(message?: unknown): void;
	resetThroughput(): void;
	requestRender(options?: { full?: boolean }): void;
	stashOrRestoreEditorText(ctx?: any): void;
	copyEditorText?(ctx?: any): void;
	cutEditorText?(ctx?: any): void;
	setShortcuts?(shortcuts: Partial<BottomInputShortcuts> | undefined): void;
};

type RuntimeUI = {
	setEditorComponent?: (factory: ((tui: any, theme: any, keybindings: any) => any) | undefined) => void;
	getEditorComponent?: () => unknown;
	setFooter?: (factory: ((tui: any, theme: any, footerData: any) => any) | undefined) => void;
	setStatus?: (key: string, value: string | undefined) => void;
	getEditorText?: () => string;
	setEditorText?: (text: string) => void;
	notify?: (message: string, level: "info" | "warning" | "error") => void;
	theme?: any;
	onTerminalInput?: (handler: (data: string) => { consume?: boolean } | undefined) => (() => void) | void;
};

type RuntimeUIReadResult = { stale: false; ui?: RuntimeUI } | { stale: true };

type BottomInputRuntimeOptions = {
	startClock?: boolean;
	now?: () => number;
	shortcuts?: Partial<BottomInputShortcuts>;
	copyToClipboard?: (text: string) => Promise<void> | void;
};

type StatusLayout = {
	topLines: string[];
	secondaryLines: string[];
	lastPromptLines: string[];
	frameStatus: BottomInputFrameStatus;
};

const FALLBACK_EDITOR_THEME = {
	borderColor: (text: string) => text,
	selectList: {},
};
const STASH_STATUS_KEY = "alps-pi-stash";
const STATUS_RENDER_INTERVAL_MS = 1_000;
const STATUS_RENDER_DEBOUNCE_MS = 33;
const LAYOUT_CACHE_TTL_MS = 250;
const STREAMING_LAYOUT_CACHE_TTL_MS = 1_000;
const MIN_THROUGHPUT_DURATION_MS = 250;

export function createBottomInputRuntime(options: BottomInputRuntimeOptions = {}): BottomInputRuntime {
	return new BottomInputRuntimeImpl(options);
}

class BottomInputRuntimeImpl implements BottomInputRuntime {
	private readonly startClock: boolean;
	private readonly now: () => number;
	private readonly copyToClipboardImpl: (text: string) => Promise<void> | void;
	private ctx: any;
	private ui: RuntimeUI | undefined;
	private generation = 0;
	private beautifiedInputEnabled = true;
	private installed = false;
	private failure: string | undefined;
	private editorInstance: any;
	private editorFactory: ((tui: any, theme: any, keybindings: any) => any) | undefined;
	private footerFactory: ((tui: any, theme: any, footerData: any) => any) | undefined;
	private footerComponent: any;
	private footerData: any;
	private theme: any;
	private editorTheme: any;
	private tui: any;
	private removeInputListener: (() => void) | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private renderTimer: ReturnType<typeof setTimeout> | null = null;
	private renderPendingFull = false;
	private layoutOwnerGeneration: number | null = null;
	private cachedLayout: { width: number; expiresAt: number; result: StatusLayout } | null = null;
	private stashedEditorText: string | null = null;
	private liveUsage: AssistantUsage | null = null;
	private latestAssistantUsage: AssistantUsage | null = null;
	private isStreaming = false;
	private outputStartedAt: number | null = null;
	private tokensPerSecond: number | null = null;
	private currentThinkingLevel: string | null = null;
	private lastPrompt = "";
	private sessionStartTime: number;
	private shortcuts: BottomInputShortcuts;
	private lastTuiFailure: string | undefined;

	constructor(options: BottomInputRuntimeOptions) {
		this.startClock = options.startClock !== false;
		this.now = options.now ?? (() => Date.now());
		this.copyToClipboardImpl = options.copyToClipboard
			?? ((PiAgent as { copyToClipboard?: (text: string) => Promise<void> | void }).copyToClipboard ?? (() => undefined));
		this.sessionStartTime = this.now();
		this.shortcuts = resolveBottomInputShortcuts(options.shortcuts);
	}

	bindSession(ctx: any): void {
		const next = readRuntimeUI(ctx);
		if (next.stale || !next.ui) {
			this.debug("bind_session", ctx, { note: next.stale ? "ignored_stale_ctx" : "ignored_no_ui_ctx" });
			return;
		}
		const previousCtx = this.ctx;
		const previousUi = this.ui;
		const sameUiSession = Boolean(previousUi && previousUi === next.ui);
		this.debug("bind_session", ctx, {
			nextUi: next.ui,
			note: previousCtx && previousCtx !== ctx && !sameUiSession && this.installed ? "switching_ui_session" : undefined,
			details: { sameUiSession, replacingCtx: Boolean(previousCtx && previousCtx !== ctx), hasPreviousUi: Boolean(previousUi) },
		});
		if (previousCtx && previousCtx !== ctx && !sameUiSession && this.installed) this.disable();
		if (!previousCtx) this.sessionStartTime = this.now();
		if ((previousCtx !== ctx || previousUi !== next.ui) && !sameUiSession) {
			this.generation += 1;
			this.stopRenderTimer();
		}
		this.ctx = ctx;
		this.ui = next.ui;
		this.failure = undefined;
	}

	configure(settings: { beautifiedInputEnabled?: boolean }): BottomInputRuntimeStatus {
		if (typeof settings.beautifiedInputEnabled === "boolean") this.beautifiedInputEnabled = settings.beautifiedInputEnabled;
		return this.syncLayout();
	}

	dispose(): void {
		this.generation += 1;
		this.disable();
		this.ctx = undefined;
		this.ui = undefined;
		this.stashedEditorText = null;
		this.liveUsage = null;
		this.latestAssistantUsage = null;
		this.outputStartedAt = null;
		this.tokensPerSecond = null;
		this.currentThinkingLevel = null;
		this.lastPrompt = "";
		this.sessionStartTime = this.now();
	}

	getStatus(): BottomInputRuntimeStatus {
		return this.toStatus();
	}

	setBeautifiedInputEnabled(enabled: boolean): void {
		this.configure({ beautifiedInputEnabled: enabled });
	}

	resetSessionStartTime(): void {
		this.sessionStartTime = this.now();
		this.outputStartedAt = null;
		this.tokensPerSecond = null;
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
		if (streaming) {
			this.liveUsage = null;
			this.outputStartedAt = null;
		}
		this.resetLayoutCache();
		this.requestRender();
	}

	setLiveUsage(usage: unknown, assistantMessageEvent?: unknown): void {
		if (this.outputStartedAt === null && isAssistantOutputDelta(assistantMessageEvent)) {
			this.outputStartedAt = this.now();
		}
		if (isAssistantUsage(usage) && getUsageTokenTotal(usage) > 0) {
			this.liveUsage = usage;
			this.latestAssistantUsage = usage;
		}
		this.resetLayoutCache();
		this.requestRender();
	}

	clearLiveUsage(message?: unknown): void {
		if (message === undefined) {
			this.outputStartedAt = null;
		} else {
			this.completeThroughput(message);
		}
		this.isStreaming = false;
		this.liveUsage = null;
		this.resetLayoutCache();
		this.requestRender();
	}

	resetThroughput(): void {
		this.outputStartedAt = null;
		this.tokensPerSecond = null;
		this.resetLayoutCache();
		this.requestRender();
	}

	requestRender(options: { full?: boolean } = {}): void {
		if (!this.installed || this.renderTimer) {
			if (options.full) this.renderPendingFull = true;
			return;
		}
		if (options.full) this.renderPendingFull = true;
		const generation = this.generation;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = null;
			if (generation !== this.generation || !this.installed) {
				this.renderPendingFull = false;
				return;
			}
			const full = this.renderPendingFull;
			this.renderPendingFull = false;
			if (!this.diagnoseTui(this.tui)) {
				this.failClosed("unsupported Pi TUI renderer mode");
				return;
			}
			this.tui?.requestRender?.(full || undefined);
		}, STATUS_RENDER_DEBOUNCE_MS);
		this.renderTimer.unref?.();
	}

	stashOrRestoreEditorText(ctx: any = this.ctx): void {
		if (!ctx?.hasUI || !ctx.ui) return;
		const rawText = getCurrentEditorText(ctx, this.editorInstance);
		const hasStash = this.stashedEditorText !== null;
		if (!hasNonWhitespaceText(rawText)) {
			if (!hasStash) return notify(ctx, "Nothing to stash", "info");
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
		if (!hasNonWhitespaceText(text)) return notify(ctx, "Nothing to copy", "info");
		const generation = this.generation;
		void this.copyTextToClipboard(text).then(
			() => generation === this.generation && notify(ctx, "Copied editor text", "info"),
			() => generation === this.generation && notify(ctx, "Copy failed", "warning"),
		);
	}

	cutEditorText(ctx: any = this.ctx): void {
		const text = getCurrentEditorText(ctx, this.editorInstance);
		if (!hasNonWhitespaceText(text)) return notify(ctx, "Nothing to cut", "info");
		const generation = this.generation;
		const editor = this.editorInstance;
		void this.copyTextToClipboard(text).then(() => {
			if (generation !== this.generation) return;
			setEditorText(ctx, editor, "");
			notify(ctx, "Cut editor text", "info");
			this.requestRender();
		}, () => generation === this.generation && notify(ctx, "Cut failed", "warning"));
	}

	setShortcuts(shortcuts: Partial<BottomInputShortcuts> | undefined): void {
		this.shortcuts = resolveBottomInputShortcuts(shortcuts);
	}

	private completeThroughput(message: unknown): void {
		const startedAt = this.outputStartedAt;
		this.outputStartedAt = null;
		const usage = readCompletedAssistantUsage(message);
		if (startedAt === null || !usage || usage.output <= 0) return;
		const durationMs = this.now() - startedAt;
		if (!Number.isFinite(durationMs) || durationMs < MIN_THROUGHPUT_DURATION_MS) return;
		const rate = usage.output * 1_000 / durationMs;
		if (Number.isFinite(rate) && rate > 0) this.tokensPerSecond = rate;
	}

	private syncLayout(): BottomInputRuntimeStatus {
		this.resetLayoutCache();
		this.debug("sync_layout", this.ctx, { details: { beautifiedInputEnabled: this.beautifiedInputEnabled } });
		if (!this.beautifiedInputEnabled) return this.disable();
		const ui = this.ui;
		if (!ui) return this.failClosed("bottom input requires a bound TUI session");
		try {
			this.validateUI(ui);
			if (!this.installed) this.installLayout(ui);
			this.failure = undefined;
			this.requestRender({ full: true });
			return this.toStatus();
		} catch (error) {
			return this.failClosed(formatFailure(error));
		}
	}

	private installLayout(ui: RuntimeUI): void {
		const ownerGeneration = this.generation;
		this.layoutOwnerGeneration = ownerGeneration;
		this.editorFactory = this.createEditorFactory(ownerGeneration);
		this.footerFactory = this.createFooterFactory(ownerGeneration);
		ui.setEditorComponent!(this.editorFactory);
		ui.setFooter!(this.footerFactory);
		this.installed = true;
		this.installInputListener();
		this.startClockTimer();
	}

	private disable(): BottomInputRuntimeStatus {
		if (!this.installed && !this.failure) return this.toStatus();
		this.debug("disable", this.ctx);
		this.stopClockTimer();
		this.stopRenderTimer();
		this.removeInputListener?.();
		this.removeInputListener = null;
		this.restoreDefaultLayout();
		this.installed = false;
		this.failure = undefined;
		this.layoutOwnerGeneration = null;
		this.editorFactory = undefined;
		this.footerFactory = undefined;
		this.editorInstance = undefined;
		this.footerComponent = undefined;
		this.footerData = undefined;
		this.tui = undefined;
		this.theme = undefined;
		this.editorTheme = undefined;
		this.resetLayoutCache();
		return this.toStatus();
	}

	private validateUI(ui: RuntimeUI): void {
		if (typeof ui.setEditorComponent !== "function") throw new Error("bottom input expected ctx.ui.setEditorComponent(factory)");
		if (typeof ui.getEditorComponent !== "function") throw new Error("bottom input expected ctx.ui.getEditorComponent()");
		if (typeof ui.setFooter !== "function") throw new Error("bottom input expected ctx.ui.setFooter(factory)");
	}

	private createEditorFactory(ownerGeneration: number): (tui: any, theme: any, keybindings: any) => any {
		return (tui, theme, keybindings) => {
			if (ownerGeneration !== this.generation || ownerGeneration !== this.layoutOwnerGeneration) return createStaleEditorFallback();
			if (!this.diagnoseTui(tui)) throw new Error("unsupported Pi TUI renderer mode");
			this.tui = tui;
			this.editorTheme = theme ?? FALLBACK_EDITOR_THEME;
			const owner = this;
			const editor = createBottomInputEditor(tui, this.editorTheme, keybindings, {
				get beautifiedInputEnabled() { return owner.beautifiedInputEnabled; },
				getTheme: () => owner.getRenderTheme(),
				getFrameStatus: (width) => owner.getStatusLayout(width).frameStatus,
			});
			this.editorInstance = editor;
			this.patchEditorInput(editor);
			return editor;
		};
	}

	private createFooterFactory(ownerGeneration: number): (tui: any, theme: any, footerData: any) => any {
		return (tui, theme, footerData) => {
			if (ownerGeneration !== this.generation || ownerGeneration !== this.layoutOwnerGeneration) return createStaleFooterFallback();
			const generation = this.generation;
			this.tui = tui;
			this.theme = theme ?? FALLBACK_EDITOR_THEME;
			this.footerData = footerData;
			let active = true;
			const unsubscribeBranch = footerData?.onBranchChange?.(() => {
				if (generation !== this.generation) return;
				this.resetLayoutCache();
				this.requestRender();
			});
			const footer = {
				__alpsBottomInputOwner: true,
				get __alpsBottomInputActive() { return active; },
				dispose: () => {
					active = false;
					unsubscribeBranch?.();
				},
				invalidate: () => generation === this.generation && this.requestRender(),
				render: (width: number) => {
					if (generation !== this.generation) return [];
					const rendered = this.getStatusLayout(width);
					return [...rendered.secondaryLines, ...rendered.lastPromptLines];
				},
			};
			this.footerComponent = footer;
			return footer;
		};
	}

	private getRenderTheme(): any {
		return this.theme ?? this.ui?.theme ?? FALLBACK_EDITOR_THEME;
	}

	private getStatusLayout(width: number): StatusLayout {
		const now = this.now();
		const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
		if (this.cachedLayout && this.cachedLayout.width === safeWidth && this.cachedLayout.expiresAt > now) {
			return cloneStatusLayout(this.cachedLayout.result);
		}
		const result = renderBottomInputStatus({
			ctx: this.ctx,
			footerData: this.footerData,
			theme: this.getRenderTheme(),
			width: safeWidth,
			beautifiedInputEnabled: true,
			isStreaming: this.isStreaming,
			liveUsage: this.liveUsage,
			latestAssistantUsage: this.latestAssistantUsage,
			currentThinkingLevel: this.currentThinkingLevel,
			tokensPerSecond: this.tokensPerSecond,
			sessionStartTime: this.sessionStartTime,
			now,
			lastPrompt: this.lastPrompt,
			icons: getBottomInputIcons(),
		});
		const layout: StatusLayout = {
			topLines: [...result.topLines],
			secondaryLines: [...result.secondaryLines],
			lastPromptLines: [...result.lastPromptLines],
			frameStatus: { ...result.frameStatus },
		};
		this.cachedLayout = {
			width: safeWidth,
			expiresAt: now + (this.isStreaming ? STREAMING_LAYOUT_CACHE_TTL_MS : LAYOUT_CACHE_TTL_MS),
			result: layout,
		};
		return cloneStatusLayout(layout);
	}

	private patchEditorInput(editor: any): void {
		if (!editor || typeof editor.handleInput !== "function" || editor.__alpsBottomInputPatched) return;
		const originalHandleInput = editor.handleInput.bind(editor);
		editor.handleInput = (data: string) => {
			if (this.handleShortcutInput(data)) return;
			originalHandleInput(data);
			this.requestRender();
		};
		for (const method of ["setText", "insertTextAtCursor"] as const) {
			if (typeof editor[method] !== "function") continue;
			const original = editor[method].bind(editor);
			editor[method] = (text: string) => {
				const result = original(text);
				this.requestRender();
				return result;
			};
		}
		editor.__alpsBottomInputPatched = true;
	}

	private installInputListener(): void {
		if (this.removeInputListener || typeof this.ui?.onTerminalInput !== "function") return;
		const generation = this.generation;
		this.removeInputListener = this.ui.onTerminalInput((data) => {
			if (generation !== this.generation) return undefined;
			return this.handleShortcutInput(data) ? { consume: true } : undefined;
		}) ?? null;
	}

	private handleShortcutInput(data: string): boolean {
		if (!this.beautifiedInputEnabled || hasOverlay(this.ctx, this.tui)) return false;
		if (isStashShortcutInput(data, this.shortcuts.stashEditor)) return this.stashOrRestoreEditorText(this.ctx), true;
		if (matchesConfiguredShortcut(data, this.shortcuts.copyEditor)) return this.copyEditorText(this.ctx), true;
		if (matchesConfiguredShortcut(data, this.shortcuts.cutEditor)) return this.cutEditorText(this.ctx), true;
		if (matchesConfiguredShortcut(data, this.shortcuts.editorStart)) return moveEditorToBoundary(this.editorInstance, "start");
		if (matchesConfiguredShortcut(data, this.shortcuts.editorEnd)) return moveEditorToBoundary(this.editorInstance, "end");
		return false;
	}

	private diagnoseTui(tui: any): boolean {
		const capabilities = inspectPiRuntimeCapabilities(tui);
		const failure = capabilities.tui.failure;
		if (failure !== this.lastTuiFailure) {
			this.lastTuiFailure = failure;
			for (const message of formatPiCapabilityFailures(capabilities).filter((entry) => entry.startsWith("tui:"))) {
				console.debug?.(`[alps-pi] ${message}`);
			}
		}
		return capabilities.tui.supported;
	}

	private copyTextToClipboard(text: string): Promise<void> {
		try {
			return Promise.resolve(this.copyToClipboardImpl(text));
		} catch {
			return Promise.reject(new Error("copy failed"));
		}
	}

	private restoreDefaultLayout(): void {
		const ui = this.ui;
		if (!ui) return;
		try {
			if (ui.getEditorComponent?.() === this.editorFactory) ui.setEditorComponent?.(undefined);
			if (isActiveAlpsFooterComponent(this.footerComponent) || this.footerComponent === undefined && this.footerFactory) ui.setFooter?.(undefined);
			ui.setStatus?.(STASH_STATUS_KEY, undefined);
		} catch (error) {
			if (!isStaleCtxError(error)) this.failure = formatFailure(error);
		}
	}

	private failClosed(reason: string): BottomInputRuntimeStatus {
		this.debug("fail_closed", this.ctx, { reason });
		this.disable();
		this.failure = reason;
		return this.toStatus();
	}

	private startClockTimer(): void {
		if (!this.startClock || this.timer) return;
		const generation = this.generation;
		this.timer = setInterval(() => generation === this.generation && this.requestRender(), STATUS_RENDER_INTERVAL_MS);
		this.timer.unref?.();
	}

	private stopClockTimer(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	private stopRenderTimer(): void {
		if (this.renderTimer) clearTimeout(this.renderTimer);
		this.renderTimer = null;
		this.renderPendingFull = false;
	}

	private resetLayoutCache(): void {
		this.cachedLayout = null;
	}

	private toStatus(): BottomInputRuntimeStatus {
		return this.failure
			? { enabled: this.beautifiedInputEnabled, installed: this.installed, failure: this.failure }
			: { enabled: this.beautifiedInputEnabled, installed: this.installed };
	}

	private debug(event: Parameters<typeof writeBottomInputDebugLog>[0]["event"], ctx?: any, extra: Omit<Parameters<typeof writeBottomInputDebugLog>[0], "event" | "state" | "ctx" | "currentCtx" | "currentUi"> = {}): void {
		writeBottomInputDebugLog({
			event,
			ctx,
			currentCtx: this.ctx,
			currentUi: this.ui,
			state: {
				enabled: this.beautifiedInputEnabled,
				installed: this.installed,
				layoutInstalled: this.installed,
				generation: this.generation,
				layoutOwnerGeneration: this.layoutOwnerGeneration,
				hasCompositor: false,
				hasEditor: Boolean(this.editorInstance),
				hasFooter: Boolean(this.footerComponent),
				failure: this.failure,
			},
			...extra,
		});
	}
}

function isAssistantOutputDelta(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const event = value as { type?: unknown; delta?: unknown };
	return (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")
		&& typeof event.delta === "string"
		&& event.delta.length > 0;
}

function readCompletedAssistantUsage(value: unknown): AssistantUsage | null {
	if (!value || typeof value !== "object") return null;
	const message = value as { role?: unknown; stopReason?: unknown; usage?: unknown };
	if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") return null;
	return isAssistantUsage(message.usage) ? message.usage : null;
}

function isActiveAlpsFooterComponent(component: any): boolean {
	return Boolean(component?.__alpsBottomInputOwner && component.__alpsBottomInputActive === true);
}

function createStaleEditorFallback() {
	return { render: () => [], handleInput: () => undefined };
}

function createStaleFooterFallback() {
	return { render: () => [], dispose: () => undefined, invalidate: () => undefined };
}

function cloneStatusLayout(layout: StatusLayout): StatusLayout {
	return {
		topLines: [...layout.topLines],
		secondaryLines: [...layout.secondaryLines],
		lastPromptLines: [...layout.lastPromptLines],
		frameStatus: { ...layout.frameStatus },
	};
}

function getCurrentEditorText(ctx: any, editor: any): string {
	try {
		if (typeof editor?.getText === "function") return String(editor.getText() ?? "");
		const ui = readRuntimeUI(ctx);
		return ui.stale ? "" : String(ui.ui?.getEditorText?.() ?? "");
	} catch {
		return "";
	}
}

function setEditorText(ctx: any, editor: any, text: string): void {
	try {
		if (typeof editor?.setText === "function") editor.setText(text);
		else {
			const ui = readRuntimeUI(ctx);
			if (!ui.stale) ui.ui?.setEditorText?.(text);
		}
	} catch {
		// 编辑器 API 失败不得破坏普通输入。
	}
}

function moveEditorToBoundary(editor: any, boundary: "start" | "end"): boolean {
	try {
		if (boundary === "start" && typeof editor?.moveToStart === "function") return editor.moveToStart(), true;
		if (boundary === "end" && typeof editor?.moveToEnd === "function") return editor.moveToEnd(), true;
		if (typeof editor?.handleInput === "function") {
			editor.handleInput(boundary === "start" ? "\x1b[H" : "\x1b[F");
			return true;
		}
	} catch {
		return false;
	}
	return false;
}

export function registerBottomInputShortcuts(pi: ExtensionAPI, runtime: BottomInputRuntime): void {
	pi.registerShortcut?.("alt+s", {
		description: "暂存/恢复当前输入框文本",
		handler: (ctx: any) => runtime.stashOrRestoreEditorText(ctx),
	});
}

function notify(ctx: any, message: string, level: "info" | "warning" | "error"): void {
	try {
		const ui = readRuntimeUI(ctx);
		if (!ui.stale) ui.ui?.notify?.(message, level);
	} catch {
		// stale session UI 不再通知。
	}
}

function hasOverlay(ctx: any, tui?: any): boolean {
	try {
		const ui = readRuntimeUI(ctx);
		if (ui.stale) return false;
		return typeof tui?.hasOverlay === "function" ? Boolean(tui.hasOverlay()) : false;
	} catch {
		return false;
	}
}

function readRuntimeUI(ctx: any): RuntimeUIReadResult {
	try {
		if (!ctx || ctx.mode !== "tui" || ctx.hasUI !== true || !ctx.ui) return { stale: false };
		return { stale: false, ui: ctx.ui as RuntimeUI };
	} catch (error) {
		return isStaleCtxError(error) ? { stale: true } : { stale: false };
	}
}

function isStaleCtxError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("extension ctx is stale") || message.includes("stale ctx");
}

function hasNonWhitespaceText(value: string): boolean {
	return /\S/.test(value);
}

function formatFailure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
