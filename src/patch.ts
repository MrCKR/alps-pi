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
import { cloneDefaultSettings } from "./settings.ts";
import { DEFAULT_CONFIG, type ChromeConfig, type ChromeKind, type ChromeStatus, type ThemeLike } from "./styles.ts";

export const PATCH_KEY = Symbol.for("alps.pi.patch.v1");

export type PatchState = {
	enabled: boolean;
	originals: Map<string, Function>;
	patched: Set<string>;
	failures: Map<string, string>;
	config: ChromeConfig;
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

export function createInitialPatchState(): PatchState {
	return {
		enabled: false,
		originals: new Map(),
		patched: new Set(),
		failures: new Map(),
		config: {
			...DEFAULT_CONFIG,
			settings: cloneDefaultSettings(),
			styles: DEFAULT_CONFIG.styles,
		},
	};
}

export function getGlobalPatchState(): PatchState {
	const existing = (globalThis as any)[PATCH_KEY] as PatchState | undefined;
	if (existing) return existing;
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
	return function alpsChromeWrappedRender(this: any, width: number): string[] {
		const instance = this;
		const status = deriveStatus(kind, instance);
		const toolName = deriveToolName(kind, instance, extra.toolName as string | undefined);
		const fallback = () => asLines(originalRender.call(instance, width));
		try {
			const numericWidth = Number.isFinite(width) ? Math.floor(width) : 0;
			if (numericWidth < 8) return fallback();
			const innerWidth = Math.max(1, numericWidth - 4);
			const innerLines = asLines(originalRender.call(instance, innerWidth));
			const config = getGlobalPatchState().config;
			if (kind === "assistant" && !config.settings.assistantFrame) {
				return fallback();
			}
			if (isEmptyMessageChrome(kind, innerLines)) return [];
			if (Boolean(extra.forceImageFallback) && containsImageLine(innerLines)) {
				return fallback();
			}
			const innerKey = innerLines.join("\n");
			const styleKey = `${id}|${kind}|${status ?? ""}|${toolName ?? ""}|${config === DEFAULT_CONFIG ? "default" : JSON.stringify(config)}`;
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
	if (state.enabled) return state;

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

			const original = target.ctor.prototype.render;
			if (!state.originals.has(target.id)) {
				state.originals.set(target.id, original);
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
				return state;
			}
		}
	}

	state.enabled = state.patched.size > 0;
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
	return `Alps Pi: ${mode}\nassistantFrame: ${state.config.settings.assistantFrame}\npatched: ${patched}\nfailures: ${failures}`;
}
