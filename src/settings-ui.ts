/** 功能：提供 /alps-pi 官方 SettingsList 设置界面，集中管理功能开关与底部输入框快捷键 实现者：alps 实现日期：2026-05-28 */

import { Container, Key, matchesKey, SettingsList, type Component, type SettingItem, type SettingsListTheme } from "@earendil-works/pi-tui";
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

const MAIN_MAX_VISIBLE = 10;
const SHORTCUT_MAX_VISIBLE = 8;
const ON = "ON";
const OFF = "OFF";
const CONFIGURE = "configure";

type MainSettingId =
	| "chromeFrame.enabled"
	| "chromeFrame.assistantFrame"
	| "chromeFrame.toolCompactMode"
	| "chromeFrame.compactEditTool"
	| "fixedBottomEditor.enabled"
	| "bottomStatus.enabled"
	| "shortcuts";

function booleanLabel(value: boolean): string {
	return value ? ON : OFF;
}

function booleanValue(value: string): boolean {
	return value === ON;
}

function isShortcutKey(value: unknown): value is BottomInputShortcutKey {
	return typeof value === "string" && (SHORTCUT_KEYS as readonly string[]).includes(value);
}

function createNativeSettingsListTheme(theme: ThemeLike): SettingsListTheme {
	// 与 Pi 原生 getSettingsListTheme 保持同一套视觉规则；不直接调用它是为了避免扩展测试环境未初始化全局 theme。
	return {
		label: (text, selected) => selected ? theme.fg("accent", text) : text,
		value: (text, selected) => selected ? theme.fg("accent", text) : theme.fg("muted", text),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text) => theme.fg("dim", text),
	};
}

function getSettingsListInternals(list: SettingsList): { items?: SettingItem[]; filteredItems?: SettingItem[]; selectedIndex?: number; submenuComponent?: Component | null; closeSubmenu?: () => void } {
	// SettingsList 当前没有暴露 selected item/submenu 控制 API；所有内部访问集中在这里，避免散落到业务逻辑。
	return list as any;
}

function resetSettingsListSelection(list: SettingsList): void {
	const internals = getSettingsListInternals(list);
	internals.selectedIndex = 0;
	if (Array.isArray(internals.items)) internals.filteredItems = internals.items;
}

function findSettingsListItem(list: SettingsList, id: string): SettingItem | undefined {
	return getSettingsListInternals(list).items?.find((candidate) => candidate.id === id);
}

function getSelectedSettingsListItem(list: SettingsList): SettingItem | undefined {
	const internals = getSettingsListInternals(list);
	return typeof internals.selectedIndex === "number" ? internals.items?.[internals.selectedIndex] : undefined;
}

function hasSettingsListSubmenu(list: SettingsList): boolean {
	return Boolean(getSettingsListInternals(list).submenuComponent);
}

function closeSettingsListSubmenu(list: SettingsList): void {
	getSettingsListInternals(list).closeSubmenu?.();
}

class DynamicSettingsBorder implements Component {
	private readonly theme: ThemeLike;

	constructor(theme: ThemeLike) {
		this.theme = theme;
	}

	/** 按 Pi 原生 DynamicBorder 只渲染整宽横线，不绘制左右边框。 */
	render(width: number): string[] {
		return [this.theme.fg("border", "─".repeat(Math.max(1, width)))];
	}

	invalidate(): void {}
}

/** 统一设置面板：使用 Pi 官方 SettingsList，避免 overlay 合成与手写列表输入处理。 */
export class AlpsPiSettingsComponent extends Container {
	private readonly done?: () => void;
	private readonly ops: Required<SettingsPanelOps>;
	private readonly listTheme: SettingsListTheme;
	private readonly settingsList: SettingsList;
	private closed = false;

	constructor(theme: ThemeLike, done?: () => void, ops: SettingsPanelOps = {}) {
		super();
		this.listTheme = createNativeSettingsListTheme(theme);
		this.done = done;
		this.ops = {
			getState: ops.getState ?? getGlobalPatchState,
			enableChromeFrame: ops.enableChromeFrame ?? (() => enablePatch()),
			disableChromeFrame: ops.disableChromeFrame ?? (() => disablePatch()),
			setFixedBottomEditorEnabled: ops.setFixedBottomEditorEnabled ?? (() => undefined),
			setBottomStatusEnabled: ops.setBottomStatusEnabled ?? (() => undefined),
			onSettingsChanged: ops.onSettingsChanged ?? (() => undefined),
		};

		this.settingsList = new SettingsList(
			this.createMainItems(),
			MAIN_MAX_VISIBLE,
			this.listTheme,
			(id, newValue) => this.handleMainChange(id as MainSettingId, newValue),
			() => this.close(),
			{ enableSearch: true },
		);
		// 官方 SettingsList 只在内部维护 item 状态；这里按当前运行时状态同步一次，避免测试或外部回调先改 state 后再打开 UI 时出现陈旧 currentValue。
		this.syncAllMainValues();
		this.refreshBottomStatusDescription();
		resetSettingsListSelection(this.settingsList);
		this.addChild(new DynamicSettingsBorder(theme));
		this.addChild(this.settingsList);
		this.addChild(new DynamicSettingsBorder(theme));
	}

	/** 暴露内部列表，方便测试或未来接入更细粒度 focus。 */
	getSettingsList(): SettingsList {
		return this.settingsList;
	}

	/** 交给 SettingsList 处理导航、切换、submenu 与取消；主列表保留 q 关闭习惯。 */
	handleInput(data: string): void {
		if ((data === "q" || data === "Q" || matchesKey(data, Key.ctrl("c"))) && !this.hasActiveSubmenu()) {
			this.close();
			return;
		}
		this.settingsList.handleInput(data);
	}

	private createMainItems(): SettingItem[] {
		const settings = this.ops.getState().config.settings;
		return [
			{
				id: "chromeFrame.enabled",
				label: "线框美化",
				description: "控制消息、工具与 bash 外框",
				currentValue: booleanLabel(settings.chromeFrame.enabled),
				values: [ON, OFF],
			},
			{
				id: "chromeFrame.assistantFrame",
				label: "Assistant 正文线框",
				description: "控制 assistant 正文回复是否包线框",
				currentValue: booleanLabel(settings.chromeFrame.assistantFrame),
				values: [ON, OFF],
			},
			{
				id: "chromeFrame.toolCompactMode",
				label: "Tool 极简模式",
				description: "未展开 tool 只显示第一条有效文本行",
				currentValue: booleanLabel(settings.chromeFrame.toolCompactMode),
				values: [ON, OFF],
			},
			{
				id: "chromeFrame.compactEditTool",
				label: "极简下收起 edit",
				description: "允许 edit tool 也按极简模式展示",
				currentValue: booleanLabel(settings.chromeFrame.compactEditTool),
				values: [ON, OFF],
			},
			{
				id: "fixedBottomEditor.enabled",
				label: "固定输入框",
				description: "控制底部固定编辑器 runtime",
				currentValue: booleanLabel(settings.fixedBottomEditor.enabled),
				values: [ON, OFF],
			},
			{
				id: "bottomStatus.enabled",
				label: "底部状态栏",
				description: settings.fixedBottomEditor.enabled ? "显示模型、thinking、上下文和耗时" : "需要先开启固定输入框",
				currentValue: booleanLabel(settings.bottomStatus.enabled),
				values: [ON, OFF],
			},
			{
				id: "shortcuts",
				label: "快捷键设置",
				description: "管理底部输入框快捷键",
				currentValue: CONFIGURE,
				submenu: (_currentValue, done) => new ShortcutSettingsSubmenu(this.ops, () => done(), this.listTheme),
			},
		];
	}

	private handleMainChange(id: MainSettingId, newValue: string): void {
		const state = this.ops.getState();
		switch (id) {
			case "chromeFrame.enabled":
				if (booleanValue(newValue)) {
					this.ops.enableChromeFrame();
				} else {
					this.ops.disableChromeFrame();
				}
				this.syncMainValue(id, state.config.settings.chromeFrame.enabled);
				return;
			case "chromeFrame.assistantFrame":
				state.config.settings.chromeFrame.assistantFrame = booleanValue(newValue);
				this.ops.onSettingsChanged(state.config.settings);
				return;
			case "chromeFrame.toolCompactMode":
				state.config.settings.chromeFrame.toolCompactMode = booleanValue(newValue);
				this.ops.onSettingsChanged(state.config.settings);
				return;
			case "chromeFrame.compactEditTool":
				state.config.settings.chromeFrame.compactEditTool = booleanValue(newValue);
				this.ops.onSettingsChanged(state.config.settings);
				return;
			case "fixedBottomEditor.enabled": {
				const nextEnabled = booleanValue(newValue);
				state.config.settings.fixedBottomEditor.enabled = nextEnabled;
				const status = this.ops.setFixedBottomEditorEnabled(nextEnabled);
				if (status) state.config.settings.fixedBottomEditor.enabled = status.enabled;
				this.syncMainValue(id, state.config.settings.fixedBottomEditor.enabled);
				this.refreshBottomStatusDescription();
				return;
			}
			case "bottomStatus.enabled":
				state.config.settings.bottomStatus.enabled = booleanValue(newValue);
				this.ops.setBottomStatusEnabled(state.config.settings.bottomStatus.enabled);
				return;
		}
	}

	private syncAllMainValues(): void {
		const settings = this.ops.getState().config.settings;
		this.syncMainValue("chromeFrame.enabled", settings.chromeFrame.enabled);
		this.syncMainValue("chromeFrame.assistantFrame", settings.chromeFrame.assistantFrame);
		this.syncMainValue("chromeFrame.toolCompactMode", settings.chromeFrame.toolCompactMode);
		this.syncMainValue("chromeFrame.compactEditTool", settings.chromeFrame.compactEditTool);
		this.syncMainValue("fixedBottomEditor.enabled", settings.fixedBottomEditor.enabled);
		this.syncMainValue("bottomStatus.enabled", settings.bottomStatus.enabled);
	}

	private syncMainValue(id: MainSettingId, value: boolean): void {
		this.settingsList.updateValue(id, booleanLabel(value));
	}

	private refreshBottomStatusDescription(): void {
		const item = findSettingsListItem(this.settingsList, "bottomStatus.enabled");
		if (item) {
			item.description = this.ops.getState().config.settings.fixedBottomEditor.enabled ? "显示模型、thinking、上下文和耗时" : "需要先开启固定输入框";
		}
	}

	private hasActiveSubmenu(): boolean {
		return hasSettingsListSubmenu(this.settingsList);
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.done?.();
	}
}

class ShortcutStatusText implements Component {
	private text = "";

	/** 更新快捷键页底部提示；保持和 Pi 原生 SettingsList 的普通文本风格一致。 */
	setText(text: string): void {
		this.text = text;
	}

	render(_width: number): string[] {
		return this.text ? ["", `  ${this.text}`] : [];
	}

	invalidate(): void {}
}

/** 快捷键设置子页：复用 SettingsList 导航，捕获模式单独校验输入。 */
class ShortcutSettingsSubmenu extends Container {
	private readonly ops: Required<SettingsPanelOps>;
	private readonly onCancel: () => void;
	private readonly message: ShortcutStatusText;
	private readonly settingsList: SettingsList;

	constructor(ops: Required<SettingsPanelOps>, onCancel: () => void, listTheme: SettingsListTheme) {
		super();
		this.ops = ops;
		this.onCancel = onCancel;
		this.message = new ShortcutStatusText();
		this.settingsList = new SettingsList(
			this.createShortcutItems(),
			SHORTCUT_MAX_VISIBLE,
			listTheme,
			(id) => this.startCapture(id as BottomInputShortcutKey),
			onCancel,
		);
		this.addChild(this.settingsList);
		this.addChild(this.message);
		this.showHint();
	}

	handleInput(data: string): void {
		if (this.hasActiveCapture()) {
			if (matchesKey(data, Key.escape)) {
				this.settingsList.handleInput(data);
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				if (this.restoreSelectedShortcutDefault()) {
					this.closeActiveCapture();
				}
				return;
			}
			const key = this.getActiveCaptureKey();
			const shortcut = shortcutFromRawInput(data);
			if (!key || !shortcut) {
				this.showMessage("无法识别这个快捷键");
				return;
			}
			if (this.applyShortcut(key, shortcut, "已保存")) {
				this.closeActiveCapture();
			}
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			this.restoreSelectedShortcutDefault();
			return;
		}
		if (data === "q" || data === "Q") {
			this.onCancel();
			return;
		}
		this.settingsList.handleInput(data);
	}

	private createShortcutItems(): SettingItem[] {
		const shortcuts = this.ops.getState().config.settings.shortcuts;
		return SHORTCUT_KEYS.map((key) => ({
			id: key,
			label: SHORTCUT_LABELS[key],
			description: "Enter 捕获 · Backspace 默认 · Esc 返回",
			currentValue: shortcuts[key],
			submenu: (_currentValue, done) => {
				this.startCapture(key);
				return new ShortcutCaptureComponent(key, (message) => this.showMessage(message), done);
			},
		}));
	}

	private startCapture(key: BottomInputShortcutKey): void {
		this.showMessage(`正在设置：${SHORTCUT_LABELS[key]} · Esc 取消 · Backspace 默认`);
	}

	private restoreSelectedShortcutDefault(): boolean {
		const key = this.getSelectedShortcutKey();
		if (!key) return false;
		return this.restoreShortcutDefault(key);
	}

	private restoreShortcutDefault(key: BottomInputShortcutKey): boolean {
		return this.applyShortcut(key, DEFAULT_BOTTOM_INPUT_SHORTCUTS[key], "已恢复默认");
	}

	private applyShortcut(key: BottomInputShortcutKey, shortcut: string, successMessage: string): boolean {
		const settings = this.ops.getState().config.settings;
		const validation = validateShortcutChange(settings.shortcuts, key, shortcut);
		if (!validation.ok) {
			this.showMessage(validation.reason);
			return false;
		}
		settings.shortcuts[key] = validation.shortcut;
		this.settingsList.updateValue(key, validation.shortcut);
		this.ops.onSettingsChanged(settings);
		this.showMessage(successMessage);
		return true;
	}

	private hasActiveCapture(): boolean {
		return hasSettingsListSubmenu(this.settingsList);
	}

	private getActiveCaptureKey(): BottomInputShortcutKey | undefined {
		return this.getSelectedShortcutKey();
	}

	private closeActiveCapture(): void {
		closeSettingsListSubmenu(this.settingsList);
	}

	private getSelectedShortcutKey(): BottomInputShortcutKey | undefined {
		const item = getSelectedSettingsListItem(this.settingsList);
		return isShortcutKey(item?.id) ? item.id : undefined;
	}

	private showHint(): void {
		this.message.setText("Enter 捕获 · Backspace 默认 · Esc 返回");
	}

	private showMessage(text: string): void {
		this.message.setText(text);
	}
}

/** 捕获页只负责接收一个按键；实际校验和保存由父级快捷键列表统一处理。 */
class ShortcutCaptureComponent implements Component {
	private readonly shortcutKey: BottomInputShortcutKey;
	private readonly onMessage: (message: string) => void;
	private readonly onDone: () => void;

	constructor(shortcutKey: BottomInputShortcutKey, onMessage: (message: string) => void, onDone: () => void) {
		this.shortcutKey = shortcutKey;
		this.onMessage = onMessage;
		this.onDone = onDone;
	}

	render(_width: number): string[] {
		return [
			`正在设置：${SHORTCUT_LABELS[this.shortcutKey]}`,
			"",
			"请按新的快捷键",
			"Esc 取消 · Backspace 恢复默认",
		];
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.onMessage("已取消");
			this.onDone();
		}
	}
}

export function createSettingsComponent(theme: ThemeLike, done?: () => void, ops: SettingsPanelOps = {}): Component {
	return new AlpsPiSettingsComponent(theme, done, ops);
}
