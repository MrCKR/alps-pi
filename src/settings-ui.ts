/** 功能：提供 /alps-pi 官方 SettingsList 设置界面，集中管理功能开关与底部输入框快捷键 实现者：alps 实现日期：2026-05-28 */

import { Container, Key, matchesKey, SettingsList, truncateToWidth, visibleWidth, type Component, type SettingItem, type SettingsListTheme } from "@earendil-works/pi-tui";
import { type PatchState, disablePatch, enablePatch, getGlobalPatchState } from "./features/chrome-frame/index.ts";
import type { AlpsPiSettings, AssistantFrameStyle, FixedBottomEditorStatus } from "./settings.ts";
import { ANIMATION_FPS_VALUES, ANIMATION_WIDTH_VALUES } from "./features/animations/settings.ts";
import { getAnimationsForCategory } from "./features/animations/registry.ts";
import { AnimationsPreviewComponent } from "./features/animations/preview.ts";
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
	setBeautifiedInputEnabled?: (enabled: boolean) => FixedBottomEditorStatus | void;
	onSettingsChanged?: (settings: AlpsPiSettings) => void;
	requestRender?: () => void;
};

const MAIN_MAX_VISIBLE = 10;
const ANIMATIONS_MAX_VISIBLE = 8;
const SHORTCUT_MAX_VISIBLE = 8;
const ON = "ON";
const OFF = "OFF";
const CONFIGURE = "configure";
const ASSISTANT_FRAME_STYLE_VALUES = ["BOX", "HORIZONTAL", "NONE"];

const SHORTCUT_DESCRIPTIONS: Record<BottomInputShortcutKey, string> = {
	stashEditor: "暂存或恢复当前输入框内容",
	copyEditor: "复制当前输入框文本",
	cutEditor: "剪切当前输入框文本",
	scrollChatUp: "聊天区向上滚动",
	scrollChatDown: "聊天区向下滚动",
	editorStart: "移动光标到输入框开头",
	editorEnd: "移动光标到输入框末尾",
	jumpPreviousUserMessage: "跳到上一条用户消息",
	jumpNextUserMessage: "跳到下一条用户消息",
	jumpPreviousAssistantMessage: "跳到上一条助手消息",
	jumpNextAssistantMessage: "跳到下一条助手消息",
	jumpChatBottom: "回到聊天底部",
};

type MainSettingId =
	| "chromeFrame.enabled"
	| "chromeFrame.assistantFrameStyle"
	| "chromeFrame.toolCompactMode"
	| "chromeFrame.compactEditTool"
	| "fixedBottomEditor.enabled"
	| "beautifiedInput.enabled"
	| "animations"
	| "shortcuts";

type AnimationsSettingId =
	| "animations.enabled"
	| "animations.randomMode"
	| "animations.thinking"
	| "animations.working"
	| "animations.tool"
	| "animations.width"
	| "animations.fps"
	| "animations.preview";

function booleanLabel(value: boolean): string {
	return value ? ON : OFF;
}

function booleanValue(value: string): boolean {
	return value === ON;
}

function assistantFrameStyleLabel(value: AssistantFrameStyle): string {
	return value.toUpperCase();
}

function assistantFrameStyleValue(value: string): AssistantFrameStyle {
	if (value === "HORIZONTAL") return "horizontal";
	if (value === "NONE") return "none";
	return "box";
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

function withSettingsListHint(base: SettingsListTheme, hint: string): SettingsListTheme {
	return {
		...base,
		// SettingsList 内置 hint 固定英文；这里统一为当前页面需要的一行英文操作说明。
		hint: (text) => base.hint(text.includes("Enter") || text.includes("Type to search") ? `  ${hint}` : text),
	};
}

function createSettingsListTheme(theme: ThemeLike, hint: string): SettingsListTheme {
	return withSettingsListHint(createNativeSettingsListTheme(theme), hint);
}

function safeFg(theme: ThemeLike, token: string, text: string, fallback = "text"): string {
	try {
		return theme.fg(token, text);
	} catch {
		try {
			return theme.fg(fallback, text);
		} catch {
			return text;
		}
	}
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

function getSelectedSettingsListItem(list: SettingsList): SettingItem | undefined {
	const internals = getSettingsListInternals(list);
	return typeof internals.selectedIndex === "number" ? internals.items?.[internals.selectedIndex] : undefined;
}

function hasSettingsListSubmenu(list: SettingsList): boolean {
	return Boolean(getSettingsListInternals(list).submenuComponent);
}

function closeSettingsListSubmenu(list: SettingsList): void {
	const submenu = getSettingsListInternals(list).submenuComponent as any;
	submenu?.dispose?.();
	getSettingsListInternals(list).closeSubmenu?.();
}

class FramedSettingsPanel implements Component {
	private readonly content: Component;
	private readonly theme: ThemeLike;

	constructor(content: Component, theme: ThemeLike) {
		this.content = content;
		this.theme = theme;
	}

	/** 将设置页包成完整线框，颜色跟随主题 borderAccent。 */
	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		if (safeWidth < 8) return this.content.render(safeWidth);
		const innerWidth = Math.max(1, safeWidth - 4);
		const contentLines = this.content.render(innerWidth);
		return [
			this.border("╭" + "─".repeat(Math.max(0, safeWidth - 2)) + "╮"),
			...contentLines.map((line) => this.contentLine(line, safeWidth)),
			this.border("╰" + "─".repeat(Math.max(0, safeWidth - 2)) + "╯"),
		];
	}

	invalidate(): void {
		this.content.invalidate?.();
	}

	handleInput(data: string): void {
		this.content.handleInput?.(data);
	}

	private contentLine(line: string, width: number): string {
		const innerWidth = Math.max(0, width - 4);
		const clipped = truncateToWidth(line, innerWidth, "", false);
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
		return this.border("│") + " " + clipped + padding + " " + this.border("│");
	}

	private border(text: string): string {
		return safeFg(this.theme, "borderAccent", text, "border");
	}
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
		this.listTheme = createSettingsListTheme(theme, "↑/↓ select · Enter/Space toggle · Esc/q close");
		this.done = done;
		this.ops = {
			getState: ops.getState ?? getGlobalPatchState,
			enableChromeFrame: ops.enableChromeFrame ?? (() => enablePatch()),
			disableChromeFrame: ops.disableChromeFrame ?? (() => disablePatch()),
			setFixedBottomEditorEnabled: ops.setFixedBottomEditorEnabled ?? (() => undefined),
			setBeautifiedInputEnabled: ops.setBeautifiedInputEnabled ?? (() => undefined),
			onSettingsChanged: ops.onSettingsChanged ?? (() => undefined),
			requestRender: ops.requestRender ?? (() => undefined),
		};

		this.settingsList = new SettingsList(
			this.createMainItems(),
			MAIN_MAX_VISIBLE,
			this.listTheme,
			(id, newValue) => this.handleMainChange(id as MainSettingId, newValue),
			() => this.close(),
			{ enableSearch: true },
		);
		// 官方 SettingsList 只在内部维护 item 状态；这里按当前运行时状态同步一次，避免测试或外部回调先改 state 后再打开 UI 时出现过期 currentValue。
		this.syncAllMainValues();
		resetSettingsListSelection(this.settingsList);
		this.addChild(new FramedSettingsPanel(this.settingsList, theme));
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
				label: "Message Frame",
				description: "控制消息、工具与 bash 外框",
				currentValue: booleanLabel(settings.chromeFrame.enabled),
				values: [ON, OFF],
			},
			{
				id: "chromeFrame.assistantFrameStyle",
				label: "Assistant Frame",
				description: "设置 assistant 正文为完整框、仅上下边框或无框",
				currentValue: assistantFrameStyleLabel(settings.chromeFrame.assistantFrameStyle),
				values: ASSISTANT_FRAME_STYLE_VALUES,
			},
			{
				id: "chromeFrame.toolCompactMode",
				label: "Compact Tools",
				description: "未展开 tool 只显示第一条有效文本行",
				currentValue: booleanLabel(settings.chromeFrame.toolCompactMode),
				values: [ON, OFF],
			},
			{
				id: "chromeFrame.compactEditTool",
				label: "Compact Edit",
				description: "允许 edit tool 也按极简模式展示",
				currentValue: booleanLabel(settings.chromeFrame.compactEditTool),
				values: [ON, OFF],
			},
			{
				id: "fixedBottomEditor.enabled",
				label: "Fixed Input",
				description: "控制底部固定编辑器 runtime",
				currentValue: booleanLabel(settings.fixedBottomEditor.enabled),
				values: [ON, OFF],
			},
			{
				id: "beautifiedInput.enabled",
				label: "Beautified Input",
				description: "控制输入框线框与嵌入边框状态",
				currentValue: booleanLabel(settings.beautifiedInput.enabled),
				values: [ON, OFF],
			},
			{
				id: "animations",
				label: "Animations",
				description: "配置底部与 hidden thinking 内置动画",
				currentValue: CONFIGURE,
				submenu: (_currentValue, done) => new AnimationsSettingsSubmenu(this.ops, () => done(), this.listTheme),
			},
			{
				id: "shortcuts",
				label: "Shortcuts",
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
			case "chromeFrame.assistantFrameStyle":
				state.config.settings.chromeFrame.assistantFrameStyle = assistantFrameStyleValue(newValue);
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
				// 开关显示用户偏好；runtime failure 仅作为状态返回，不回滚为 OFF。
				state.config.settings.fixedBottomEditor.enabled = nextEnabled;
				this.ops.setFixedBottomEditorEnabled(nextEnabled);
				this.syncMainValue(id, state.config.settings.fixedBottomEditor.enabled);
				return;
			}
			case "beautifiedInput.enabled": {
				state.config.settings.beautifiedInput.enabled = booleanValue(newValue);
				this.ops.setBeautifiedInputEnabled(state.config.settings.beautifiedInput.enabled);
				this.syncMainValue(id, state.config.settings.beautifiedInput.enabled);
				this.syncMainValue("fixedBottomEditor.enabled", state.config.settings.fixedBottomEditor.enabled);
				return;
			}
		}
	}

	private syncAllMainValues(): void {
		const settings = this.ops.getState().config.settings;
		this.syncMainValue("chromeFrame.enabled", settings.chromeFrame.enabled);
		this.syncMainValue("chromeFrame.assistantFrameStyle", settings.chromeFrame.assistantFrameStyle);
		this.syncMainValue("chromeFrame.toolCompactMode", settings.chromeFrame.toolCompactMode);
		this.syncMainValue("chromeFrame.compactEditTool", settings.chromeFrame.compactEditTool);
		this.syncMainValue("fixedBottomEditor.enabled", settings.fixedBottomEditor.enabled);
		this.syncMainValue("beautifiedInput.enabled", settings.beautifiedInput.enabled);
	}

	private syncMainValue(id: MainSettingId, value: boolean | AssistantFrameStyle): void {
		this.settingsList.updateValue(id, typeof value === "boolean" ? booleanLabel(value) : assistantFrameStyleLabel(value));
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

class AnimationsSettingsSubmenu extends Container {
	private readonly ops: Required<SettingsPanelOps>;
	private readonly onCancel: () => void;
	private readonly listTheme: SettingsListTheme;
	private readonly settingsList: SettingsList;

	constructor(ops: Required<SettingsPanelOps>, onCancel: () => void, listTheme: SettingsListTheme) {
		super();
		this.ops = ops;
		this.onCancel = onCancel;
		this.listTheme = listTheme;
		this.settingsList = new SettingsList(
			this.createAnimationItems(),
			ANIMATIONS_MAX_VISIBLE,
			withSettingsListHint(listTheme, "↑/↓ select · Enter/Space change · Esc back"),
			(id, newValue) => this.handleChange(id as AnimationsSettingId, newValue),
			onCancel,
		);
		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		if ((data === "q" || data === "Q") && !hasSettingsListSubmenu(this.settingsList)) {
			this.onCancel();
			return;
		}
		this.settingsList.handleInput(data);
	}

	private createAnimationItems(): SettingItem[] {
		const animations = this.ops.getState().config.settings.animations;
		const thinkingValues = getAnimationsForCategory("thinking").map((animation) => animation.name);
		const workingValues = getAnimationsForCategory("working").map((animation) => animation.name);
		return [
			{
				id: "animations.enabled",
				label: "Enabled",
				description: "启用底部与 hidden thinking 动画替换",
				currentValue: booleanLabel(animations.enabled),
				values: [ON, OFF],
			},
			{
				id: "animations.randomMode",
				label: "Random Mode",
				description: "每次按分类随机选择动画",
				currentValue: booleanLabel(animations.randomMode),
				values: [ON, OFF],
			},
			{
				id: "animations.thinking",
				label: "Thinking",
				description: "替换 Pi 原生 Thinking... 的动画",
				currentValue: animations.thinking,
				values: thinkingValues,
			},
			{
				id: "animations.working",
				label: "Working",
				description: "替换底部 Working... 的动画",
				currentValue: animations.working,
				values: workingValues,
			},
			{
				id: "animations.tool",
				label: "Tool",
				description: "tool 执行期底部动画",
				currentValue: animations.tool,
				values: workingValues,
			},
			{
				id: "animations.width",
				label: "Width",
				description: "动画渲染宽度",
				currentValue: String(animations.width),
				values: ANIMATION_WIDTH_VALUES.map(String),
			},
			{
				id: "animations.fps",
				label: "FPS",
				description: "动画刷新帧率",
				currentValue: String(animations.fps),
				values: ANIMATION_FPS_VALUES.map(String),
			},
			{
				id: "animations.preview",
				label: "Preview",
				description: "预览所有内置动画",
				currentValue: "open",
				submenu: (_currentValue, done) => new AnimationsPreviewComponent({
					settings: animations,
					theme: this.listThemeToTheme(),
					onClose: done,
					requestRender: this.ops.requestRender,
				}),
			},
		];
	}

	private listThemeToTheme(): ThemeLike {
		// 预览组件只消费 fg；bg 保持透明以满足完整主题接口。
		return {
			fg: (token: string, text: string) => token === "dim" ? this.listTheme.description(text) : this.listTheme.value(text, false),
			bg: (_token: string, text: string) => text,
		};
	}

	private handleChange(id: AnimationsSettingId, newValue: string): void {
		if (id === "animations.preview") return;
		const settings = this.ops.getState().config.settings;
		switch (id) {
			case "animations.enabled":
				settings.animations.enabled = booleanValue(newValue);
				break;
			case "animations.randomMode":
				settings.animations.randomMode = booleanValue(newValue);
				break;
			case "animations.thinking":
				settings.animations.thinking = newValue;
				break;
			case "animations.working":
				settings.animations.working = newValue;
				break;
			case "animations.tool":
				settings.animations.tool = newValue;
				break;
			case "animations.width":
				settings.animations.width = newValue === "full" || newValue === "default" ? newValue : Number(newValue);
				break;
			case "animations.fps":
				settings.animations.fps = Number(newValue);
				break;
		}
		this.ops.onSettingsChanged(settings);
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
			withSettingsListHint(listTheme, "↑/↓ select · Enter capture · Backspace default · Esc back"),
			(id) => this.startCapture(id as BottomInputShortcutKey),
			onCancel,
		);
		this.addChild(this.settingsList);
		this.addChild(this.message);
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
				this.showMessage("Unrecognized shortcut");
				return;
			}
			if (this.applyShortcut(key, shortcut, "Saved")) {
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
			description: SHORTCUT_DESCRIPTIONS[key],
			currentValue: shortcuts[key],
			submenu: (_currentValue, done) => {
				this.startCapture(key);
				return new ShortcutCaptureComponent(key, (message) => this.showMessage(message), done);
			},
		}));
	}

	private startCapture(key: BottomInputShortcutKey): void {
		this.showMessage(`Editing: ${SHORTCUT_LABELS[key]} · Esc cancel · Backspace default`);
	}

	private restoreSelectedShortcutDefault(): boolean {
		const key = this.getSelectedShortcutKey();
		if (!key) return false;
		return this.restoreShortcutDefault(key);
	}

	private restoreShortcutDefault(key: BottomInputShortcutKey): boolean {
		return this.applyShortcut(key, DEFAULT_BOTTOM_INPUT_SHORTCUTS[key], "Restored default");
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
			`Editing: ${SHORTCUT_LABELS[this.shortcutKey]}`,
			"",
			"Press a new shortcut",
		];
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.onMessage("Cancelled");
			this.onDone();
		}
	}
}

export function createSettingsComponent(theme: ThemeLike, done?: () => void, ops: SettingsPanelOps = {}): Component {
	return new AlpsPiSettingsComponent(theme, done, ops);
}
