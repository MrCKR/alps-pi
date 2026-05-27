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

type UsageStats = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

type BottomStatusRuntimeOptions = {
	/** 默认 true；测试可关闭定时器，避免进程悬挂。 */
	startClock?: boolean;
};

const STATUS_WIDGET_KEY = "alps-pi-bottom-status";
const STASH_STATUS_KEY = "alps-pi-stash";
const STATUS_RENDER_INTERVAL_MS = 60_000;

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
	private ctx: any;
	private enabled = false;
	private widgetInstalled = false;
	private removeInputListener: (() => void) | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private stashedEditorText: string | null = null;
	private liveUsage: AssistantUsage | null = null;
	private currentThinkingLevel: string | null = null;
	private widgetComponent: { invalidate?: () => void } | null = null;

	constructor(options: BottomStatusRuntimeOptions) {
		this.startClock = options.startClock !== false;
	}

	/** 保存最新 ctx；如果状态栏已开启，则立即重装到新 session。 */
	bindSession(ctx: any): void {
		if (this.ctx && this.ctx !== ctx) {
			this.uninstallSessionResources();
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
		this.widgetComponent?.invalidate?.();
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

	/** 安装 aboveEditor widget 与 raw input 监听；缺能力时静默降级为不显示。 */
	private installSessionResources(): void {
		const ctx = this.ctx;
		if (!ctx?.hasUI || !ctx.ui) return;
		this.installWidget(ctx);
		this.installInputListener(ctx);
		this.startClockTimer();
	}

	/** 清理当前 session 的 widget、input listener 和时间刷新器。 */
	private uninstallSessionResources(): void {
		this.removeInputListener?.();
		this.removeInputListener = null;
		this.stopClockTimer();
		if (this.ctx?.ui?.setWidget && this.widgetInstalled) {
			this.ctx.ui.setWidget(STATUS_WIDGET_KEY, undefined);
		}
		if (this.ctx?.ui?.setStatus) {
			this.ctx.ui.setStatus(STASH_STATUS_KEY, undefined);
		}
		this.widgetInstalled = false;
		this.widgetComponent = null;
	}

	/** 状态栏放在 aboveEditor；fixed editor 开启时会被底部 compositor 固定。 */
	private installWidget(ctx: any): void {
		if (typeof ctx.ui?.setWidget !== "function" || this.widgetInstalled) return;
		ctx.ui.setWidget(STATUS_WIDGET_KEY, (_tui: any, theme: ThemeLike) => {
			const component = {
				dispose: () => {
					if (this.widgetComponent === component) {
						this.widgetComponent = null;
					}
				},
				invalidate: () => {
					if (typeof _tui?.requestRender === "function") {
						_tui.requestRender();
					}
				},
				render: (width: number) => this.renderStatusLine(width, theme),
			};
			this.widgetComponent = component;
			return component;
		}, { placement: "aboveEditor" });
		this.widgetInstalled = true;
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

	/** 时间 segment 需要低频刷新；不使用时完全不启动。 */
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

	/** 渲染单行状态；拿不到的数据直接省略，不显示 unknown fallback。 */
	private renderStatusLine(width: number, theme: ThemeLike): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const ctx = this.ctx;
		if (!this.enabled || !ctx) return [];

		const segments = [
			renderModelSegment(ctx, theme),
			renderThinkingSegment(ctx, theme, this.currentThinkingLevel),
			renderTokenTotalSegment(ctx, theme, this.liveUsage),
			renderTimeSegment(theme),
		].filter((segment): segment is string => Boolean(segment));

		if (segments.length === 0) return [];
		return [fitStatusLine(segments, safeWidth, theme)];
	}
}

/** 生成模型 segment；缺 model 时直接不显示。 */
function renderModelSegment(ctx: any, theme: ThemeLike): string | null {
	const modelName = normalizeModelName(ctx?.model?.name || ctx?.model?.id);
	return modelName ? theme.fg("accent", modelName) : null;
}

/** 生成 thinking segment；off 或缺失时不显示，避免无意义占位。 */
function renderThinkingSegment(ctx: any, theme: ThemeLike, cachedLevel: string | null): string | null {
	const level = readThinkingLevel(ctx) ?? cachedLevel;
	if (!level || level === "off") return null;
	const label = normalizeThinkingLevel(level);
	return label ? theme.fg("muted", `think:${label}`) : null;
}

/** 生成总 token segment；与原版 token_total 一致，统计 input/output/cacheRead/cacheWrite。 */
function renderTokenTotalSegment(ctx: any, theme: ThemeLike, liveUsage: AssistantUsage | null): string | null {
	const usage = collectUsageStats(ctx, liveUsage);
	const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return total > 0 ? theme.fg("muted", `⊛ ${formatTokens(total)}`) : null;
}

/** 当前时间 segment。 */
function renderTimeSegment(theme: ThemeLike): string {
	const now = new Date();
	const hours = String(now.getHours()).padStart(2, "0");
	const minutes = String(now.getMinutes()).padStart(2, "0");
	return theme.fg("muted", `◷ ${hours}:${minutes}`);
}

/** 从 session 汇总 usage；streaming 时用 liveUsage 覆盖最新 assistant 的累计值。 */
function collectUsageStats(ctx: any, liveUsage: AssistantUsage | null): UsageStats {
	const stats: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let latestUsage: AssistantUsage | null = null;
	for (const entry of readBranchEntries(ctx)) {
		if (!isRecord(entry) || entry.type !== "message" || !isAssistantMessage(entry.message)) continue;
		const usage = entry.message.usage;
		stats.input += usage.input;
		stats.output += usage.output;
		stats.cacheRead += usage.cacheRead;
		stats.cacheWrite += usage.cacheWrite;
		if (getUsageTokenTotal(usage) > 0) {
			latestUsage = usage;
		}
	}

	if (liveUsage && latestUsage) {
		stats.input += liveUsage.input - latestUsage.input;
		stats.output += liveUsage.output - latestUsage.output;
		stats.cacheRead += liveUsage.cacheRead - latestUsage.cacheRead;
		stats.cacheWrite += liveUsage.cacheWrite - latestUsage.cacheWrite;
	} else if (liveUsage && !latestUsage) {
		stats.input += liveUsage.input;
		stats.output += liveUsage.output;
		stats.cacheRead += liveUsage.cacheRead;
		stats.cacheWrite += liveUsage.cacheWrite;
	}

	return {
		input: Math.max(0, stats.input),
		output: Math.max(0, stats.output),
		cacheRead: Math.max(0, stats.cacheRead),
		cacheWrite: Math.max(0, stats.cacheWrite),
	};
}

/** 拼接状态行；空间不足时从右侧低优先级 segment 开始丢弃。 */
function fitStatusLine(segments: string[], width: number, theme: ThemeLike): string {
	const separator = theme.fg("borderMuted", " › ");
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

function normalizeThinkingLevel(level: string): string {
	const labels: Record<string, string> = {
		minimal: "min",
		low: "low",
		medium: "med",
		high: "high",
		xhigh: "xhigh",
	};
	return labels[level] ?? level;
}

function normalizeModelName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	let modelName = value.trim();
	if (!modelName) return null;
	if (modelName.startsWith("Claude ")) {
		modelName = modelName.slice("Claude ".length);
	}
	return modelName;
}

function hasNonWhitespaceText(value: string): boolean {
	return /\S/.test(value);
}

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
	return `${Math.round(n / 1000000)}M`;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
