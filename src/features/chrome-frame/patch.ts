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
import { containsImageLine } from "./image.ts";
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
	lines: string[];
};

const RENDER_CACHE_KEY = Symbol.for("alps.pi.renderCache.v1");
const TRACKED_SETTINGS_KEY = Symbol.for("alps.pi.trackedSettings.v1");
const WRAPPED_RENDER_KEY = Symbol.for("alps.pi.wrappedRender.v2");
const WRAPPED_RENDER_VERSION = 2;
const CACHE_KEY_SEPARATOR = "\x1f";

type WrappedRenderMetadata = {
	id: string;
	version: number;
	originalRender: Function;
};

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
				...settings.chromeFrame,
				enabled,
			},
		} as AlpsPiSettings;
	}
	return {
		chromeFrame: {
			enabled,
			assistantFrame: Boolean(settings?.assistantFrame ?? DEFAULT_CONFIG.settings.chromeFrame.assistantFrame),
		},
	};
}

function syncChromeFrameEnabled(state: PatchState): void {
	state.config.settings.chromeFrame.enabled = state.enabled;
}

function createTrackedSettings(settings: AlpsPiSettings, enabled: boolean, onChange: () => void): AlpsPiSettings {
	const normalized = normalizeSettings(settings, enabled);
	normalized.chromeFrame = createTrackedObject(normalized.chromeFrame, onChange);
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

function createStyleSignature(id: string, kind: ChromeKind, status: ChromeStatus | undefined, toolName: string | undefined, config: ChromeConfig, configVersion: number): string {
	const style = getChromeStyle(kind, { toolName, status }, config);
	return [id, kind, status ?? "", toolName ?? "", configVersion, style.bg, style.border, style.label, style.text].join(CACHE_KEY_SEPARATOR);
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
			if (isEmptyMessageChrome(kind, innerLines)) return [];
			if (Boolean(extra.forceImageFallback) && containsImageLine(innerLines)) {
				return fallback();
			}
			const innerKey = innerLines.join("\n");
			const styleKey = createStyleSignature(id, kind, status, toolName, config, state.configVersion);
			const cache = (instance as any)[RENDER_CACHE_KEY] as RenderCacheEntry | undefined;
			if (cache && cache.width === numericWidth && cache.innerKey === innerKey && cache.styleKey === styleKey) {
				return cache.lines;
			}
			const lines = renderNeonBox(kind, innerLines, numericWidth, getTheme(instance), {
				toolName,
				status,
				config,
			});
			(instance as any)[RENDER_CACHE_KEY] = { width: numericWidth, innerKey, styleKey, lines } satisfies RenderCacheEntry;
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

export function formatPatchStatus(state: PatchState = getGlobalPatchState()): string {
	const mode = state.enabled ? "enabled" : "disabled";
	const patched = state.patched.size > 0 ? Array.from(state.patched).join(", ") : "(none)";
	const failures = state.failures.size > 0 ? Array.from(state.failures).map(([id, reason]) => `${id}: ${reason}`).join("; ") : "(none)";
	return `Alps Pi: ${mode}\nchromeFrame: ${state.config.settings.chromeFrame.enabled}\nassistantFrame: ${state.config.settings.chromeFrame.assistantFrame}\npatched: ${patched}\nfailures: ${failures}`;
}
