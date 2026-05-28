/** 功能：渲染 bottom-input 主状态栏、extension statuses 与 last prompt 实现者：alps 实现日期：2026-05-28 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeLike } from "../chrome-frame/styles.ts";
import { getBottomInputIcons, type BottomInputIconSet } from "./icons.ts";

export type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens?: number;
	cost?: { total?: number };
};

export type ContextUsage = {
	tokens: number;
	contextWindow?: number;
	percent?: number;
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
	/** 用户是否开启 bottom status 行。 */
	bottomStatusEnabled: boolean;
	/** streaming 标记；为 true 时 liveUsage 优先于旧 core usage。 */
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
	/** 图标集；不传则按环境判断。 */
	icons?: BottomInputIconSet;
};

export type BottomInputStatusRender = {
	topLines: string[];
	secondaryLines: string[];
	lastPromptLines: string[];
	cacheKey: string;
};

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
const INTERNAL_STATUS_KEYS = new Set(["alps-pi-bottom-input", "alps-pi-bottom-status", "alps-pi-last-prompt"]);

/** 渲染所有 bottom status 行；关闭时只返回空行。 */
export function renderBottomInputStatus(input: BottomInputStatusState): BottomInputStatusRender {
	const safeWidth = Math.max(1, Math.floor(input.width));
	const icons = input.icons ?? getBottomInputIcons();
	const extensionStatuses = getVisibleExtensionStatuses(input.footerData);
	const elapsedSeconds = Math.floor(Math.max(0, input.now - input.sessionStartTime) / 1000);
	const usage = readContextUsageSnapshot(input.ctx, input.isStreaming, input.liveUsage, input.latestAssistantUsage);
	const cacheKey = JSON.stringify({
		width: safeWidth,
		bottomStatusEnabled: input.bottomStatusEnabled,
		model: normalizeModelName(input.ctx?.model?.name || input.ctx?.model?.id),
		thinking: readThinkingLevel(input.ctx) ?? input.currentThinkingLevel ?? readThinkingLevelFromSession(input.ctx),
		context: usage,
		elapsedSeconds,
		lastPrompt: input.lastPrompt,
		extensionStatuses,
		icons,
	});

	if (!input.bottomStatusEnabled) {
		return { topLines: [], secondaryLines: [], lastPromptLines: [], cacheKey };
	}

	return {
		topLines: renderTopStatusLines({ ...input, width: safeWidth, icons }),
		secondaryLines: renderExtensionStatusLines(extensionStatuses, safeWidth, input.theme),
		lastPromptLines: renderLastPromptLines(input.lastPrompt, safeWidth, input.theme),
		cacheKey,
	};
}

/** 渲染输入框上方主状态栏。 */
export function renderTopStatusLines(input: BottomInputStatusState & { icons?: BottomInputIconSet }): string[] {
	const safeWidth = Math.max(1, Math.floor(input.width));
	const icons = input.icons ?? getBottomInputIcons();
	const segments = [
		renderModelSegment(input.ctx, input.theme, icons),
		renderThinkingSegment(input.ctx, input.theme, input.currentThinkingLevel),
		renderContextSegment(input.ctx, input.theme, input.isStreaming, input.liveUsage, input.latestAssistantUsage),
		renderElapsedSegment(input.theme, input.sessionStartTime, input.now, icons),
	].filter((segment): segment is string => Boolean(segment));

	if (segments.length === 0) return [];
	return [fitStatusLine(segments, safeWidth, input.theme)];
}

/** 渲染输入框下方 extension statuses 聚合行。 */
export function renderExtensionStatusLines(statuses: readonly string[], width: number, theme: ThemeLike): string[] {
	if (statuses.length === 0) return [];
	const separator = safeFg(theme, "borderMuted", " › ");
	const line = ` ${statuses.join(separator)} `;
	return [truncateToWidth(line, Math.max(1, Math.floor(width)), "…", false)];
}

/** 渲染最后一条用户问题。 */
export function renderLastPromptLines(prompt: string, width: number, theme: ThemeLike): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	if (!prompt) return [];

	const prefix = ` ${safeFg(theme, "borderMuted", "↳")} `;
	const availableWidth = safeWidth - visibleWidth(prefix);
	if (availableWidth < 4) return [];

	const value = truncateToWidth(prompt, availableWidth, "…", false);
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
		const normalized = value.trim();
		if (!normalized) continue;
		if (normalized.trimStart().startsWith("[")) continue;
		if (visibleWidth(stripAnsi(normalized)) <= 0) continue;
		visible.push(normalized);
	}
	return visible;
}

/** 压缩 prompt 到单行。 */
export function normalizePromptText(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function isAssistantUsage(value: unknown): value is AssistantUsage {
	return isRecord(value)
		&& typeof value.input === "number"
		&& typeof value.output === "number"
		&& typeof value.cacheRead === "number"
		&& typeof value.cacheWrite === "number";
}

export function getUsageTokenTotal(usage: AssistantUsage): number {
	return typeof usage.totalTokens === "number" && usage.totalTokens > 0
		? usage.totalTokens
		: usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
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

function renderModelSegment(ctx: any, theme: ThemeLike, icons: BottomInputIconSet): string | null {
	const modelName = normalizeModelName(ctx?.model?.name || ctx?.model?.id);
	if (!modelName) return null;
	const content = icons.model ? `${icons.model} ${modelName}` : modelName;
	return safeFg(theme, "accent", content);
}

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

function renderContextSegment(
	ctx: any,
	theme: ThemeLike,
	isStreaming: boolean,
	liveUsage: AssistantUsage | null,
	latestAssistantUsage: AssistantUsage | null,
): string | null {
	const usage = readContextUsageSnapshot(ctx, isStreaming, liveUsage, latestAssistantUsage);
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

function renderElapsedSegment(theme: ThemeLike, startedAt: number, now: number, icons: BottomInputIconSet): string | null {
	const elapsed = Math.max(0, now - startedAt);
	if (elapsed < 1000) return null;
	const prefix = icons.time ? `${icons.time} ` : "";
	return safeFg(theme, "muted", `${prefix}${formatDuration(elapsed)}`);
}

function fitStatusLine(segments: string[], width: number, theme: ThemeLike): string {
	const separator = safeFg(theme, "borderMuted", " › ");
	const fitted = [...segments];
	while (fitted.length > 1 && visibleWidth(` ${fitted.join(separator)} `) > width) {
		fitted.pop();
	}
	return truncateToWidth(` ${fitted.join(separator)} `, width, "…", false);
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

function stripAnsi(input: string): string {
	return input.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
