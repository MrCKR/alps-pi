/** 功能：提供固定底部状态栏与 Alt+S 输入暂存能力 实现者：alps 实现日期：2026-05-27 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThemeLike } from "../chrome-frame/styles.ts";
import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type BottomStatusRuntime = {
	/** 绑定当前 session，并在 UI 可用时安装底部状态 widget。 */
	bindSession(ctx: any): void;
	/** 更新状态栏开关。 */
	setEnabled(enabled: boolean): void;
	/** 释放 widget、快捷键监听和定时刷新。 */
	dispose(): void;
	/** 当前 UI session 重新开始计时；用于 session_start，而不是历史会话创建时间。 */
	resetSessionStartTime(): void;
	/** 记录最新用户问题，用于输入框下方 last prompt 行。 */
	setLastPrompt(prompt: unknown): void;
	/** 记录最新 thinking level，用于无 getThinkingLevel API 的事件路径。 */
	setThinkingLevel(level: unknown): void;
	/** 记录最新 assistant usage，用于 streaming 期间实时刷新。 */
	setLiveUsage(usage: unknown): void;
	/** 清理 streaming usage，回到 session 汇总。 */
	clearLiveUsage(): void;
	/** 请求状态栏重绘。 */
	requestRender(): void;
	/** 执行 Alt+S 暂存/恢复当前 editor 文本。 */
	stashOrRestoreEditorText(ctx?: any): void;
};

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens?: number;
	cost?: { total?: number };
};

type ContextUsage = {
	tokens: number;
	contextWindow?: number;
	percent?: number;
};

type BottomStatusRuntimeOptions = {
	/** 默认 true；测试可关闭定时器，避免进程悬挂。 */
	startClock?: boolean;
	/** 测试注入点：生产环境使用 Date.now。 */
	now?: () => number;
};

const TOP_STATUS_WIDGET_KEY = "alps-pi-bottom-status";
const LAST_PROMPT_WIDGET_KEY = "alps-pi-last-prompt";
const STASH_STATUS_KEY = "alps-pi-stash";
const STATUS_RENDER_INTERVAL_MS = 1_000;
const CONTEXT_BAR_WIDTH = 6;
const CONTEXT_COLORS = {
	normal: "#00afaf",
	warning: "#febc38",
	error: "#ff5f5f",
	empty: "#444444",
};
const RAINBOW_COLORS = [
	"#b281d6",
	"#d787af",
	"#febc38",
	"#e4c00f",
	"#89d281",
	"#00afaf",
	"#178fb9",
	"#b281d6",
];

/** 创建底部状态栏 runtime。 */
export function createBottomStatusRuntime(options: BottomStatusRuntimeOptions = {}): BottomStatusRuntime {
	return new BottomStatusRuntimeImpl(options);
}

/** 注册 Alt+S 快捷键；raw input 兜底由 runtime 在 session 中安装。 */
export function registerBottomStatusShortcuts(pi: ExtensionAPI, runtime: BottomStatusRuntime): void {
	pi.registerShortcut?.("alt+s", {
		description: "暂存/恢复当前输入框文本",
		handler: (ctx: any) => {
			runtime.stashOrRestoreEditorText(ctx);
		},
	});
}

/** 状态栏运行时：只负责 widget、状态采集和 Alt+S 文本暂存。 */
class BottomStatusRuntimeImpl implements BottomStatusRuntime {
	private readonly startClock: boolean;
	private readonly now: () => number;
	private ctx: any;
	private enabled = false;
	private topWidgetInstalled = false;
	private lastPromptWidgetInstalled = false;
	private removeInputListener: (() => void) | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private stashedEditorText: string | null = null;
	private liveUsage: AssistantUsage | null = null;
	private currentThinkingLevel: string | null = null;
	private lastPrompt = "";
	private sessionStartTime: number;
	private topWidgetComponent: { invalidate?: () => void } | null = null;
	private lastPromptWidgetComponent: { invalidate?: () => void } | null = null;

	constructor(options: BottomStatusRuntimeOptions) {
		this.startClock = options.startClock !== false;
		this.now = options.now ?? (() => Date.now());
		this.sessionStartTime = this.now();
	}

	/** 保存最新 ctx；如果状态栏已开启，则立即重装到新 session。 */
	bindSession(ctx: any): void {
		if (this.ctx && this.ctx !== ctx) {
			this.uninstallSessionResources();
		}
		if (!this.ctx && ctx) {
			this.sessionStartTime = this.now();
		}
		this.ctx = ctx;
		this.currentThinkingLevel = readThinkingLevel(ctx) ?? this.currentThinkingLevel;
		if (this.enabled) {
			this.installSessionResources();
		}
	}

	/** 开关状态栏；关闭时保留暂存文本语义与原版一致，只释放 UI 资源。 */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (enabled) {
			this.installSessionResources();
		} else {
			this.uninstallSessionResources();
		}
	}

	/** 释放所有 session 资源并清空临时状态。 */
	dispose(): void {
		this.uninstallSessionResources();
		this.ctx = undefined;
		this.stashedEditorText = null;
		this.liveUsage = null;
		this.currentThinkingLevel = null;
		this.lastPrompt = "";
		this.sessionStartTime = this.now();
	}

	resetSessionStartTime(): void {
		this.sessionStartTime = this.now();
		this.requestRender();
	}

	setLastPrompt(prompt: unknown): void {
		this.lastPrompt = normalizePromptText(prompt);
		this.requestRender();
	}

	setThinkingLevel(level: unknown): void {
		this.currentThinkingLevel = typeof level === "string" && level ? level : null;
		this.requestRender();
	}

	setLiveUsage(usage: unknown): void {
		this.liveUsage = isAssistantUsage(usage) ? usage : null;
		this.requestRender();
	}

	clearLiveUsage(): void {
		this.liveUsage = null;
		this.requestRender();
	}

	requestRender(): void {
		this.topWidgetComponent?.invalidate?.();
		this.lastPromptWidgetComponent?.invalidate?.();
	}

	/** 对齐原版 Alt+S：有输入则暂存并清空，空输入则恢复暂存。 */
	stashOrRestoreEditorText(ctx: any = this.ctx): void {
		if (!ctx?.hasUI || !ctx.ui) return;
		const rawText = getCurrentEditorText(ctx);
		const hasStash = this.stashedEditorText !== null;

		if (!hasNonWhitespaceText(rawText)) {
			if (!hasStash) {
				notify(ctx, "Nothing to stash", "info");
				return;
			}
			ctx.ui.setEditorText?.(this.stashedEditorText);
			this.stashedEditorText = null;
			ctx.ui.setStatus?.(STASH_STATUS_KEY, undefined);
			notify(ctx, "Stash restored", "info");
			this.requestRender();
			return;
		}

		this.stashedEditorText = rawText;
		ctx.ui.setEditorText?.("");
		ctx.ui.setStatus?.(STASH_STATUS_KEY, "stash");
		notify(ctx, hasStash ? "Stash updated" : "Text stashed", "info");
		this.requestRender();
	}

	/** 安装 aboveEditor/belowEditor widget 与 raw input 监听；缺能力时静默降级为不显示。 */
	private installSessionResources(): void {
		const ctx = this.ctx;
		if (!ctx?.hasUI || !ctx.ui) return;
		this.installTopWidget(ctx);
		this.installLastPromptWidget(ctx);
		this.installInputListener(ctx);
		this.startClockTimer();
	}

	/** 清理当前 session 的 widget、input listener 和时间刷新器。 */
	private uninstallSessionResources(): void {
		this.removeInputListener?.();
		this.removeInputListener = null;
		this.stopClockTimer();
		if (this.ctx?.ui?.setWidget) {
			if (this.topWidgetInstalled) {
				this.ctx.ui.setWidget(TOP_STATUS_WIDGET_KEY, undefined);
			}
			if (this.lastPromptWidgetInstalled) {
				this.ctx.ui.setWidget(LAST_PROMPT_WIDGET_KEY, undefined);
			}
		}
		if (this.ctx?.ui?.setStatus) {
			this.ctx.ui.setStatus(STASH_STATUS_KEY, undefined);
		}
		this.topWidgetInstalled = false;
		this.lastPromptWidgetInstalled = false;
		this.topWidgetComponent = null;
		this.lastPromptWidgetComponent = null;
	}

	/** 主状态栏放在 aboveEditor；fixed editor 开启时会被底部 compositor 固定。 */
	private installTopWidget(ctx: any): void {
		if (typeof ctx.ui?.setWidget !== "function" || this.topWidgetInstalled) return;
		ctx.ui.setWidget(TOP_STATUS_WIDGET_KEY, (_tui: any, theme: ThemeLike) => {
			const component = {
				dispose: () => {
					if (this.topWidgetComponent === component) {
						this.topWidgetComponent = null;
					}
				},
				invalidate: () => {
					if (typeof _tui?.requestRender === "function") {
						_tui.requestRender();
					}
				},
				render: (width: number) => this.renderStatusLine(width, theme),
			};
			this.topWidgetComponent = component;
			return component;
		}, { placement: "aboveEditor" });
		this.topWidgetInstalled = true;
	}

	/** last prompt 放在 belowEditor，避免挤占主状态栏和输入框本体。 */
	private installLastPromptWidget(ctx: any): void {
		if (typeof ctx.ui?.setWidget !== "function" || this.lastPromptWidgetInstalled) return;
		ctx.ui.setWidget(LAST_PROMPT_WIDGET_KEY, (_tui: any, theme: ThemeLike) => {
			const component = {
				dispose: () => {
					if (this.lastPromptWidgetComponent === component) {
						this.lastPromptWidgetComponent = null;
					}
				},
				invalidate: () => {
					if (typeof _tui?.requestRender === "function") {
						_tui.requestRender();
					}
				},
				render: (width: number) => this.renderLastPromptLine(width, theme),
			};
			this.lastPromptWidgetComponent = component;
			return component;
		}, { placement: "belowEditor" });
		this.lastPromptWidgetInstalled = true;
	}

	/** raw input 兜底处理 Alt+S；overlay 打开时不消费输入。 */
	private installInputListener(ctx: any): void {
		if (this.removeInputListener || typeof ctx.ui?.onTerminalInput !== "function") return;
		this.removeInputListener = ctx.ui.onTerminalInput((data: string) => {
			if (!this.enabled || hasOverlay(ctx) || !isStashShortcutInput(data)) {
				return undefined;
			}
			this.stashOrRestoreEditorText(ctx);
			return { consume: true };
		});
	}

	/** elapsed 时间以秒为最小单位，因此状态栏开启时每秒低成本刷新一次。 */
	private startClockTimer(): void {
		if (!this.startClock || this.timer) return;
		this.timer = setInterval(() => this.requestRender(), STATUS_RENDER_INTERVAL_MS);
		this.timer.unref?.();
	}

	private stopClockTimer(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	/** 渲染输入框上方主状态栏；拿不到的数据直接省略，不显示 unknown fallback。 */
	private renderStatusLine(width: number, theme: ThemeLike): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const ctx = this.ctx;
		if (!this.enabled || !ctx) return [];

		const segments = [
			renderModelSegment(ctx, theme),
			renderThinkingSegment(ctx, theme, this.currentThinkingLevel),
			renderContextSegment(ctx, theme, this.liveUsage),
			renderElapsedSegment(theme, this.sessionStartTime, this.now()),
		].filter((segment): segment is string => Boolean(segment));

		if (segments.length === 0) return [];
		return [fitStatusLine(segments, safeWidth, theme)];
	}

	/** 渲染输入框下方 last prompt；只保留一行并按宽度截断。 */
	private renderLastPromptLine(width: number, theme: ThemeLike): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		if (!this.enabled || !this.lastPrompt) return [];

		const prefix = ` ${safeFg(theme, "borderMuted", "↳")} `;
		const availableWidth = safeWidth - visibleWidth(prefix);
		if (availableWidth < 4) return [];

		const prompt = truncateToWidth(this.lastPrompt, availableWidth, "…", false);
		const line = `${prefix}${safeFg(theme, "muted", prompt)}`;
		return [truncateToWidth(line, safeWidth, "…", false)];
	}
}

/** 生成模型 segment；缺 model 时直接不显示。 */
function renderModelSegment(ctx: any, theme: ThemeLike): string | null {
	const modelName = normalizeModelName(ctx?.model?.name || ctx?.model?.id);
	return modelName ? safeFg(theme, "accent", modelName) : null;
}

/** 生成 thinking segment；high/xhigh 使用原版 rainbow，其余等级使用对应语义色。 */
function renderThinkingSegment(ctx: any, theme: ThemeLike, cachedLevel: string | null): string | null {
	const level = readThinkingLevel(ctx) ?? cachedLevel ?? readThinkingLevelFromSession(ctx);
	if (!level) return null;
	const label = normalizeThinkingLevel(level);
	if (!label) return null;
	const content = `think:${label}`;
	if (level === "high" || level === "xhigh") {
		return rainbow(content);
	}
	return safeFg(theme, thinkingColorToken(level), content);
}

/** 生成 context segment：有窗口显示进度条；无窗口只显示已用量。 */
function renderContextSegment(ctx: any, theme: ThemeLike, liveUsage: AssistantUsage | null): string | null {
	const usage = readContextUsageSnapshot(ctx, liveUsage);
	if (!usage || usage.tokens <= 0) return null;

	if (usage.contextWindow && usage.contextWindow > 0) {
		const percent = typeof usage.percent === "number" && Number.isFinite(usage.percent)
			? usage.percent
			: (usage.tokens / usage.contextWindow) * 100;
		const color = contextColor(percent);
		const prefix = applyHexColor(color, "ctx");
		const value = applyHexColor(color, `${percent.toFixed(1)}%/${formatTokens(usage.contextWindow)}`);
		return `${prefix} ${renderContextBar(percent, color)} ${value}`;
	}

	return applyHexColor(CONTEXT_COLORS.normal, `ctx ${formatTokens(usage.tokens)}`);
}

/** 生成当前 UI session 的 elapsed 时间；不足 1 秒时隐藏。 */
function renderElapsedSegment(theme: ThemeLike, startedAt: number, now: number): string | null {
	const elapsed = Math.max(0, now - startedAt);
	if (elapsed < 1000) return null;
	return safeFg(theme, "muted", `◷ ${formatDuration(elapsed)}`);
}

/** 拼接状态行；空间不足时从右侧低优先级 segment 开始丢弃。 */
function fitStatusLine(segments: string[], width: number, theme: ThemeLike): string {
	const separator = safeFg(theme, "borderMuted", " › ");
	const fitted = [...segments];
	while (fitted.length > 1 && visibleWidth(` ${fitted.join(separator)} `) > width) {
		fitted.pop();
	}
	return truncateToWidth(` ${fitted.join(separator)} `, width, "…", false);
}

/** 判断 Alt+S 的多种终端编码，与原版保持一致。 */
export function isStashShortcutInput(data: string): boolean {
	if (isKeyRelease(data)) return false;
	return data === "ß"
		|| data === "\x1bs"
		|| data === "\x1bS"
		|| /^\x1b\[(?:83|115)(?::\d*)?(?::\d*)?;3(?::\d+)?u$/.test(data)
		|| data === "\x1b[27;3;115~"
		|| data === "\x1b[27;3;83~"
		|| matchesKey(data, "alt+s");
}

function getCurrentEditorText(ctx: any): string {
	try {
		const text = ctx?.ui?.getEditorText?.();
		return typeof text === "string" ? text : "";
	} catch {
		return "";
	}
}

function notify(ctx: any, message: string, level: "info" | "warning" | "error"): void {
	ctx?.ui?.notify?.(message, level);
}

function hasOverlay(ctx: any): boolean {
	const tui = ctx?.ui?.tui ?? ctx?.tui;
	if (typeof tui?.hasOverlay === "function") return Boolean(tui.hasOverlay());
	const overlayStack = Array.isArray(tui?.overlayStack) ? tui.overlayStack : [];
	return overlayStack.some((entry: any) => entry?.visible !== false && entry?.hidden !== true);
}

function readBranchEntries(ctx: any): any[] {
	try {
		const entries = ctx?.sessionManager?.getBranch?.();
		return Array.isArray(entries) ? entries : [];
	} catch {
		return [];
	}
}

function isAssistantMessage(value: unknown): value is { role: "assistant"; usage: AssistantUsage; stopReason?: string } {
	return isRecord(value)
		&& value.role === "assistant"
		&& isAssistantUsage(value.usage)
		&& value.stopReason !== "error"
		&& value.stopReason !== "aborted";
}

function isAssistantUsage(value: unknown): value is AssistantUsage {
	return isRecord(value)
		&& typeof value.input === "number"
		&& typeof value.output === "number"
		&& typeof value.cacheRead === "number"
		&& typeof value.cacheWrite === "number";
}

function getUsageTokenTotal(usage: AssistantUsage): number {
	return typeof usage.totalTokens === "number" && usage.totalTokens > 0
		? usage.totalTokens
		: usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function readThinkingLevel(ctx: any): string | null {
	try {
		const level = ctx?.getThinkingLevel?.();
		return typeof level === "string" && level ? level : null;
	} catch {
		return null;
	}
}

function readThinkingLevelFromSession(ctx: any): string | null {
	let latest: string | null = null;
	for (const entry of readBranchEntries(ctx)) {
		if (isRecord(entry) && entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string" && entry.thinkingLevel) {
			latest = entry.thinkingLevel;
		}
	}
	return latest;
}

function normalizeThinkingLevel(level: string): string {
	const labels: Record<string, string> = {
		off: "off",
		minimal: "min",
		low: "low",
		medium: "med",
		high: "high",
		xhigh: "xhigh",
	};
	return labels[level] ?? level;
}

function thinkingColorToken(level: string): string {
	const tokens: Record<string, string> = {
		off: "thinking",
		minimal: "thinkingMinimal",
		low: "thinkingLow",
		medium: "thinkingMedium",
	};
	return tokens[level] ?? "thinking";
}

function normalizeModelName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	let modelName = value.trim();
	if (!modelName) return null;
	if (modelName.includes("/")) {
		modelName = modelName.split("/").filter(Boolean).at(-1) ?? modelName;
	}
	if (modelName.includes(":")) {
		modelName = modelName.split(":").filter(Boolean).at(-1) ?? modelName;
	}
	if (modelName.startsWith("Claude ")) {
		modelName = modelName.slice("Claude ".length);
	}
	return modelName.trim() || null;
}

function hasNonWhitespaceText(value: string): boolean {
	return /\S/.test(value);
}

function normalizePromptText(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function readContextUsageSnapshot(ctx: any, liveUsage: AssistantUsage | null): ContextUsage | null {
	const coreUsage = readCoreContextUsage(ctx);
	const latestUsage = liveUsage ?? readLatestAssistantUsage(ctx);
	const tokens = coreUsage?.tokens ?? (latestUsage ? getUsageTokenTotal(latestUsage) : 0);
	const contextWindow = coreUsage?.contextWindow ?? readModelContextWindow(ctx);
	const percent = coreUsage?.percent ?? (contextWindow > 0 ? (tokens / contextWindow) * 100 : undefined);

	if (!Number.isFinite(tokens) || tokens <= 0) return null;
	return {
		tokens,
		contextWindow: contextWindow > 0 ? contextWindow : undefined,
		percent: typeof percent === "number" && Number.isFinite(percent) ? percent : undefined,
	};
}

function readCoreContextUsage(ctx: any): ContextUsage | null {
	try {
		if (typeof ctx?.getContextUsage !== "function") return null;
		const usage = ctx.getContextUsage();
		if (!isRecord(usage)) return null;
		const tokens = usage.tokens;
		if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return null;
		const contextWindow = usage.contextWindow;
		const percent = usage.percent;
		return {
			tokens,
			contextWindow: typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined,
			percent: typeof percent === "number" && Number.isFinite(percent) ? percent : undefined,
		};
	} catch {
		return null;
	}
}

function readLatestAssistantUsage(ctx: any): AssistantUsage | null {
	let latestUsage: AssistantUsage | null = null;
	for (const entry of readBranchEntries(ctx)) {
		if (!isRecord(entry) || entry.type !== "message" || !isAssistantMessage(entry.message)) continue;
		if (getUsageTokenTotal(entry.message.usage) > 0) {
			latestUsage = entry.message.usage;
		}
	}
	return latestUsage;
}

function readModelContextWindow(ctx: any): number {
	const contextWindow = ctx?.model?.contextWindow;
	return typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0;
}

function renderContextBar(percent: number, color: string): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filledCells = Math.floor((clamped / 100) * CONTEXT_BAR_WIDTH);
	const hasPartial = clamped > 0 && filledCells < CONTEXT_BAR_WIDTH;
	const filled = "━".repeat(filledCells);
	const partial = hasPartial ? "╸" : "";
	const empty = "─".repeat(Math.max(0, CONTEXT_BAR_WIDTH - filledCells - (hasPartial ? 1 : 0)));
	return `${applyHexColor(color, `${filled}${partial}`)}${applyHexColor(CONTEXT_COLORS.empty, empty)}`;
}

function contextColor(percent: number): string {
	if (percent > 90) return CONTEXT_COLORS.error;
	if (percent > 70) return CONTEXT_COLORS.warning;
	return CONTEXT_COLORS.normal;
}

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
	return `${Math.round(n / 1000000)}M`;
}

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	if (hours > 0) return `${hours}h${minutes % 60}m`;
	if (minutes > 0) return `${minutes}m${seconds % 60}s`;
	return `${seconds}s`;
}

function safeFg(theme: ThemeLike, token: string, text: string, fallback = "text"): string {
	try {
		return theme.fg(token, text);
	} catch {
		try {
			return theme.fg(fallback, text);
		} catch {
			return text;
		}
	}
}

function rainbow(text: string): string {
	let result = "";
	let colorIndex = 0;
	for (const char of text) {
		if (char === " " || char === ":") {
			result += char;
			continue;
		}
		result += `${hexToAnsi(RAINBOW_COLORS[colorIndex % RAINBOW_COLORS.length]!)}${char}`;
		colorIndex += 1;
	}
	return `${result}\x1b[0m`;
}

function applyHexColor(hex: string, text: string): string {
	return `${hexToAnsi(hex)}${text}\x1b[0m`;
}

function hexToAnsi(hex: string): string {
	const value = hex.replace("#", "");
	const red = Number.parseInt(value.slice(0, 2), 16);
	const green = Number.parseInt(value.slice(2, 4), 16);
	const blue = Number.parseInt(value.slice(4, 6), 16);
	return `\x1b[38;2;${red};${green};${blue}m`;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
