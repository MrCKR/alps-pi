/** 功能：渲染 bottom-input 边框状态、extension statuses 与 last prompt 实现者：alps 实现日期：2026-05-28 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalSingleLineText, sanitizeTerminalText } from "../../terminal-sanitizer.ts";
import type { ThemeLike } from "../chrome-frame/styles.ts";
import { getBottomInputIcons, type BottomInputIconSet } from "./icons.ts";
import { getUsageTokenTotal, isAssistantUsage, type AssistantUsage } from "../model-usage.ts";
import { normalizeInputMetricsSettings, type InputMetricsSettings } from "./metrics.ts";

export { getUsageTokenTotal, isAssistantUsage, type AssistantUsage } from "../model-usage.ts";

export type ContextUsage = {
	tokens: number;
	contextWindow?: number;
	percent?: number;
};

type SessionUsageSnapshot = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	latestCacheHitRate: number | null;
};

export type BottomInputStatusState = {
	/** 当前 interactive ctx，用于读取 model/thinking/context。 */
	ctx: any;
	/** 当前 footerData；用于 extension statuses 聚合。 */
	footerData?: any;
	/** 当前 theme。 */
	theme: ThemeLike;
	/** 渲染宽度。 */
	width: number;
	/** 美化输入框是否开启。 */
	beautifiedInputEnabled: boolean;
	/** streaming 标记；为 true 时 liveUsage 优先于 core context usage。 */
	isStreaming: boolean;
	/** message_update 捕获到的 usage。 */
	liveUsage: AssistantUsage | null;
	/** 最近一次 assistant usage，用于无 core context 时估算。 */
	latestAssistantUsage: AssistantUsage | null;
	/** thinking level 事件缓存。 */
	currentThinkingLevel: string | null;
	/** session 绑定时间戳。 */
	sessionStartTime: number;
	/** 当前时间戳。 */
	now: number;
	/** before_agent_start 捕获到的上一条 prompt。 */
	lastPrompt: string;
	/** 最近一次有效 assistant 响应的平均输出速度。 */
	tokensPerSecond?: number | null;
	/** 输入框边框指标显示偏好；不传时五项全部显示。 */
	inputMetrics?: Partial<InputMetricsSettings>;
	/** 图标集；不传则按环境判断。 */
	icons?: BottomInputIconSet;
};

export type BottomInputFrameStatus = {
	model: string | null;
	thinking: string | null;
	context: string | null;
	elapsed: string | null;
	sessionUsage?: SessionUsageSnapshot | null;
	tokensPerSecond?: number | null;
	inputMetrics?: InputMetricsSettings;
	icons?: BottomInputIconSet;
};

export type BottomInputStatusRender = {
	/** 输入框上方状态行；当前由线框内嵌状态承载，保持为空。 */
	topLines: string[];
	secondaryLines: string[];
	lastPromptLines: string[];
	/** 线框边框内嵌状态。 */
	frameStatus: BottomInputFrameStatus;
	cacheKey: string;
};

export const CONTEXT_BAR_WIDTH = 10;
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
const MAX_NEON_COLORS = ["#f06ecf", "#cf83ed", "#a993ff"];
const ALPS_THINKING_LABEL_COLORS: Readonly<Record<string, string>> = {
	off: "#ffffff",
	minimal: "#6a6f96",
	low: "#6796e6",
	medium: "#ff7edb",
};
const INTERNAL_STATUS_KEYS = new Set(["alps-pi-bottom-input", "alps-pi-bottom-status", "alps-pi-last-prompt"]);

/** 渲染输入框附属状态；美化关闭时不读取 model/thinking/context/elapsed，只保留下方附属信息。 */
export function renderBottomInputStatus(input: BottomInputStatusState): BottomInputStatusRender {
	const safeWidth = Math.max(1, Math.floor(input.width));
	const enabled = input.beautifiedInputEnabled;
	const extensionStatuses = getVisibleExtensionStatuses(input.footerData);
	if (!enabled) {
		return {
			topLines: [],
			secondaryLines: renderExtensionStatusLines(extensionStatuses, safeWidth, input.theme),
			lastPromptLines: renderLastPromptLines(input.lastPrompt, safeWidth, input.theme),
			frameStatus: emptyFrameStatus(),
			cacheKey: JSON.stringify({ width: safeWidth, enabled: false, lastPrompt: input.lastPrompt, extensionStatuses }),
		};
	}

	const icons = input.icons ?? getBottomInputIcons();
	const inputMetrics = normalizeInputMetricsSettings(input.inputMetrics);
	const elapsedSeconds = Math.floor(Math.max(0, input.now - input.sessionStartTime) / 1000);
	const usage = readContextUsageSnapshot(input.ctx, input.isStreaming, input.liveUsage, input.latestAssistantUsage);
	const sessionUsage = readSessionUsageSnapshot(input.ctx);
	const modelName = readModelName(input.ctx);
	const thinking = readThinkingLevel(input.ctx) ?? input.currentThinkingLevel ?? readThinkingLevelFromSession(input.ctx);
	const cacheKey = JSON.stringify({
		width: safeWidth,
		beautifiedInputEnabled: enabled,
		model: modelName,
		thinking,
		context: usage,
		sessionUsage,
		tokensPerSecond: input.tokensPerSecond,
		inputMetrics,
		elapsedSeconds,
		lastPrompt: input.lastPrompt,
		extensionStatuses,
		icons,
	});

	return {
		topLines: [],
		secondaryLines: renderExtensionStatusLines(extensionStatuses, safeWidth, input.theme),
		lastPromptLines: renderLastPromptLines(input.lastPrompt, safeWidth, input.theme),
		frameStatus: renderFrameStatus({ ...input, width: safeWidth, icons }, modelName, thinking, usage, sessionUsage),
		cacheKey,
	};
}

/** 渲染输入框边框要嵌入的 model/thinking/context/elapsed。 */
export function renderFrameStatus(input: BottomInputStatusState & { icons?: BottomInputIconSet }, modelName = readModelName(input.ctx), thinkingLevel = readThinkingLevel(input.ctx) ?? input.currentThinkingLevel ?? readThinkingLevelFromSession(input.ctx), usage = readContextUsageSnapshot(input.ctx, input.isStreaming, input.liveUsage, input.latestAssistantUsage), sessionUsage = readSessionUsageSnapshot(input.ctx)): BottomInputFrameStatus {
	const icons = input.icons ?? getBottomInputIcons();
	return {
		model: renderModelSegment(modelName, input.theme, icons),
		thinking: renderThinkingSegment(thinkingLevel, input.theme),
		context: renderContextSegment(usage, icons),
		elapsed: renderElapsedSegment(input.theme, input.sessionStartTime, input.now, icons),
		sessionUsage,
		tokensPerSecond: input.tokensPerSecond ?? null,
		inputMetrics: normalizeInputMetricsSettings(input.inputMetrics),
		icons,
	};
}

/** 渲染输入框下方 extension statuses 聚合行。 */
export function renderExtensionStatusLines(statuses: readonly string[], width: number, theme: ThemeLike): string[] {
	const safeStatuses = statuses.map((status) => sanitizeTerminalSingleLineText(status, { preserveSgr: false })).filter(Boolean);
	if (safeStatuses.length === 0) return [];
	const separator = safeFg(theme, "borderMuted", " › ");
	const line = ` ${safeStatuses.join(separator)} `;
	return [truncateToWidth(line, Math.max(1, Math.floor(width)), "…", false)];
}

/** 渲染最后一条用户问题；prompt 先经过终端显示净化，避免控制序列污染固定区域。 */
export function renderLastPromptLines(prompt: string, width: number, theme: ThemeLike): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const safePrompt = sanitizeTerminalSingleLineText(prompt, { preserveSgr: false });
	if (!safePrompt) return [];

	const prefix = ` ${safeFg(theme, "borderMuted", "↳")} `;
	const availableWidth = safeWidth - visibleWidth(prefix);
	if (availableWidth < 4) return [];

	const value = truncateToWidth(safePrompt, availableWidth, "…", false);
	return [truncateToWidth(`${prefix}${safeFg(theme, "muted", value)}`, safeWidth, "…", false)];
}

/** 从 footerData.getExtensionStatuses() 读取并过滤可展示状态。 */
export function getVisibleExtensionStatuses(footerData: any): string[] {
	let statuses: unknown;
	try {
		statuses = footerData?.getExtensionStatuses?.();
	} catch {
		return [];
	}
	const entries: Array<[unknown, unknown]> = statuses instanceof Map
		? [...statuses.entries()]
		: isRecord(statuses)
			? Object.entries(statuses)
			: [];
	const visible: string[] = [];
	for (const [key, value] of entries) {
		if (typeof key === "string" && INTERNAL_STATUS_KEYS.has(key)) continue;
		if (typeof value !== "string") continue;
		const normalized = sanitizeTerminalSingleLineText(value, { preserveSgr: false });
		if (!normalized) continue;
		if (normalized.trimStart().startsWith("[")) continue;
		if (visibleWidth(stripAnsi(normalized)) <= 0) continue;
		visible.push(normalized);
	}
	return visible;
}

/** 压缩 prompt 到单行，并在进入 footer/fixed 展示链路前剥离危险终端控制序列。 */
export function normalizePromptText(value: unknown): string {
	return sanitizeTerminalSingleLineText(value, { preserveSgr: false });
}

export function readContextUsageSnapshot(
	ctx: any,
	isStreaming: boolean,
	liveUsage: AssistantUsage | null,
	latestAssistantUsage: AssistantUsage | null,
): ContextUsage | null {
	const coreUsage = isStreaming && liveUsage ? null : readCoreContextUsage(ctx);
	const assistantUsage = liveUsage ?? latestAssistantUsage ?? readLatestAssistantUsage(ctx);
	const tokens = coreUsage?.tokens ?? (assistantUsage ? getUsageTokenTotal(assistantUsage) : 0);
	const contextWindow = coreUsage?.contextWindow ?? readModelContextWindow(ctx);
	const percent = coreUsage?.percent ?? (contextWindow > 0 ? (tokens / contextWindow) * 100 : undefined);

	if (!Number.isFinite(tokens) || tokens <= 0) return null;
	return {
		tokens,
		contextWindow: contextWindow > 0 ? contextWindow : undefined,
		percent: typeof percent === "number" && Number.isFinite(percent) ? percent : undefined,
	};
}

function emptyFrameStatus(): BottomInputFrameStatus {
	return { model: null, thinking: null, context: null, elapsed: null, sessionUsage: null, tokensPerSecond: null };
}

function renderModelSegment(modelName: string | null, theme: ThemeLike, _icons: BottomInputIconSet): string | null {
	if (!modelName) return null;
	// 线框规格固定只显示模型名，避免 Nerd Font 图标破坏 “model · thinking” 布局。
	return safeFg(theme, "accent", modelName);
}

function renderThinkingSegment(level: string | null, theme: ThemeLike): string | null {
	if (!level) return null;
	const label = normalizeThinkingLevel(level);
	if (!label) return null;
	// max 使用更高亮的独立霓虹序列；high/xhigh 保留既有 rainbow 配色。
	if (level === "max") return rainbow(label, MAX_NEON_COLORS);
	if (level === "high" || level === "xhigh") return rainbow(label);
	const alpsColor = theme.name === "alps" ? ALPS_THINKING_LABEL_COLORS[level] : undefined;
	return alpsColor ? applyHexColor(alpsColor, label) : safeFg(theme, thinkingColorToken(level), label);
}

function renderContextSegment(usage: ContextUsage | null, icons: BottomInputIconSet): string | null {
	if (!usage || usage.tokens <= 0) return null;

	if (usage.contextWindow && usage.contextWindow > 0) {
		const percent = typeof usage.percent === "number" && Number.isFinite(usage.percent)
			? usage.percent
			: (usage.tokens / usage.contextWindow) * 100;
		const color = contextColor(percent);
		const icon = applyHexColor(color, icons.context);
		const value = applyHexColor(color, `${percent.toFixed(1)}%/${formatTokens(usage.contextWindow)}`);
		return `${icon}${renderContextBar(percent, color)} ${value}`;
	}

	return applyHexColor(CONTEXT_COLORS.normal, `${icons.context}${formatTokens(usage.tokens)}`);
}

function renderElapsedSegment(theme: ThemeLike, startedAt: number, now: number, icons: BottomInputIconSet): string | null {
	const elapsed = Math.max(0, now - startedAt);
	if (elapsed < 1000) return null;
	return safeFg(theme, "muted", `${icons.time}${formatDuration(elapsed)}`);
}

function normalizeModelName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	let modelName = value.trim();
	if (!modelName) return null;
	if (modelName.includes("/")) modelName = modelName.split("/").filter(Boolean).at(-1) ?? modelName;
	if (modelName.includes(":")) modelName = modelName.split(":").filter(Boolean).at(-1) ?? modelName;
	if (modelName.startsWith("Claude ")) modelName = modelName.slice("Claude ".length);
	return modelName.trim() || null;
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
		max: "max",
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

function readSessionUsageSnapshot(ctx: any): SessionUsageSnapshot | null {
	const totals: SessionUsageSnapshot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, latestCacheHitRate: null };
	for (const entry of readSessionEntries(ctx)) {
		if (!isRecord(entry)) continue;
		let usage: AssistantUsage | null = null;
		if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant" && isAssistantUsage(entry.message.usage)) {
			usage = entry.message.usage;
			const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			totals.latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : null;
		} else if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "toolResult" && isAssistantUsage(entry.message.usage)) {
			usage = entry.message.usage;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && isAssistantUsage(entry.usage)) {
			usage = entry.usage;
		}
		if (!usage) continue;
		totals.input += usage.input;
		totals.output += usage.output;
		totals.cacheRead += usage.cacheRead;
		totals.cacheWrite += usage.cacheWrite;
	}

	return totals.input > 0 || totals.output > 0 || totals.cacheRead > 0 || totals.cacheWrite > 0 ? totals : null;
}

function readSessionEntries(ctx: any): any[] {
	try {
		const entries = ctx?.sessionManager?.getEntries?.();
		return Array.isArray(entries) ? entries : [];
	} catch {
		return [];
	}
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
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		if (entry.message.role !== "assistant" || !isAssistantUsage(entry.message.usage)) continue;
		if (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") continue;
		if (getUsageTokenTotal(entry.message.usage) > 0) latestUsage = entry.message.usage;
	}
	return latestUsage;
}

function readBranchEntries(ctx: any): any[] {
	try {
		const entries = ctx?.sessionManager?.getBranch?.();
		return Array.isArray(entries) ? entries : [];
	} catch {
		return [];
	}
}

function readModelContextWindow(ctx: any): number {
	try {
		const contextWindow = ctx?.model?.contextWindow;
		return typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0;
	} catch {
		return 0;
	}
}

function readModelName(ctx: any): string | null {
	try {
		return normalizeModelName(ctx?.model?.name || ctx?.model?.id);
	} catch {
		return null;
	}
}

export function renderContextBar(percent: number, color = CONTEXT_COLORS.normal): string {
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

export function formatTokens(n: number): string {
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

/** 按指定霓虹色板逐字符着色；默认沿用 high/xhigh 的原版 rainbow。 */
function rainbow(text: string, colors: readonly string[] = RAINBOW_COLORS): string {
	let result = "";
	let colorIndex = 0;
	for (const char of text) {
		if (char === " " || char === ":") {
			result += char;
			continue;
		}
		result += `${hexToAnsi(colors[colorIndex % colors.length]!)}${char}`;
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

function stripAnsi(input: string): string {
	return sanitizeTerminalText(input, { allowNewline: false, allowTab: false, preserveSgr: false });
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
