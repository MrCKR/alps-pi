/** 功能：实现可回滚、幂等的 pi TUI component monkey patch 生命周期 实现者：alps 实现日期：2026-05-26 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { PI_COMPONENTS, inspectPiRuntimeCapabilities, type PiRuntimeCapabilities } from "../../pi-compat.ts";
import { isEmptyMessageChrome, renderCompactThinkingBox, renderNeonBox } from "./chrome.ts";
import { isChromeFrameDebugEnabled, summarizeChromeFrameCacheKey, writeChromeFrameDebugLog, type ChromeFrameDebugBranch } from "./debug.ts";
import { containsImageLine, isImageEscapeLine } from "./image.ts";
import { cloneDefaultSettings, type AlpsPiSettings } from "../../settings.ts";
import { sanitizeTerminalText } from "../../terminal-sanitizer.ts";
import { DEFAULT_CONFIG, getChromeStyle, type ChromeConfig, type ChromeKind, type ChromeStatus, type ThemeLike } from "./styles.ts";

const {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} = PI_COMPONENTS;

export const PATCH_KEY = Symbol.for("alps.pi.patch.v1");

export type PatchState = {
	/** 实际 runtime patch 是否已安装；不等同于持久化用户偏好。 */
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
	suppressInlineImages?: boolean;
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
	tokenText?: string;
	lines: string[];
};

// 缓存键随终端内联图片抑制语义升级，避免热加载复用带图片占位的旧输出。
const RENDER_CACHE_KEY = Symbol.for("alps.pi.renderCache.v6");
const TIMING_STATE_KEY = Symbol.for("alps.pi.timingState.v1");
const TRACKED_SETTINGS_KEY = Symbol.for("alps.pi.trackedSettings.v1");
const WRAPPED_RENDER_KEY = Symbol.for("alps.pi.wrappedRender.v2");
const WRAPPED_RENDER_VERSION = 7;
const CACHE_KEY_SEPARATOR = "\x1f";

export type ChromeFrameLifecycleEvent =
	| "agent_start"
	| "message_update"
	| "message_end"
	| "tool_execution_start"
	| "tool_execution_update"
	| "tool_execution_end"
	| "turn_end"
	| "agent_end";

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
	lifecycleUpdatedAt: number;
	active: boolean;
};

type LifecycleTimingState = {
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
	active: boolean;
	/** 事件所属 session/agent ctx；用于隔离无 UI 子代理的结束事件。 */
	owner?: object;
};

const CHROME_PATCH_OWNER = Symbol.for("alps.pi.chromeFrame.patchOwner.v1");
const timingRegistry = new Map<number, TimingState>();
const lifecycleTimingRegistry = new Map<string, LifecycleTimingState>();
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
	lifecycleTimingRegistry.clear();
	nextTimingSequence = 1;
	timingGeneration += 1;
}

function readTimestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function messageLifecycleKey(message: any): string | undefined {
	const timestamp = readTimestamp(message?.timestamp);
	return message?.role === "assistant" && timestamp !== undefined ? `assistant:${timestamp}` : undefined;
}

function frameLifecycleKey(kind: ChromeKind, instance: any): string | undefined {
	if (kind === "tool" || kind === "toolPending" || kind === "toolSuccess" || kind === "toolError") {
		return instance?.toolCallId ? `tool:${String(instance.toolCallId)}` : undefined;
	}
	if (kind === "assistant" || kind === "thinking") return messageLifecycleKey(instance?.lastMessage);
	return undefined;
}

function frameNativeTimestamp(kind: ChromeKind, instance: any): number | undefined {
	if (kind === "assistant" || kind === "thinking") return readTimestamp(instance?.lastMessage?.timestamp);
	if (kind === "tool" || kind === "toolPending" || kind === "toolSuccess" || kind === "toolError") {
		return readTimestamp(instance?.result?.timestamp);
	}
	return readTimestamp(instance?.message?.timestamp);
}

/** 从 Pi 每次新建的事件 ctx 中提取稳定 owner；顶层使用 UI，no-UI 子代理使用 sessionManager。 */
function lifecycleOwner(ctx: any): object | undefined {
	if (!ctx || (typeof ctx !== "object" && typeof ctx !== "function")) return undefined;
	try {
		if (ctx.hasUI !== false) {
			const ui = ctx.ui;
			if (ui && (typeof ui === "object" || typeof ui === "function")) return ui;
		}
		const sessionManager = ctx.sessionManager;
		if (sessionManager && (typeof sessionManager === "object" || typeof sessionManager === "function")) return sessionManager;
	} catch {
		// stale ctx 的 guarded getter 不可读取；保留对象本身可避免误冻结其它 scope。
	}
	return ctx;
}

/** 冻结同一 ctx 遗留的 active frame；没有 ctx 的测试/兼容调用会冻结全部记录。 */
function finalizeActiveLifecycleStates(timestamp: number, ctx?: any): void {
	const owner = lifecycleOwner(ctx);
	for (const state of lifecycleTimingRegistry.values()) {
		if (!state.active) continue;
		if (owner && state.owner !== owner) continue;
		state.updatedAt = timestamp;
		state.completedAt = timestamp;
		state.active = false;
	}
}

function writeLifecycleTimingState(key: string, timestamp: number, active: boolean, ctx?: any): void {
	const previous = lifecycleTimingRegistry.get(key);
	lifecycleTimingRegistry.set(key, {
		startedAt: previous?.startedAt ?? timestamp,
		updatedAt: timestamp,
		completedAt: active ? undefined : timestamp,
		active,
		owner: lifecycleOwner(ctx) ?? previous?.owner,
	});
}

/** assistant 流式 toolCall 出现时即建立 live 记录，历史 pending Tool 因没有事件记录不会继续计时。 */
function recordStreamingToolCalls(message: any, timestamp: number, ctx?: any): void {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
	for (const content of message.content) {
		if (content?.type !== "toolCall" || !content.id) continue;
		writeLifecycleTimingState(`tool:${String(content.id)}`, timestamp, true, ctx);
	}
}

/** 记录 Pi 的真实消息与工具生命周期；render 只消费时间，不再用重绘时机代替业务事件。 */
export function recordChromeFrameLifecycleEvent(type: ChromeFrameLifecycleEvent, event: any, ctx?: any, now = Date.now()): void {
	const timestamp = readTimestamp(now);
	if (timestamp === undefined) return;
	if (type === "agent_start" || type === "turn_end" || type === "agent_end") {
		finalizeActiveLifecycleStates(timestamp, ctx);
		return;
	}
	let key: string | undefined;
	let active = true;
	switch (type) {
		case "message_update":
			key = messageLifecycleKey(event?.message);
			recordStreamingToolCalls(event?.message, timestamp, ctx);
			break;
		case "message_end":
			key = messageLifecycleKey(event?.message);
			active = false;
			break;
		case "tool_execution_start":
		case "tool_execution_update":
			key = event?.toolCallId ? `tool:${String(event.toolCallId)}` : undefined;
			break;
		case "tool_execution_end":
			key = event?.toolCallId ? `tool:${String(event.toolCallId)}` : undefined;
			active = false;
			break;
	}
	if (key) writeLifecycleTimingState(key, timestamp, active, ctx);
}

function initializeTimingState(initialUpdatedAt: number, timing?: TimingState): TimingState {
	const next = timing ?? {
		sequence: 0,
		generation: timingGeneration,
		lastSignature: "",
		lastUpdatedAt: initialUpdatedAt,
		lifecycleUpdatedAt: -1,
		active: false,
	};
	next.sequence = nextTimingSequence++;
	next.generation = timingGeneration;
	next.lastSignature = "";
	next.lastUpdatedAt = initialUpdatedAt;
	next.lifecycleUpdatedAt = -1;
	next.active = false;
	timingRegistry.set(next.sequence, next);
	return next;
}

function getTimingState(instance: any, initialUpdatedAt: number): TimingState {
	let timing = instance?.[TIMING_STATE_KEY] as TimingState | undefined;
	if (timing?.generation === timingGeneration) return timing;
	if (timing) return initializeTimingState(initialUpdatedAt, timing);
	timing = initializeTimingState(initialUpdatedAt);
	Object.defineProperty(instance, TIMING_STATE_KEY, {
		value: timing,
		configurable: false,
	});
	return timing;
}

/** 优先使用生命周期事件；缺失事件时以内容签名变化作为兼容回退。 */
function updateTimingState(instance: any, kind: ChromeKind, status: ChromeStatus | undefined, signature: string): TimingState {
	const lifecycle = frameLifecycleKey(kind, instance);
	const lifecycleState = lifecycle ? lifecycleTimingRegistry.get(lifecycle) : undefined;
	const nativeTimestamp = frameNativeTimestamp(kind, instance);
	const now = Date.now();
	const timing = getTimingState(instance, lifecycleState?.updatedAt ?? nativeTimestamp ?? now);
	const firstSignature = timing.lastSignature === "";
	if (lifecycleState && timing.lifecycleUpdatedAt !== lifecycleState.updatedAt) {
		timing.lastUpdatedAt = lifecycleState.updatedAt;
		timing.lifecycleUpdatedAt = lifecycleState.updatedAt;
	} else if (!lifecycleState && timing.lastSignature !== signature) {
		// 历史 frame 首次渲染使用原始 timestamp；后续内容变化才使用当前更新时间。
		timing.lastUpdatedAt = firstSignature && nativeTimestamp !== undefined ? nativeTimestamp : now;
	}
	timing.lastSignature = signature;
	// Tool 必须有 live lifecycle 证据才动态计时；历史恢复的 pending Tool 否则会永久增长。
	timing.active = lifecycleState?.active ?? (kind === "bash" && status === "pending");
	return timing;
}

function formatElapsedSincePrevious(timing: TimingState): string | undefined {
	const previous = timingRegistry.get(timing.sequence - 1);
	if (!previous) return undefined;
	const effectiveUpdatedAt = timing.active ? Date.now() : timing.lastUpdatedAt;
	return formatElapsedDuration(effectiveUpdatedAt - previous.lastUpdatedAt);
}

/** 将消息间隔向上取整为秒级文本；不足 1s 也显示为 1s。 */
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
			inputMetrics: {
				...DEFAULT_CONFIG.settings.inputMetrics,
				...(settings.inputMetrics ?? {}),
			},
			footer: {
				...DEFAULT_CONFIG.settings.footer,
				...(settings.footer ?? {}),
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
		inputMetrics: {
			...DEFAULT_CONFIG.settings.inputMetrics,
			...(settings?.inputMetrics ?? {}),
		},
		footer: {
			enabled: Boolean(settings?.footer?.enabled ?? DEFAULT_CONFIG.settings.footer.enabled),
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

function createTrackedSettings(settings: AlpsPiSettings, onChange: () => void, enabled?: boolean): AlpsPiSettings {
	const normalized = normalizeSettings(settings, enabled);
	normalized.chromeFrame = createTrackedObject(normalized.chromeFrame, onChange);
	normalized.fixedBottomEditor = createTrackedObject(normalized.fixedBottomEditor, onChange);
	normalized.beautifiedInput = createTrackedObject(normalized.beautifiedInput, onChange);
	normalized.inputMetrics = createTrackedObject(normalized.inputMetrics, onChange);
	normalized.footer = createTrackedObject(normalized.footer, onChange);
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

const ESTIMATED_IMAGE_CHARS = 4800;

/** 复用 Pi compaction 的文本/图片字符计数规则。 */
function estimateTextAndImageContentChars(content: unknown): number | undefined {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return undefined;
	let chars = 0;
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") {
			chars += block.text.length;
		} else if (block?.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/** 安全计算 tool 参数 JSON 字符数，循环对象降级为字符串。 */
function safeJsonLength(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return String(value ?? "").length;
	}
}

/** 从 AssistantMessageComponent 的原始 message content 估算字符数。 */
function estimateAssistantContentChars(instance: any): number | undefined {
	const content = instance?.lastMessage?.content;
	if (!Array.isArray(content)) return undefined;
	let chars = 0;
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") {
			chars += block.text.length;
		} else if (block?.type === "thinking" && typeof block.thinking === "string") {
			chars += block.thinking.length;
		} else if (block?.type === "toolCall") {
			chars += String(block.name ?? "").length + safeJsonLength(block.arguments);
		}
	}
	return chars;
}

/** 从 UserMessageComponent 子 Markdown 中兜底读取构造时原文。 */
function extractMarkdownTextFromChildren(value: unknown, seen = new Set<object>()): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	if (seen.has(value)) return undefined;
	seen.add(value);
	const candidate = value as Record<string, any>;
	if (typeof candidate.text === "string" && candidate.constructor?.name === "Markdown") return candidate.text;
	const children = candidate.children;
	if (Array.isArray(children)) {
		for (const child of children) {
			const text = extractMarkdownTextFromChildren(child, seen);
			if (text !== undefined) return text;
		}
	}
	return undefined;
}

/** 估算 user frame 对应的原始用户消息字符数。 */
function estimateUserContentChars(instance: any): number | undefined {
	if (typeof instance?.text === "string") return instance.text.length;
	const direct = estimateTextAndImageContentChars(instance?.message?.content);
	if (direct !== undefined) return direct;
	return extractMarkdownTextFromChildren(instance)?.length;
}

/** 估算 tool frame 的调用名、参数和结果内容字符数。 */
function estimateToolContentChars(instance: any): number | undefined {
	let chars = String(instance?.toolName ?? "").length + safeJsonLength(instance?.args);
	const resultChars = estimateTextAndImageContentChars(instance?.result?.content);
	if (resultChars !== undefined) chars += resultChars;
	return chars;
}

/** 估算 compaction/branch summary 的摘要字符数。 */
function estimateSummaryContentChars(instance: any): number | undefined {
	if (typeof instance?.message?.summary === "string") return instance.message.summary.length;
	if (typeof instance?.summary === "string") return instance.summary.length;
	return undefined;
}

/** 估算 skill invocation 中实际展示的 skill 内容字符数。 */
function estimateSkillContentChars(instance: any): number | undefined {
	const block = instance?.skillBlock;
	if (!block) return undefined;
	return String(block.name ?? "").length + (typeof block.content === "string" ? block.content.length : 0);
}

/** 按 Pi compaction 的 chars/4 口径估算单个 frame 对应的原始上下文 token。 */
export function estimateFrameTokens(kind: ChromeKind, instance: any): number | undefined {
	let chars: number | undefined;
	switch (kind) {
		case "assistant":
		case "thinking":
			chars = estimateAssistantContentChars(instance);
			break;
		case "user":
			chars = estimateUserContentChars(instance);
			break;
		case "tool":
		case "toolPending":
		case "toolSuccess":
		case "toolError":
			chars = estimateToolContentChars(instance);
			break;
		case "bash":
			// Pi 0.84.4 未公开 excludeFromContext；无法可靠区分 ! 与 !!，因此不显示估算 token。
			return undefined;
		case "custom":
			chars = estimateTextAndImageContentChars(instance?.message?.content);
			break;
		case "skill":
			chars = estimateSkillContentChars(instance);
			break;
		case "compaction":
		case "branch":
			chars = estimateSummaryContentChars(instance);
			break;
		case "working":
			return undefined;
	}
	return chars === undefined ? undefined : Math.ceil(chars / 4);
}

/** 将 token 数压成标题短标签；超过千位时向上进位到 1 位小数。 */
function formatRoundedTokenCount(tokens: number): string {
	const count = Math.max(0, Math.ceil(tokens));
	const units = [
		{ value: 1_000_000, suffix: "M" },
		{ value: 1_000, suffix: "k" },
	] as const;
	for (const unit of units) {
		if (count < unit.value) continue;
		const scaled = Math.ceil((count / unit.value) * 10) / 10;
		return `${Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1)}${unit.suffix}`;
	}
	return count.toLocaleString();
}

/** 生成 frame 标题 token 文本；取不到原文时不显示。 */
function formatTokenText(tokens: number | undefined): string | undefined {
	if (tokens === undefined) return undefined;
	return `[ ${formatRoundedTokenCount(tokens)} ]`;
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

function isBlankTerminalLine(line: string): boolean {
	return sanitizeTerminalText(line, { allowNewline: false, allowTab: false, preserveSgr: false }).trim().length === 0;
}

/** 删除图片协议行及其连续高度占位；保留图片前后的普通工具文本。 */
function suppressInlineImageRows(lines: readonly string[]): string[] {
	const visibleLines: string[] = [];
	let suppressingImageRows = false;
	for (const raw of lines) {
		const line = String(raw);
		if (isImageEscapeLine(line)) {
			suppressingImageRows = true;
			continue;
		}
		if (suppressingImageRows && isBlankTerminalLine(line)) continue;
		suppressingImageRows = false;
		visibleLines.push(line);
	}
	return visibleLines;
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
					hasImageLine: innerLines ? containsImageLine(innerLines) : false,
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
			const state = getGlobalPatchState();
			const config = state.config;
			if (kind === "assistant" && !config.settings.chromeFrame.assistantFrame) {
				branch = "fallback";
				const rawFallback = fallback();
				innerLines = rawFallback;
				displayedLines = rawFallback;
				return debugReturn ? debugReturn(rawFallback, branch) : rawFallback;
			}
			innerWidth = Math.max(1, numericWidth - 4);
			innerLines = asLines(originalRender.call(instance, innerWidth));
			const hasSuppressedImage = Boolean(extra.suppressInlineImages) && containsImageLine(innerLines);
			const visibleInnerLines = hasSuppressedImage ? suppressInlineImageRows(innerLines) : innerLines;
			// 当前终端不显示图片：不输出 Kitty/iTerm payload，也不保留 Pi 为图片分配的高度占位。
			displayedLines = shouldCompactTool(renderKind, toolName, instance, config)
				? compactToolLines(visibleInnerLines, instance)
				: visibleInnerLines;
			if (isEmptyMessageChrome(renderKind, displayedLines)) {
				branch = "empty";
				return debugReturn ? debugReturn([], branch) : [];
			}
			const innerKey = displayedLines.join("\n");
			const styleKey = createStyleSignature(id, renderKind, status, toolName, config, state.configVersion, Boolean(instance?.expanded));
			cacheKeySummary = debugReturn ? summarizeChromeFrameCacheKey(innerKey) : null;
			const timingContentKey = createTimingContentKey(renderKind, instance, innerLines);
			const timingKey = [timingContentKey, renderKind, toolName ?? "", status ?? ""].join(CACHE_KEY_SEPARATOR);
			const timing = updateTimingState(instance, renderKind, status, timingKey);
			const elapsedText = formatElapsedSincePrevious(timing);
			const tokenText = formatTokenText(estimateFrameTokens(renderKind, instance));
			const cache = (instance as any)[RENDER_CACHE_KEY] as RenderCacheEntry | undefined;
			if (cache && cache.width === numericWidth && cache.innerKey === innerKey && cache.styleKey === styleKey && cache.elapsedText === elapsedText && cache.tokenText === tokenText) {
				branch = "cacheHit";
				return debugReturn ? debugReturn(cache.lines, branch) : cache.lines;
			}
			const usesCompactThinking = shouldUseCompactThinkingBox(renderKind, instance);
			branch = usesCompactThinking ? "compactThinking" : hasSuppressedImage ? "imageSuppressed" : "normal";
			const lines = usesCompactThinking
				? renderCompactThinkingBox(displayedLines, numericWidth, getTheme(instance), config, { elapsedText, tokenText })
				: renderNeonBox(renderKind, displayedLines, numericWidth, getTheme(instance), {
					toolName,
					status,
					config,
					elapsedText,
					tokenText,
				});
			(instance as any)[RENDER_CACHE_KEY] = { width: numericWidth, innerKey, styleKey, elapsedText, tokenText, lines } satisfies RenderCacheEntry;
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

export function enablePatch(
	targets: readonly ComponentTarget[] = createRuntimeTargets(),
	capabilities: PiRuntimeCapabilities = inspectPiRuntimeCapabilities(),
): PatchState {
	const state = getGlobalPatchState();
	state.failures.clear();
	if (!capabilities.chromeFrame.supported) {
		disablePatch(targets);
		state.failures.clear();
		for (const [id, reason] of capabilities.chromeFrame.failures) state.failures.set(`compat:${id}`, reason);
		state.enabled = false;
		return state;
	}

	for (const target of targets) {
		try {
			const validation = validateTarget(target);
			if (validation) {
				state.failures.set(target.id, validation);
				if (target.core) {
					disablePatch(targets);
					state.enabled = false;
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
				{ suppressInlineImages: target.suppressInlineImages },
			);
			state.patched.add(target.id);
		} catch (error) {
			state.failures.set(target.id, error instanceof Error ? error.message : String(error));
			if (target.core) {
				disablePatch(targets);
				state.enabled = false;
				return state;
			}
		}
	}

	state.enabled = state.patched.size > 0;
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
	return state;
}

/** 修改用户偏好并同步 runtime；生命周期 cleanup 应直接调用 disablePatch，避免覆盖偏好。 */
export function setChromeFramePreference(enabled: boolean, targets: readonly ComponentTarget[] = createRuntimeTargets()): PatchState {
	const state = getGlobalPatchState();
	state.config.settings.chromeFrame.enabled = enabled;
	return enabled ? enablePatch(targets) : disablePatch(targets);
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
		{ id: "ToolExecutionComponent", kind: "tool", ctor: ToolExecutionComponent, getTheme, suppressInlineImages: true },
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
