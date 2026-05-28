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
import { isEmptyMessageChrome, renderNeonBox } from "./chrome.ts";
import { containsImageLine, isImageEscapeLine } from "./image.ts";
import { cloneDefaultSettings, type AlpsPiSettings } from "../../settings.ts";
import { DEFAULT_CONFIG, getChromeStyle, type ChromeConfig, type ChromeKind, type ChromeStatus, type ThemeLike } from "./styles.ts";

export const PATCH_KEY = Symbol.for("alps.pi.patch.v1");

export type PatchState = {
	enabled: boolean;
	originals: Map<string, Function>;
	patched: Set<string>;
	failures: Map<string, string>;
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

const RENDER_CACHE_KEY = Symbol.for("alps.pi.renderCache.v1");
const TIMING_STATE_KEY = Symbol.for("alps.pi.timingState.v1");
const TRACKED_SETTINGS_KEY = Symbol.for("alps.pi.trackedSettings.v1");
const WRAPPED_RENDER_KEY = Symbol.for("alps.pi.wrappedRender.v2");
const WRAPPED_RENDER_VERSION = 3;
const CACHE_KEY_SEPARATOR = "\x1f";

type WrappedRenderMetadata = {
	id: string;
	version: number;
	originalRender: Function;
};

type TimingState = {
	sequence: number;
	generation: number;
	lastSignature: string;
	lastUpdatedAt: number;
};

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
	return metadata?.id === id && metadata.version === WRAPPED_RENDER_VERSION;
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

function normalizeSettings(settings: AlpsPiSettings | any, enabled: boolean): AlpsPiSettings {
	if (settings?.chromeFrame) {
		return {
			...settings,
			chromeFrame: {
				...DEFAULT_CONFIG.settings.chromeFrame,
				...settings.chromeFrame,
				enabled,
			},
			fixedBottomEditor: {
				...DEFAULT_CONFIG.settings.fixedBottomEditor,
				...(settings.fixedBottomEditor ?? {}),
			},
			bottomStatus: {
				...DEFAULT_CONFIG.settings.bottomStatus,
				...(settings.bottomStatus ?? {}),
			},
			shortcuts: {
				...DEFAULT_CONFIG.settings.shortcuts,
				...(settings.shortcuts ?? {}),
			},
		} as AlpsPiSettings;
	}
	return {
		chromeFrame: {
			enabled,
			assistantFrame: Boolean(settings?.assistantFrame ?? DEFAULT_CONFIG.settings.chromeFrame.assistantFrame),
			toolCompactMode: Boolean(settings?.toolCompactMode ?? DEFAULT_CONFIG.settings.chromeFrame.toolCompactMode),
			compactEditTool: Boolean(settings?.compactEditTool ?? DEFAULT_CONFIG.settings.chromeFrame.compactEditTool),
		},
		fixedBottomEditor: {
			enabled: Boolean(settings?.fixedBottomEditor?.enabled ?? DEFAULT_CONFIG.settings.fixedBottomEditor.enabled),
		},
		bottomStatus: {
			enabled: Boolean(settings?.bottomStatus?.enabled ?? DEFAULT_CONFIG.settings.bottomStatus.enabled),
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

function createTrackedSettings(settings: AlpsPiSettings, enabled: boolean, onChange: () => void): AlpsPiSettings {
	const normalized = normalizeSettings(settings, enabled);
	normalized.chromeFrame = createTrackedObject(normalized.chromeFrame, onChange);
	normalized.fixedBottomEditor = createTrackedObject(normalized.fixedBottomEditor, onChange);
	normalized.bottomStatus = createTrackedObject(normalized.bottomStatus, onChange);
	normalized.shortcuts = createTrackedObject(normalized.shortcuts, onChange);
	return createTrackedObject(normalized, onChange);
}

function ensurePatchStateConfigTracking(state: PatchState): PatchState {
	if (typeof state.configVersion !== "number") state.configVersion = 0;
	state.config.settings = createTrackedSettings(state.config.settings, state.enabled, () => {
		state.configVersion += 1;
	});
	return state;
}

function createPatchConfig(state: Pick<PatchState, "configVersion" | "enabled">): ChromeConfig {
	return {
		...DEFAULT_CONFIG,
		settings: createTrackedSettings(cloneDefaultSettings(), state.enabled, () => {
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

function firstInvocationSummaryLine(lines: readonly string[], matcher: ToolLineMatcher): string | undefined {
	for (const raw of lines) {
		for (const line of String(raw).split("\n")) {
			if (!isVisibleTextLine(line)) continue;
			const text = normalizeToolLine(line);
			if (text.startsWith("$ ") && text.slice(2).trim().length > 0) return line;
			const rest = getToolLineRest(text, matcher);
			if (rest !== undefined && !isLowValueToolRest(rest)) return line;
		}
	}
	return undefined;
}

function firstNonBoilerplateToolLine(lines: readonly string[], matcher: ToolLineMatcher): string | undefined {
	for (const raw of lines) {
		for (const line of String(raw).split("\n")) {
			if (!isVisibleTextLine(line)) continue;
			const text = normalizeToolLine(line);
			const rest = getToolLineRest(text, matcher);
			if (rest !== undefined && isLowValueToolRest(rest)) continue;
			if (isStatusOnlyToolText(text)) continue;
			return line;
		}
	}
	return undefined;
}

/** 提取 tool 极简模式正文：优先显示关键调用行，缺失时回退结果首行，再跳过原始低价值行。 */
export function compactToolLines(lines: readonly string[], instance?: any): string[] {
	const toolName = instance?.toolName === undefined ? undefined : String(instance.toolName);
	const matcher = createToolLineMatcher(toolName);
	const invocationLine = firstInvocationSummaryLine(lines, matcher);
	const resultLines = instance ? getToolResultContentLines(instance) : undefined;
	const resultLine = resultLines ? firstVisibleTextLine(resultLines) : undefined;
	const line = invocationLine ?? resultLine ?? firstNonBoilerplateToolLine(lines, matcher);
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
	const wrapped = function alpsChromeWrappedRender(this: any, width: number): string[] {
		const instance = this;
		const status = deriveStatus(kind, instance);
		const toolName = deriveToolName(kind, instance, extra.toolName as string | undefined);
		const fallback = () => asLines(originalRender.call(instance, width));
		try {
			const numericWidth = Number.isFinite(width) ? Math.floor(width) : 0;
			if (numericWidth < 8) return fallback();
			const innerWidth = Math.max(1, numericWidth - 4);
			const innerLines = asLines(originalRender.call(instance, innerWidth));
			const state = getGlobalPatchState();
			const config = state.config;
			if (kind === "assistant" && !config.settings.chromeFrame.assistantFrame) {
				return fallback();
			}
			const displayedLines = shouldCompactTool(kind, toolName, instance, config) ? compactToolLines(innerLines, instance) : innerLines;
			if (isEmptyMessageChrome(kind, displayedLines)) return [];
			if (Boolean(extra.forceImageFallback) && containsImageLine(displayedLines)) {
				return fallback();
			}
			const innerKey = displayedLines.join("\n");
			const styleKey = createStyleSignature(id, kind, status, toolName, config, state.configVersion, Boolean(instance?.expanded));
			const timingContentKey = createTimingContentKey(kind, instance, innerLines);
			const timingKey = [timingContentKey, kind, toolName ?? "", status ?? ""].join(CACHE_KEY_SEPARATOR);
			const timing = updateTimingState(instance, timingKey);
			const elapsedText = formatElapsedSincePrevious(timing);
			const cache = (instance as any)[RENDER_CACHE_KEY] as RenderCacheEntry | undefined;
			if (cache && cache.width === numericWidth && cache.innerKey === innerKey && cache.styleKey === styleKey && cache.elapsedText === elapsedText) {
				return cache.lines;
			}
			const lines = renderNeonBox(kind, displayedLines, numericWidth, getTheme(instance), {
				toolName,
				status,
				config,
				elapsedText,
			});
			(instance as any)[RENDER_CACHE_KEY] = { width: numericWidth, innerKey, styleKey, elapsedText, lines } satisfies RenderCacheEntry;
			return lines;
		} catch {
			try {
				return fallback();
			} catch {
				return [];
			}
		}
	};
	markWrappedRender(wrapped, { id, version: WRAPPED_RENDER_VERSION, originalRender });
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
	let restoreFailed = false;
	for (const target of targets) {
		const original = state.originals.get(target.id);
		if (original && target.ctor?.prototype) {
			try {
				target.ctor.prototype.render = original;
				state.originals.delete(target.id);
				state.patched.delete(target.id);
			} catch (error) {
				restoreFailed = true;
				state.failures.set(target.id, error instanceof Error ? error.message : String(error));
			}
		} else {
			state.originals.delete(target.id);
			state.patched.delete(target.id);
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
