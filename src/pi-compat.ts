/** 功能：集中管理 Alps Pi 对宿主 Pi 0.84+ 公开运行时能力的检测与构造器引用。 */

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

export const PI_COMPONENTS = {
	UserMessageComponent,
	AssistantMessageComponent,
	CustomMessageComponent,
	SkillInvocationMessageComponent,
	CompactionSummaryMessageComponent,
	BranchSummaryMessageComponent,
	ToolExecutionComponent,
	BashExecutionComponent,
} as const;

export type PiTuiMode = "regular" | "fullscreen";

export type PiComponentRegistry = Record<string, any>;

export type PiRuntimeCapabilities = {
	chromeFrame: {
		supported: boolean;
		failures: Map<string, string>;
	};
	animations: {
		supported: boolean;
		failure?: string;
	};
	tui: {
		supported: boolean;
		failure?: string;
	};
	tuiMode?: PiTuiMode;
};

export function isTuiSessionContext(ctx: any): boolean {
	return ctx?.mode === "tui" && ctx?.hasUI === true;
}

export function readPiTuiMode(tui: any): PiTuiMode | undefined {
	try {
		return tui?.mode === "regular" || tui?.mode === "fullscreen" ? tui.mode : undefined;
	} catch {
		return undefined;
	}
}

export function inspectPiRuntimeCapabilities(tui?: any, components: PiComponentRegistry = PI_COMPONENTS): PiRuntimeCapabilities {
	const failures = new Map<string, string>();
	for (const [id, ctor] of Object.entries(components)) {
		if (!ctor) {
			failures.set(id, "component constructor missing");
			continue;
		}
		if (!ctor.prototype || typeof ctor.prototype.render !== "function") {
			failures.set(id, "prototype.render missing");
		}
	}

	const assistantPrototype = components.AssistantMessageComponent?.prototype as any;
	const animationsFailure = typeof assistantPrototype?.updateContent === "function"
		? undefined
		: "AssistantMessageComponent.prototype.updateContent missing";

	const tuiMode = readPiTuiMode(tui);
	const tuiFailure = tui !== undefined && tuiMode === undefined ? "unsupported Pi TUI renderer mode" : undefined;

	return {
		chromeFrame: {
			supported: failures.size === 0,
			failures,
		},
		animations: {
			supported: animationsFailure === undefined,
			failure: animationsFailure,
		},
		tui: {
			supported: tuiFailure === undefined,
			failure: tuiFailure,
		},
		tuiMode,
	};
}

export function formatPiCapabilityFailures(capabilities: PiRuntimeCapabilities): string[] {
	const failures = [...capabilities.chromeFrame.failures].map(([id, reason]) => `chrome-frame ${id}: ${reason}`);
	if (capabilities.animations.failure) failures.push(`animations: ${capabilities.animations.failure}`);
	if (capabilities.tui.failure) failures.push(`tui: ${capabilities.tui.failure}`);
	return failures;
}
