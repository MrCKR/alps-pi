/** 功能：提供 /alps-pi 设置面板，只保留总开关与正文线框两个选项 实现者：alps 实现日期：2026-05-26 */

import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type PatchState, disablePatch, enablePatch, getGlobalPatchState } from "./patch.ts";
import type { ThemeLike } from "./styles.ts";

export type SettingsPanelOps = {
	getState?: () => PatchState;
	enable?: () => PatchState;
	disable?: () => PatchState;
};

const OPTIONS = ["patchEnabled", "assistantFrame"] as const;
type OptionId = (typeof OPTIONS)[number];

function padToWidth(line: string, width: number): string {
	const current = visibleWidth(line);
	return current >= width ? line : line + " ".repeat(width - current);
}

function booleanLabel(value: boolean): string {
	return value ? "ON" : "OFF";
}

/** 设置面板：方向键选择，Enter/Space 切换，Esc/q 关闭。 */
export class AlpsPiSettingsComponent {
	private readonly theme: ThemeLike;
	private readonly done?: () => void;
	private readonly ops: Required<SettingsPanelOps>;
	private selectedIndex = 0;
	private closed = false;

	constructor(theme: ThemeLike, done?: () => void, ops: SettingsPanelOps = {}) {
		this.theme = theme;
		this.done = done;
		this.ops = {
			getState: ops.getState ?? getGlobalPatchState,
			enable: ops.enable ?? (() => enablePatch()),
			disable: ops.disable ?? (() => disablePatch()),
		};
	}

	render(width: number): string[] {
		const safeWidth = Math.max(32, Math.floor(width));
		const innerWidth = Math.max(1, safeWidth - 4);
		const state = this.ops.getState();
		const title = this.theme.fg("accent", "Alps Pi 美化设置");
		const hint = this.theme.fg("muted", "↑/↓ 选择 · Enter/Space 切换 · Esc/q 关闭");
		const body = [
			title,
			"",
			this.renderRow("总开关", booleanLabel(state.enabled), "控制所有美化线框 patch", this.selectedIndex === 0, innerWidth),
			this.renderRow("正文线框", booleanLabel(state.config.settings.assistantFrame), "控制 assistant 正文回复是否包线框", this.selectedIndex === 1, innerWidth),
			"",
			hint,
		];
		return [
			this.borderLine("╭", "╮", safeWidth),
			...body.map((line) => this.contentLine(line, innerWidth)),
			this.borderLine("╰", "╯", safeWidth),
		];
	}

	invalidate(): void {}

	handleInput(data: string): void {
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
		const valueToken = value === "ON" ? "success" : "muted";
		const valueText = this.theme.fg(valueToken, value.padEnd(3, " "));
		const plain = `${cursor} ${labelText}  ${valueText}  ${this.theme.fg("muted", description)}`;
		return truncateToWidth(padToWidth(plain, width), width, "", false);
	}

	private toggle(option: OptionId): void {
		const state = this.ops.getState();
		if (option === "patchEnabled") {
			state.enabled ? this.ops.disable() : this.ops.enable();
			return;
		}
		state.config.settings.assistantFrame = !state.config.settings.assistantFrame;
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
