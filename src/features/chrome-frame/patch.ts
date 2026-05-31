/** 功能：实现可回滚、幂等的 pi TUI component monkey patch 生命周期 实现者：alps 实现日期：2026-05-26 */

import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { isEmptyMessageChrome, renderCompactThinkingBox, renderNeonBox } from "./chrome.ts";
import { isChromeFrameDebugEnabled, summarizeChromeFrameCacheKey, writeChromeFrameDebugLog, type ChromeFrameDebugBranch } from "./debug.ts";
import { containsImageLine, isImageEscapeLine } from "./image.ts";
import { cloneDefaultSettings, type AlpsPiSettings } from "../../settings.ts";
import { sanitizeTerminalText } from "../../terminal-sanitizer.ts";
import { DEFAULT_CONFIG, getChromeStyle, type ChromeConfig, type ChromeKind, type ChromeStatus, type ThemeLike } from "./styles.ts";

export const PATCH_KEY = Symbol.for("alps.pi.patch.v1");

export type PatchState = {
	enabled: boolean;
	originals: Map<string, Function>;
	patched: Set<string>;
	failures: Map<string, string>;
	conflicts: Set<string>;
	config: ChromeConfig;
	configVersion: number;
};

export type ComponentTarget = {
	id: string;
	kind: ChromeKind;
	ctor: any;
	core?: boolean;
	getTheme: (instance?: any) => ThemeLike;
	forceImageFallback?: boolean;
};

export type SafeBoxRenderOptions = {
	getTheme: () => ThemeLike;
	getFallback: () => string[];
	forceImageFallback?: boolean;
	toolName?: string;
	status?: ChromeStatus;
	config?: ChromeConfig;
};

type RenderCacheEntry = {
	width: number;
	innerKey: string;
	styleKey: string;
	elapsedText?: string;
	lines: string[];
};

// 缓存键随边界空行裁剪语义升级，避免热加载复用旧 padding 行线框。
const RENDER_CACHE_KEY = Symbol.for("alps.pi.renderCache.v4");
const TIMING_STATE_KEY = Symbol.for("alps.pi.timingState.v1");
const TRACKED_SETTINGS_KEY = Symbol.for("alps.pi.trackedSettings.v1");
const WRAPPED_RENDER_KEY = Symbol.for("alps.pi.wrappedRender.v2");
const WRAPPED_RENDER_VERSION = 5;
const CACHE_KEY_SEPARATOR = "\x1f";

type WrappedRenderMetadata = {
	id: string;
	version: number;
	originalRender: Function;
	owner: symbol;
};

type TimingState = {
	sequence: number;
	generation: number;
	lastSignature: string;
	lastUpdatedAt: number;
};

const CHROME_PATCH_OWNER = Symbol.for("alps.pi.chromeFrame.patchOwner.v1");
const timingRegistry = new Map<number, TimingState>();
let nextTimingSequence = 1;
let timingGeneration = 1;

function getWrappedRenderMetadata(render: unknown): WrappedRenderMetadata | undefined {
	return typeof render === "function" ? (render as any)[WRAPPED_RENDER_KEY] as WrappedRenderMetadata | undefined : undefined;
}

function markWrappedRender(render: Function, metadata: WrappedRenderMetadata): void {
	Object.defineProperty(render, WRAPPED_RENDER_KEY, {
		value: metadata,
		configurable: false,
	});
}

function isCurrentWrappedRender(id: string, render: unknown): boolean {
	const metadata = getWrappedRenderMetadata(render);
	return metadata?.id === id && metadata.version === WRAPPED_RENDER_VERSION && metadata.owner === CHROME_PATCH_OWNER;
}

function resetTimingRegistry(): void {
	timingRegistry.clear();
	nextTimingSequence = 1;
	timingGeneration += 1;
}

function initializeTimingState(timing?: TimingState): TimingState {
	const next = timing ?? {
		sequence: 0,
		generation: timingGeneration,
		lastSignature: "",
		lastUpdatedAt: 0,
	};
	next.sequence = nextTimingSequence++;
	next.generation = timingGeneration;
	next.lastSignature = "";
	next.lastUpdatedAt = 0;
	timingRegistry.set(next.sequence, next);
	return next;
}

function getTimingState(instance: any): TimingState {
	let timing = instance?.[TIMING_STATE_KEY] as TimingState | undefined;
	if (timing?.generation === timingGeneration) return timing;
	if (timing) return initializeTimingState(timing);
	timing = initializeTimingState();
	Object.defineProperty(instance, TIMING_STATE_KEY, {
		value: timing,
		configurable: false,
	});
	return timing;
}

/** 内容或状态发生变化时刷新该实例更新时间；重复渲染不会让间隔抖动。 */
function updateTimingState(instance: any, signature: string): TimingState {
	const timing = getTimingState(instance);
	if (timing.lastSignature !== signature) {
		timing.lastSignature = signature;
		timing.lastUpdatedAt = Date.now();
	}
	return timing;
}

function formatElapsedSincePrevious(timing: TimingState): string | undefined {
	const previous = timingRegistry.get(timing.sequence - 1);
	if (!previous) return undefined;
	return formatElapsedDuration(timing.lastUpdatedAt - previous.lastUpdatedAt);
}

/** 将消息间隔格式化为秒级文本；不足 1s 也显示为 1s。 */
export function formatElapsedDuration(ms: number): string {
	const totalSeconds = Math.max(1, Math.ceil(Math.max(0, ms) / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

function createTrackedObject<T extends object>(value: T, onChange: () => void): T {
	const existing = value as T & { [TRACKED_SETTINGS_KEY]?: true };
	if (existing[TRACKED_SETTINGS_KEY]) return value;
	return new Proxy(value, {
		// 设置变更会影响 render 缓存签名；只在值真正变化时递增版本。
		set(target, property, nextValue) {
			if ((target as any)[property] === nextValue) return true;
			(target as any)[property] = nextValue;
			onChange();
			return true;
		},
		get(target, property, receiver) {
			if (property === TRACKED_SETTINGS_KEY) return true;
			return Reflect.get(target, property, receiver);
		},
	}) as T;
}

function normalizeSettings(settings: AlpsPiSettings | any, enabled?: boolean): AlpsPiSettings {
	if (settings?.chromeFrame) {
		return {
			chromeFrame: {
				...DEFAULT_CONFIG.settings.chromeFrame,
				...settings.chromeFrame,
				enabled: typeof enabled === "boolean" ? enabled : Boolean(settings.chromeFrame.enabled ?? DEFAULT_CONFIG.settings.chromeFrame.enabled),
			},
			fixedBottomEditor: {
				...DEFAULT_CONFIG.settings.fixedBottomEditor,
				...(settings.fixedBottomEditor ?? {}),
			},
			beautifiedInput: {
				...DEFAULT_CONFIG.settings.beautifiedInput,
				...(settings.beautifiedInput ?? {}),
			},
			animations: {
				...DEFAULT_CONFIG.settings.animations,
				...(settings.animations ?? {}),
			},
			shortcuts: {
				...DEFAULT_CONFIG.settings.shortcuts,
				...(settings.shortcuts ?? {}),
			},
		} as AlpsPiSettings;
	}
	return {
		chromeFrame: {
			enabled: typeof enabled === "boolean" ? enabled : Boolean(settings?.enabled ?? DEFAULT_CONFIG.settings.chromeFrame.enabled),
			assistantFrame: Boolean(settings?.assistantFrame ?? DEFAULT_CONFIG.settings.chromeFrame.assistantFrame),
			toolCompactMode: Boolean(settings?.toolCompactMode ?? DEFAULT_CONFIG.settings.chromeFrame.toolCompactMode),
			compactEditTool: Boolean(settings?.compactEditTool ?? DEFAULT_CONFIG.settings.chromeFrame.compactEditTool),
		},
		fixedBottomEditor: {
			enabled: Boolean(settings?.fixedBottomEditor?.enabled ?? DEFAULT_CONFIG.settings.fixedBottomEditor.enabled),
		},
		beautifiedInput: {
			enabled: Boolean(settings?.beautifiedInput?.enabled ?? DEFAULT_CONFIG.settings.beautifiedInput.enabled),
		},
		animations: {
			...DEFAULT_CONFIG.settings.animations,
			...(settings?.animations ?? {}),
		},
		shortcuts: {
			...DEFAULT_CONFIG.settings.shortcuts,
			...(settings?.shortcuts ?? {}),
		},
	};
}

function syncChromeFrameEnabled(state: PatchState): void {
	state.config.settings.chromeFrame.enabled = state.enabled;
}

function createTrackedSettings(settings: AlpsPiSettings, onChange: () => void, enabled?: boolean): AlpsPiSettings {
	const normalized = normalizeSettings(settings, enabled);
	normalized.chromeFrame = createTrackedObject(normalized.chromeFrame, onChange);
	normalized.fixedBottomEditor = createTrackedObject(normalized.fixedBottomEditor, onChange);
	normalized.beautifiedInput = createTrackedObject(normalized.beautifiedInput, onChange);
	normalized.animations = createTrackedObject(normalized.animations, onChange);
	normalized.shortcuts = createTrackedObject(normalized.shortcuts, onChange);
	return createTrackedObject(normalized, onChange);
}

function ensurePatchStateConfigTracking(state: PatchState): PatchState {
	if (typeof state.configVersion !== "number") state.configVersion = 0;
	// reload 兼容旧全局 state：补齐 P4 conflict 集合，避免 skip-restore 后再次包装未知 wrapper。
	if (!(state as any).conflicts) state.conflicts = new Set();
	state.config.settings = createTrackedSettings(state.config.settings, () => {
		state.configVersion += 1;
	});
	return state;
}

function createPatchConfig(state: Pick<PatchState, "configVersion" | "enabled">): ChromeConfig {
	return {
		...DEFAULT_CONFIG,
		settings: createTrackedSettings(cloneDefaultSettings(), () => {
			state.configVersion += 1;
		}),
		styles: DEFAULT_CONFIG.styles,
	};
}

export function createInitialPatchState(): PatchState {
	resetTimingRegistry();
	const state: PatchState = {
		enabled: false,
		originals: new Map(),
		patched: new Set(),
		failures: new Map(),
		conflicts: new Set(),
		config: undefined as unknown as ChromeConfig,
		configVersion: 0,
	};
	state.config = createPatchConfig(state);
	return state;
}

export function getGlobalPatchState(): PatchState {
	const existing = (globalThis as any)[PATCH_KEY] as PatchState | undefined;
	if (existing) return ensurePatchStateConfigTracking(existing);
	const state = createInitialPatchState();
	(globalThis as any)[PATCH_KEY] = state;
	return state;
}

function asLines(value: unknown): string[] {
	if (Array.isArray(value)) return value.map(String);
	if (value === undefined || value === null) return [];
	return [String(value)];
}

/** 净化窄宽度原始 fallback 输出，避免 wrapper 分支绕过 terminal 展示边界。 */
function sanitizeNarrowFallbackLines(lines: readonly string[], width: number): string[] {
	const maxWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	if (maxWidth <= 0) return [];
	return lines
		.flatMap((line) => sanitizeTerminalText(line, { preserveSgr: true }).split("\n"))
		.map((line) => truncateToWidth(line, maxWidth, "", false));
}

function getToolStatus(instance: any): ChromeStatus {
	if (instance?.isPartial !== false) return "pending";
	if (instance?.result?.isError) return "error";
	return "success";
}

function getBashStatus(instance: any): ChromeStatus {
	if (instance?.status === "error") return "error";
	if (instance?.status === "cancelled") return "error";
	if (instance?.status === "complete") return "success";
	if (typeof instance?.exitCode === "number") return instance.exitCode === 0 ? "success" : "error";
	return "pending";
}

function deriveStatus(kind: ChromeKind, instance: any): ChromeStatus | undefined {
	if (kind === "tool") return getToolStatus(instance);
	if (kind === "toolPending") return "pending";
	if (kind === "toolSuccess") return "success";
	if (kind === "toolError") return "error";
	if (kind === "bash") return getBashStatus(instance);
	return undefined;
}

function isNonEmptyText(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function isThinkingOnlyAssistant(instance: any): boolean {
	// 只基于 AssistantMessage 原始 content 判断，避免从渲染后的 TUI children 里误猜正文/think。
	const content = instance?.lastMessage?.content;
	if (!Array.isArray(content)) return false;
	let hasThinking = false;
	for (const block of content) {
		if (block?.type === "thinking" && isNonEmptyText(block.thinking)) {
			hasThinking = true;
			continue;
		}
		if (block?.type === "text" && isNonEmptyText(block.text)) return false;
	}
	return hasThinking;
}

function resolveRenderKind(kind: ChromeKind, instance: any): ChromeKind {
	if (kind === "assistant" && isThinkingOnlyAssistant(instance)) return "thinking";
	return kind;
}

function deriveToolName(kind: ChromeKind, instance: any, fallback?: string): string | undefined {
	if (kind === "tool" || kind === "toolPending" || kind === "toolSuccess" || kind === "toolError") {
		return String(instance?.toolName ?? fallback ?? "tool");
	}
	return fallback;
}

function stripControlMarkers(line: string): string {
	if (!line.includes("\x1b")) return line;
	return line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "");
}

function isVisibleTextLine(line: string): boolean {
	if (isImageEscapeLine(line)) return false;
	return stripControlMarkers(line).trim().length > 0;
}

function firstVisibleTextLine(lines: readonly string[]): string | undefined {
	for (const raw of lines) {
		for (const line of String(raw).split("\n")) {
			if (isVisibleTextLine(line)) return line;
		}
	}
	return undefined;
}

function getToolResultContentLines(instance: any): string[] | undefined {
	const content = instance?.result?.content;
	if (!Array.isArray(content)) return undefined;
	return content.filter((block: any) => block?.type === "text").map((block: any) => String(block.text ?? ""));
}

function normalizeToolLine(line: string): string {
	return stripControlMarkers(line).trim();
}

const LOW_VALUE_TOOL_REST_PATTERN = /^[=:：≡☰-]+$/;
const STATUS_ONLY_TOOL_LINE_PATTERN = /^[✓✔✗✘×✕-]+$/;
const STRUCTURAL_ONLY_TOOL_TEXT_PATTERN = /^[{}\[\],]+$/;
const FRONTMATTER_BOUNDARY_PATTERN = /^-{3,}$/;
const MARKDOWN_FENCE_PATTERN = /^`{3,}/;
const ARG_SUMMARY_VALUE_LIMIT = 48;
const ARG_SUMMARY_PART_LIMIT = 4;

type ToolLineMatcher = {
	lowerToolName?: string;
	toolNameLength: number;
};

function createToolLineMatcher(toolName?: string): ToolLineMatcher {
	const normalized = toolName?.trim();
	return normalized ? { lowerToolName: normalized.toLowerCase(), toolNameLength: normalized.length } : { toolNameLength: 0 };
}

function isAsciiWordChar(char: string): boolean {
	const code = char.charCodeAt(0);
	return code === 95 || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function getToolLineRest(text: string, matcher: ToolLineMatcher): string | undefined {
	if (!matcher.lowerToolName) return undefined;
	if (text.length < matcher.toolNameLength) return undefined;
	if (text.slice(0, matcher.toolNameLength).toLowerCase() !== matcher.lowerToolName) return undefined;
	const rest = text.slice(matcher.toolNameLength);
	if (!rest) return "";
	if (isAsciiWordChar(rest[0]!)) return undefined;
	return rest.trim();
}

function isLowValueToolRest(rest: string): boolean {
	return rest.length === 0 || LOW_VALUE_TOOL_REST_PATTERN.test(rest);
}

function isStatusOnlyToolText(text: string): boolean {
	return STATUS_ONLY_TOOL_LINE_PATTERN.test(text);
}

function isStructuralOnlyToolText(text: string): boolean {
	return STRUCTURAL_ONLY_TOOL_TEXT_PATTERN.test(text) || FRONTMATTER_BOUNDARY_PATTERN.test(text) || MARKDOWN_FENCE_PATTERN.test(text);
}

function isLowValueToolText(text: string, matcher?: ToolLineMatcher): boolean {
	if (isStatusOnlyToolText(text) || isStructuralOnlyToolText(text)) return true;
	const rest = matcher ? getToolLineRest(text, matcher) : undefined;
	return rest !== undefined && isLowValueToolRest(rest);
}

function isRenderedResourceSummaryLine(text: string): boolean {
	return /^\[(?:skill|resource|docs)\]\s+\S/i.test(text);
}

/** 从 tool 原始渲染中找调用摘要；保留 Pi 对 skill/resource read 的紧凑摘要。 */
function firstInvocationSummaryLine(lines: readonly string[], matcher: ToolLineMatcher): string | undefined {
	for (const raw of lines) {
		for (const line of String(raw).split("\n")) {
			if (!isVisibleTextLine(line)) continue;
			const text = normalizeToolLine(line);
			if (text.startsWith("$ ") && text.slice(2).trim().length > 0) return line;
			if (isRenderedResourceSummaryLine(text)) return line;
			const rest = getToolLineRest(text, matcher);
			if (rest !== undefined && !isLowValueToolRest(rest)) return line;
		}
	}
	return undefined;
}

function firstMeaningfulToolLine(lines: readonly string[], matcher?: ToolLineMatcher): string | undefined {
	for (const raw of lines) {
		for (const line of String(raw).split("\n")) {
			if (!isVisibleTextLine(line)) continue;
			const text = normalizeToolLine(line);
			if (isLowValueToolText(text, matcher)) continue;
			return line;
		}
	}
	return undefined;
}

function firstNonBoilerplateToolLine(lines: readonly string[], matcher: ToolLineMatcher): string | undefined {
	return firstMeaningfulToolLine(lines, matcher);
}

function compactArgValue(value: unknown): string | undefined {
	if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
	const normalized = String(value).replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	return normalized.length > ARG_SUMMARY_VALUE_LIMIT ? `${normalized.slice(0, ARG_SUMMARY_VALUE_LIMIT - 1)}…` : normalized;
}

/** 为没有自定义调用渲染的工具生成短参数摘要，避免 JSON 结果首行成为唯一正文。 */
function createToolArgsSummary(toolName: string | undefined, instance: any): string | undefined {
	if (!toolName) return undefined;
	const args = instance?.args;
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const parts: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		const compactValue = compactArgValue(value);
		if (compactValue === undefined) continue;
		parts.push(`${key}=${compactValue}`);
		if (parts.length >= ARG_SUMMARY_PART_LIMIT) break;
	}
	return parts.length > 0 ? `${toolName} ${parts.join(" ")}` : undefined;
}

/** 提取 tool 极简模式正文：优先显示调用意图，缺失时回退有意义的结果首行。 */
export function compactToolLines(lines: readonly string[], instance?: any): string[] {
	const toolName = instance?.toolName === undefined ? undefined : String(instance.toolName);
	const matcher = createToolLineMatcher(toolName);
	const invocationLine = firstInvocationSummaryLine(lines, matcher);
	const argsSummaryLine = createToolArgsSummary(toolName, instance);
	const resultLines = instance ? getToolResultContentLines(instance) : undefined;
	const resultLine = resultLines ? firstMeaningfulToolLine(resultLines) : undefined;
	const line = invocationLine ?? argsSummaryLine ?? resultLine ?? firstNonBoilerplateToolLine(lines, matcher);
	return line ? [line] : [];
}

function shouldCompactTool(kind: ChromeKind, toolName: string | undefined, instance: any, config: ChromeConfig): boolean {
	if (kind !== "tool") return false;
	if (!config.settings.chromeFrame.toolCompactMode) return false;
	if (Boolean(instance?.expanded)) return false;
	if (toolName === "edit" && !config.settings.chromeFrame.compactEditTool) return false;
	return true;
}

function createStyleSignature(id: string, kind: ChromeKind, status: ChromeStatus | undefined, toolName: string | undefined, config: ChromeConfig, configVersion: number, expanded: boolean): string {
	const style = getChromeStyle(kind, { toolName, status }, config);
	return [id, kind, status ?? "", toolName ?? "", configVersion, expanded ? "expanded" : "collapsed", style.bg, style.border, style.label, style.text].join(CACHE_KEY_SEPARATOR);
}

function createTimingContentKey(kind: ChromeKind, instance: any, innerLines: readonly string[]): string {
	if (kind === "tool" && instance?.toolCallId) return `tool:${String(instance.toolCallId)}`;
	return innerLines.join("\n");
}

function shouldUseCompactThinkingBox(kind: ChromeKind, instance: any): boolean {
	// hidden think 只展示状态，不需要普通消息框的上下留白；visible think 仍完整展示原文。
	return kind === "thinking" && instance?.hideThinkingBlock === true;
}

export function createSafeBoxRender(kind: ChromeKind, inner: (innerWidth: number) => string[], options: SafeBoxRenderOptions): (width: number) => string[] {
	return (width: number) => {
		const innerWidth = Math.max(1, Math.floor(width) - 4);
		const innerLines = asLines(inner(innerWidth));
		if (isEmptyMessageChrome(kind, innerLines)) return [];
		if (options.forceImageFallback && containsImageLine(innerLines)) {
			return options.getFallback();
		}
		return renderNeonBox(kind, innerLines, width, options.getTheme(), {
			toolName: options.toolName,
			status: options.status,
			config: options.config,
		});
	};
}

export function createWrappedRender(
	id: string,
	kind: ChromeKind,
	originalRender: Function,
	getTheme: (instance?: any) => ThemeLike,
	extra: Record<string, unknown> = {},
): (this: any, width: number) => string[] {
	const debugEnabled = isChromeFrameDebugEnabled();
	const wrapped = function alpsChromeWrappedRender(this: any, width: number): string[] {
		const instance = this;
		const renderKind = resolveRenderKind(kind, instance);
		const status = deriveStatus(renderKind, instance);
		const toolName = deriveToolName(renderKind, instance, extra.toolName as string | undefined);
		const numericWidth = Number.isFinite(width) ? Math.floor(width) : 0;
		let innerWidth: number | null = null;
		let innerLines: string[] | undefined;
		let displayedLines: string[] | undefined;
		let branch: ChromeFrameDebugBranch = "normal";
		let cacheKeySummary: string | null = null;
		const debugReturn = debugEnabled
			? (lines: string[], nextBranch: ChromeFrameDebugBranch, error?: unknown): string[] => {
				writeChromeFrameDebugLog({
					targetId: id,
					targetKind: renderKind,
					inputWidth: numericWidth,
					resolvedFrameWidth: numericWidth,
					innerWidth,
					originalLineCount: innerLines?.length ?? null,
					displayedLineCount: displayedLines?.length ?? null,
					boxedLineCount: lines.length,
					branch: nextBranch,
					cacheKeySummary,
					hasImageLine: displayedLines ? containsImageLine(displayedLines) : false,
					usesCompactThinking: shouldUseCompactThinkingBox(renderKind, instance),
					error: error instanceof Error ? error.name : error ? typeof error : undefined,
					lines,
				});
				return lines;
			}
			: undefined;
		const fallback = () => asLines(originalRender.call(instance, width));
		try {
			if (numericWidth < 8) {
				branch = "narrowFallback";
				const rawFallback = fallback();
				innerLines = rawFallback;
				displayedLines = rawFallback;
				const lines = sanitizeNarrowFallbackLines(rawFallback, numericWidth);
				return debugReturn ? debugReturn(lines, branch) : lines;
			}
			innerWidth = Math.max(1, numericWidth - 4);
			innerLines = asLines(originalRender.call(instance, innerWidth));
			const state = getGlobalPatchState();
			const config = state.config;
			if (kind === "assistant" && !config.settings.chromeFrame.assistantFrame) {
				branch = "fallback";
				const rawFallback = fallback();
				displayedLines = rawFallback;
				return debugReturn ? debugReturn(rawFallback, branch) : rawFallback;
			}
			displayedLines = shouldCompactTool(renderKind, toolName, instance, config) ? compactToolLines(innerLines, instance) : innerLines;
			if (isEmptyMessageChrome(renderKind, displayedLines)) {
				branch = "empty";
				return debugReturn ? debugReturn([], branch) : [];
			}
			if (Boolean(extra.forceImageFallback) && containsImageLine(displayedLines)) {
				branch = "imageFallback";
				const rawFallback = fallback();
				return debugReturn ? debugReturn(rawFallback, branch) : rawFallback;
			}
			const innerKey = displayedLines.join("\n");
			const styleKey = createStyleSignature(id, renderKind, status, toolName, config, state.configVersion, Boolean(instance?.expanded));
			cacheKeySummary = debugReturn ? summarizeChromeFrameCacheKey(innerKey) : null;
			const timingContentKey = createTimingContentKey(renderKind, instance, innerLines);
			const timingKey = [timingContentKey, renderKind, toolName ?? "", status ?? ""].join(CACHE_KEY_SEPARATOR);
			const timing = updateTimingState(instance, timingKey);
			const elapsedText = formatElapsedSincePrevious(timing);
			const cache = (instance as any)[RENDER_CACHE_KEY] as RenderCacheEntry | undefined;
			if (cache && cache.width === numericWidth && cache.innerKey === innerKey && cache.styleKey === styleKey && cache.elapsedText === elapsedText) {
				branch = "cacheHit";
				return debugReturn ? debugReturn(cache.lines, branch) : cache.lines;
			}
			const usesCompactThinking = shouldUseCompactThinkingBox(renderKind, instance);
			branch = usesCompactThinking ? "compactThinking" : "normal";
			const lines = usesCompactThinking
				? renderCompactThinkingBox(displayedLines, numericWidth, getTheme(instance), config)
				: renderNeonBox(renderKind, displayedLines, numericWidth, getTheme(instance), {
					toolName,
					status,
					config,
					elapsedText,
				});
			(instance as any)[RENDER_CACHE_KEY] = { width: numericWidth, innerKey, styleKey, elapsedText, lines } satisfies RenderCacheEntry;
			return debugReturn ? debugReturn(lines, branch) : lines;
		} catch (error) {
			try {
				branch = "errorFallback";
				const rawFallback = fallback();
				innerLines = innerLines ?? rawFallback;
				displayedLines = displayedLines ?? rawFallback;
				return debugReturn ? debugReturn(rawFallback, branch, error) : rawFallback;
			} catch (fallbackError) {
				return debugReturn ? debugReturn([], "errorFallback", fallbackError) : [];
			}
		}
	};
	markWrappedRender(wrapped, { id, version: WRAPPED_RENDER_VERSION, originalRender, owner: CHROME_PATCH_OWNER });
	return wrapped;
}

function validateTarget(target: ComponentTarget): string | undefined {
	if (!target.ctor) return "component constructor missing";
	if (!target.ctor.prototype) return "component prototype missing";
	if (typeof target.ctor.prototype.render !== "function") return "prototype.render missing";
	return undefined;
}

export function enablePatch(targets: readonly ComponentTarget[] = createRuntimeTargets()): PatchState {
	const state = getGlobalPatchState();
	state.failures.clear();

	for (const target of targets) {
		try {
			const validation = validateTarget(target);
			if (validation) {
				state.failures.set(target.id, validation);
				if (target.core) {
					disablePatch(targets);
					state.enabled = false;
					syncChromeFrameEnabled(state);
					return state;
				}
				continue;
			}

			const current = target.ctor.prototype.render;
			// 发生过 skip-restore 后，未知 wrapper 链可能仍闭包引用旧 alps wrapper；再次 enable 选择 fail closed，避免叠加双层 alps chrome。
			if (state.conflicts.has(target.id) && !isCurrentWrappedRender(target.id, current)) {
				state.failures.set(target.id, "skip enable: prototype.render conflict from previous disable is still active");
				if (target.core) {
					disablePatch(targets);
					state.enabled = false;
					syncChromeFrameEnabled(state);
					return state;
				}
				continue;
			}
			state.conflicts.delete(target.id);
			const currentMetadata = getWrappedRenderMetadata(current);
			const original = state.originals.get(target.id) ?? currentMetadata?.originalRender ?? current;
			if (!state.originals.has(target.id)) {
				state.originals.set(target.id, original);
			}
			if (state.patched.has(target.id) && isCurrentWrappedRender(target.id, current)) {
				continue;
			}

			target.ctor.prototype.render = createWrappedRender(
				target.id,
				target.kind,
				original,
				target.getTheme,
				{ forceImageFallback: target.forceImageFallback },
			);
			state.patched.add(target.id);
		} catch (error) {
			state.failures.set(target.id, error instanceof Error ? error.message : String(error));
			if (target.core) {
				disablePatch(targets);
				state.enabled = false;
				syncChromeFrameEnabled(state);
				return state;
			}
		}
	}

	state.enabled = state.patched.size > 0;
	syncChromeFrameEnabled(state);
	return state;
}

export function disablePatch(targets: readonly ComponentTarget[] = createRuntimeTargets()): PatchState {
	resetTimingRegistry();
	const state = getGlobalPatchState();
	for (const target of targets) {
		const original = state.originals.get(target.id);
		if (original && target.ctor?.prototype) {
			try {
				const current = target.ctor.prototype.render;
				if (isCurrentWrappedRender(target.id, current)) {
					target.ctor.prototype.render = original;
					state.originals.delete(target.id);
					state.patched.delete(target.id);
					state.conflicts.delete(target.id);
				} else {
					state.failures.set(target.id, "skip restore: prototype.render is no longer owned by alps-pi chrome-frame");
					state.conflicts.add(target.id);
					state.originals.delete(target.id);
					state.patched.delete(target.id);
				}
			} catch (error) {
				state.failures.set(target.id, error instanceof Error ? error.message : String(error));
			}
		} else {
			state.originals.delete(target.id);
			state.patched.delete(target.id);
			if (!target.ctor?.prototype) state.conflicts.delete(target.id);
		}
	}
	state.enabled = state.patched.size > 0;
	syncChromeFrameEnabled(state);
	return state;
}

export function createRuntimeTargets(themeOverride?: ThemeLike): ComponentTarget[] {
	const getTheme = () => themeOverride ?? getRuntimeTheme();
	return [
		{ id: "UserMessageComponent", kind: "user", ctor: UserMessageComponent, core: true, getTheme },
		{ id: "AssistantMessageComponent", kind: "assistant", ctor: AssistantMessageComponent, core: true, getTheme },
		{ id: "CustomMessageComponent", kind: "custom", ctor: CustomMessageComponent, getTheme },
		{ id: "SkillInvocationMessageComponent", kind: "skill", ctor: SkillInvocationMessageComponent, getTheme },
		{ id: "CompactionSummaryMessageComponent", kind: "compaction", ctor: CompactionSummaryMessageComponent, getTheme },
		{ id: "BranchSummaryMessageComponent", kind: "branch", ctor: BranchSummaryMessageComponent, getTheme },
		{ id: "ToolExecutionComponent", kind: "tool", ctor: ToolExecutionComponent, getTheme, forceImageFallback: true },
		{ id: "BashExecutionComponent", kind: "bash", ctor: BashExecutionComponent, getTheme },
	];
}

export function getRuntimeTheme(): ThemeLike {
	const key = Symbol.for("@earendil-works/pi-coding-agent:theme");
	const fallbackKey = Symbol.for("@mariozechner/pi-coding-agent:theme");
	const candidate = (globalThis as any)[key] ?? (globalThis as any)[fallbackKey];
	if (candidate?.fg && candidate?.bg) return candidate as ThemeLike;
	return {
		fg: (_token: string, text: string) => text,
		bg: (_token: string, text: string) => text,
		bold: (text: string) => text,
	};
}
