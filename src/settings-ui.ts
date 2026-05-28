/** 功能：提供 /alps-pi 统一设置面板，集中管理功能开关与底部输入框快捷键 实现者：alps 实现日期：2026-05-28 */

import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type PatchState, disablePatch, enablePatch, getGlobalPatchState } from "./features/chrome-frame/index.ts";
import type { AlpsPiSettings, FixedBottomEditorStatus } from "./settings.ts";
import type { ThemeLike } from "./features/chrome-frame/styles.ts";
import {
	DEFAULT_BOTTOM_INPUT_SHORTCUTS,
	SHORTCUT_KEYS,
	SHORTCUT_LABELS,
	shortcutFromRawInput,
	validateShortcutChange,
	type BottomInputShortcutKey,
} from "./features/bottom-input/shortcuts.ts";

export type SettingsPanelOps = {
	getState?: () => PatchState;
	enableChromeFrame?: () => PatchState;
	disableChromeFrame?: () => PatchState;
	setFixedBottomEditorEnabled?: (enabled: boolean) => FixedBottomEditorStatus | void;
	setBottomStatusEnabled?: (enabled: boolean) => void;
	onSettingsChanged?: (settings: AlpsPiSettings) => void;
};

const OPTIONS = [
	"chromeFrame.enabled",
	"chromeFrame.assistantFrame",
	"chromeFrame.toolCompactMode",
	"chromeFrame.compactEditTool",
	"fixedBottomEditor.enabled",
	"bottomStatus.enabled",
	"shortcuts",
] as const;
type OptionId = (typeof OPTIONS)[number];
type PanelMode = "main" | "shortcuts" | "capture";

function padToWidth(line: string, width: number): string {
	const current = visibleWidth(line);
	return current >= width ? line : line + " ".repeat(width - current);
}

function booleanLabel(value: boolean): string {
	return value ? "ON" : "OFF";
}

/** 统一设置面板：方向键选择，Enter/Space 切换，Esc/q 关闭；快捷键页内 Esc 返回上级。 */
export class AlpsPiSettingsComponent {
	private readonly theme: ThemeLike;
	private readonly done?: () => void;
	private readonly ops: Required<SettingsPanelOps>;
	private mode: PanelMode = "main";
	private selectedIndex = 0;
	private shortcutIndex = 0;
	private captureKey: BottomInputShortcutKey | null = null;
	private message = "";
	private closed = false;

	constructor(theme: ThemeLike, done?: () => void, ops: SettingsPanelOps = {}) {
		this.theme = theme;
		this.done = done;
		this.ops = {
			getState: ops.getState ?? getGlobalPatchState,
			enableChromeFrame: ops.enableChromeFrame ?? (() => enablePatch()),
			disableChromeFrame: ops.disableChromeFrame ?? (() => disablePatch()),
			setFixedBottomEditorEnabled: ops.setFixedBottomEditorEnabled ?? (() => undefined),
			setBottomStatusEnabled: ops.setBottomStatusEnabled ?? (() => undefined),
			onSettingsChanged: ops.onSettingsChanged ?? (() => undefined),
		};
	}

	render(width: number): string[] {
		const safeWidth = Math.max(32, Math.floor(width));
		const innerWidth = Math.max(1, safeWidth - 4);
		const body = this.mode === "main"
			? this.renderMainBody(innerWidth)
			: this.renderShortcutBody(innerWidth);
		return [
			this.borderLine("╭", "╮", safeWidth),
			...body.map((line) => this.contentLine(line, innerWidth)),
			this.borderLine("╰", "╯", safeWidth),
		];
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.mode === "capture") {
			this.handleCaptureInput(data);
			return;
		}
		if (this.mode === "shortcuts") {
			this.handleShortcutListInput(data);
			return;
		}
		this.handleMainInput(data);
	}

	private renderMainBody(innerWidth: number): string[] {
		const state = this.ops.getState();
		const settings = state.config.settings;
		const title = this.theme.fg("accent", "Alps Pi 美化设置");
		const hint = this.theme.fg("muted", "↑/↓ 选择 · Enter/Space 切换/进入 · Esc/q 关闭");
		const bottomStatusDescription = settings.fixedBottomEditor.enabled
			? "显示模型、thinking、上下文、耗时和上个问题"
			: "需要先开启固定输入框";
		return [
			title,
			"",
			this.renderRow("线框美化", booleanLabel(settings.chromeFrame.enabled), "控制消息、工具与 bash 外框", this.selectedIndex === 0, innerWidth),
			this.renderRow("Assistant 正文线框", booleanLabel(settings.chromeFrame.assistantFrame), "控制 assistant 正文回复是否包线框", this.selectedIndex === 1, innerWidth),
			this.renderRow("Tool 极简模式", booleanLabel(settings.chromeFrame.toolCompactMode), "未展开 tool 只显示第一条有效文本行", this.selectedIndex === 2, innerWidth),
			this.renderRow("极简下收起 edit", booleanLabel(settings.chromeFrame.compactEditTool), "允许 edit tool 也按极简模式展示", this.selectedIndex === 3, innerWidth),
			this.renderRow("固定输入框", booleanLabel(settings.fixedBottomEditor.enabled), "控制底部固定编辑器 runtime", this.selectedIndex === 4, innerWidth),
			this.renderRow("底部状态栏", booleanLabel(settings.bottomStatus.enabled), bottomStatusDescription, this.selectedIndex === 5, innerWidth),
			this.renderRow("快捷键设置", "›", "管理底部输入框快捷键", this.selectedIndex === 6, innerWidth),
			"",
			this.message ? this.theme.fg("warning", this.message) : hint,
		];
	}

	private renderShortcutBody(innerWidth: number): string[] {
		const settings = this.ops.getState().config.settings;
		const title = this.theme.fg("accent", "快捷键设置");
		const hint = this.mode === "capture"
			? this.theme.fg("muted", "请按新的快捷键，Esc 取消，Backspace 恢复默认")
			: this.theme.fg("muted", "↑/↓ 选择 · Enter 捕获 · Backspace 默认 · Esc/q 返回");
		const rows = SHORTCUT_KEYS.map((key, index) => this.renderRow(
			SHORTCUT_LABELS[key],
			settings.shortcuts[key],
			"",
			this.shortcutIndex === index,
			innerWidth,
		));
		const captureLine = this.mode === "capture" && this.captureKey
			? this.theme.fg("accent", `正在设置：${SHORTCUT_LABELS[this.captureKey]}`)
			: "";
		return [
			title,
			"",
			...rows,
			"",
			captureLine,
			this.message ? this.theme.fg("warning", this.message) : hint,
		];
	}

	private handleMainInput(data: string): void {
		this.message = "";
		if (matchesKey(data, Key.escape) || data === "q" || data === "Q" || matchesKey(data, Key.ctrl("c"))) {
			this.close();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = this.selectedIndex === 0 ? OPTIONS.length - 1 : this.selectedIndex - 1;
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
			this.selectedIndex = (this.selectedIndex + 1) % OPTIONS.length;
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || data === " ") {
			this.toggle(OPTIONS[this.selectedIndex]!);
		}
	}

	private handleShortcutListInput(data: string): void {
		this.message = "";
		if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.mode = "main";
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.shortcutIndex = this.shortcutIndex === 0 ? SHORTCUT_KEYS.length - 1 : this.shortcutIndex - 1;
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
			this.shortcutIndex = (this.shortcutIndex + 1) % SHORTCUT_KEYS.length;
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			this.restoreCurrentShortcutDefault();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.captureKey = SHORTCUT_KEYS[this.shortcutIndex]!;
			this.mode = "capture";
		}
	}

	private handleCaptureInput(data: string): void {
		const key = this.captureKey;
		if (!key) {
			this.mode = "shortcuts";
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.mode = "shortcuts";
			this.captureKey = null;
			this.message = "已取消";
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			this.restoreCurrentShortcutDefault();
			this.mode = "shortcuts";
			this.captureKey = null;
			return;
		}
		const shortcut = shortcutFromRawInput(data);
		if (!shortcut) {
			this.message = "无法识别这个快捷键";
			return;
		}
		const settings = this.ops.getState().config.settings;
		const validation = validateShortcutChange(settings.shortcuts, key, shortcut);
		if (!validation.ok) {
			this.message = validation.reason;
			return;
		}
		settings.shortcuts[key] = validation.shortcut;
		this.ops.onSettingsChanged(settings);
		this.mode = "shortcuts";
		this.captureKey = null;
		this.message = "已保存";
	}

	private borderLine(left: string, right: string, width: number): string {
		return this.theme.fg("borderAccent", left + "─".repeat(Math.max(0, width - 2)) + right);
	}

	private contentLine(line: string, innerWidth: number): string {
		const clipped = truncateToWidth(line, innerWidth, "", false);
		return this.theme.fg("borderAccent", "│") + " " + padToWidth(clipped, innerWidth) + " " + this.theme.fg("borderAccent", "│");
	}

	private renderRow(label: string, value: string, description: string, selected: boolean, width: number): string {
		const cursor = selected ? this.theme.fg("accent", "›") : " ";
		const labelText = selected ? this.theme.fg("accent", label) : this.theme.fg("text", label);
		const valueToken = value === "ON" ? "success" : value === "OFF" ? "muted" : "accent";
		const valueText = this.theme.fg(valueToken, value.padEnd(Math.min(18, Math.max(3, value.length)), " "));
		const suffix = description ? `  ${this.theme.fg("muted", description)}` : "";
		const plain = `${cursor} ${labelText}  ${valueText}${suffix}`;
		return truncateToWidth(padToWidth(plain, width), width, "", false);
	}

	private toggle(option: OptionId): void {
		const state = this.ops.getState();
		if (option === "shortcuts") {
			this.mode = "shortcuts";
			this.message = "";
			return;
		}
		if (option === "chromeFrame.enabled") {
			state.config.settings.chromeFrame.enabled ? this.ops.disableChromeFrame() : this.ops.enableChromeFrame();
			return;
		}
		if (option === "chromeFrame.toolCompactMode") {
			state.config.settings.chromeFrame.toolCompactMode = !state.config.settings.chromeFrame.toolCompactMode;
			this.ops.onSettingsChanged(state.config.settings);
			return;
		}
		if (option === "chromeFrame.compactEditTool") {
			state.config.settings.chromeFrame.compactEditTool = !state.config.settings.chromeFrame.compactEditTool;
			this.ops.onSettingsChanged(state.config.settings);
			return;
		}
		if (option === "fixedBottomEditor.enabled") {
			const nextEnabled = !state.config.settings.fixedBottomEditor.enabled;
			state.config.settings.fixedBottomEditor.enabled = nextEnabled;
			const status = this.ops.setFixedBottomEditorEnabled(nextEnabled);
			if (status) state.config.settings.fixedBottomEditor.enabled = status.enabled;
			return;
		}
		if (option === "bottomStatus.enabled") {
			const nextEnabled = !state.config.settings.bottomStatus.enabled;
			state.config.settings.bottomStatus.enabled = nextEnabled;
			this.ops.setBottomStatusEnabled(nextEnabled);
			return;
		}
		state.config.settings.chromeFrame.assistantFrame = !state.config.settings.chromeFrame.assistantFrame;
		this.ops.onSettingsChanged(state.config.settings);
	}

	private restoreCurrentShortcutDefault(): void {
		const key = SHORTCUT_KEYS[this.shortcutIndex]!;
		const settings = this.ops.getState().config.settings;
		const validation = validateShortcutChange(settings.shortcuts, key, DEFAULT_BOTTOM_INPUT_SHORTCUTS[key]);
		if (!validation.ok) {
			this.message = validation.reason;
			return;
		}
		settings.shortcuts[key] = validation.shortcut;
		this.ops.onSettingsChanged(settings);
		this.message = "已恢复默认";
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.done?.();
	}
}

export function createSettingsComponent(theme: ThemeLike, done?: () => void, ops: SettingsPanelOps = {}): AlpsPiSettingsComponent {
	return new AlpsPiSettingsComponent(theme, done, ops);
}
