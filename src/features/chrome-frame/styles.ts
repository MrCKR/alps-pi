/** 功能：定义 alps pi 美化扩展的类型、样式 token 与 label 映射 实现者：alps 实现日期：2026-05-26 */

import { DEFAULT_SETTINGS, type AlpsPiSettings } from "../../settings.ts";

export type ThemeLike = {
	fg(token: string, text: string): string;
	bg(token: string, text: string): string;
	bold?(text: string): string;
};

export type ChromeKind =
	| "user"
	| "assistant"
	| "custom"
	| "skill"
	| "compaction"
	| "branch"
	| "tool"
	| "toolPending"
	| "toolSuccess"
	| "toolError"
	| "bash"
	| "working";

export type ChromeStatus = "pending" | "success" | "error";

export type ChromeStyle = {
	bg: string;
	border: string;
	label: string;
	text: string;
};

export type LabelOptions = {
	toolName?: string;
	status?: ChromeStatus;
};

export type ChromeConfig = {
	styles: Record<string, ChromeStyle>;
	settings: AlpsPiSettings;
};

export const DEFAULT_CONFIG: ChromeConfig = {
	settings: DEFAULT_SETTINGS,
	styles: {
		user: { bg: "userMessageBg", border: "borderAccent", label: "accent", text: "userMessageText" },
		assistant: { bg: "customMessageBg", border: "borderMuted", label: "accent", text: "text" },
		custom: { bg: "customMessageBg", border: "borderAccent", label: "customMessageLabel", text: "customMessageText" },
		skill: { bg: "customMessageBg", border: "borderAccent", label: "customMessageLabel", text: "customMessageText" },
		compaction: { bg: "selectedBg", border: "borderMuted", label: "muted", text: "text" },
		branch: { bg: "selectedBg", border: "borderMuted", label: "muted", text: "text" },
		toolPending: { bg: "toolPendingBg", border: "borderAccent", label: "toolTitle", text: "toolOutput" },
		toolSuccess: { bg: "toolSuccessBg", border: "success", label: "toolTitle", text: "toolOutput" },
		toolError: { bg: "toolErrorBg", border: "error", label: "toolTitle", text: "toolOutput" },
		bash: { bg: "toolPendingBg", border: "borderAccent", label: "toolTitle", text: "toolOutput" },
		working: { bg: "selectedBg", border: "borderAccent", label: "accent", text: "muted" },
	},
};

export function normalizeKind(kind: ChromeKind, options: LabelOptions = {}): keyof typeof DEFAULT_CONFIG.styles {
	if (kind === "tool" || kind === "bash") {
		if (options.status === "error") return "toolError";
		if (options.status === "success") return "toolSuccess";
		if (options.status === "pending") return "toolPending";
	}
	return kind;
}

export function getChromeStyle(kind: ChromeKind, options: LabelOptions = {}, config: ChromeConfig = DEFAULT_CONFIG): ChromeStyle {
	return config.styles[normalizeKind(kind, options)] ?? config.styles.assistant;
}

export function getChromeLabel(kind: ChromeKind, options: LabelOptions = {}): string {
	switch (kind) {
		case "user":
			return "USER";
		case "assistant":
			return "ASSISTANT";
		case "custom":
			return "CUSTOM";
		case "skill":
			return "SKILL";
		case "compaction":
			return "COMPACT";
		case "branch":
			return "BRANCH";
		case "bash":
			return "BASH";
		case "working":
			return "WORKING";
		case "tool":
		case "toolPending":
		case "toolSuccess":
		case "toolError": {
			const name = options.toolName ? ` ${options.toolName}` : "";
			const status = kind === "toolSuccess" || options.status === "success" ? " ✓" : kind === "toolError" || options.status === "error" ? " ✗" : "";
			return `TOOL${name}${status}`;
		}
	}
}

