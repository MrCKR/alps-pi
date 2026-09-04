/** 功能：管理 Alps Pi 美化扩展的统一运行时设置 实现者：alps 实现日期：2026-05-27 */

import { cloneDefaultInputMetricsSettings, type InputMetricsSettings } from "./features/bottom-input/metrics.ts";

export type { InputMetricsSettings } from "./features/bottom-input/metrics.ts";

export type ToolDisplayMode = "off" | "compact" | "collapsed";

export function normalizeToolDisplayMode(value: unknown, fallback: ToolDisplayMode = "compact"): ToolDisplayMode {
	if (value === true) return "compact";
	if (value === false) return "off";
	return value === "off" || value === "compact" || value === "collapsed" ? value : fallback;
}

export type ChromeFrameSettings = {
	/** Alps Pi 美化总开关：统一门控消息线框、输入框美化与动画。 */
	enabled: boolean;
	/** Assistant 正文线框：控制普通 assistant 回复是否包裹外框。 */
	assistantFrame: boolean;
	/** Tool 展示模式：关闭、逐项极简或连续操作聚合。 */
	toolCompactMode: ToolDisplayMode;
	/** 极简下收起 edit：允许 edit tool 也按极简模式展示。 */
	compactEditTool: boolean;
};

export type FixedBottomEditorSettings = {
	/** 0.1.x 回滚兼容字段；0.2.0 runtime 不读取或改写。 */
	enabled: boolean;
};

export type BeautifiedInputSettings = {
	/** 美化输入框：控制输入框线框与嵌入边框状态。 */
	enabled: boolean;
};

export type FooterSettings = {
	/** Alps Footer：控制是否接管 Pi 底部 footer 区域。 */
	enabled: boolean;
};

export type AnimationsSettings = {
	/** 内置 Animations：控制底部 working/thinking/tool 与 hidden thinking 动画替换。 */
	enabled: boolean;
	/** 随机模式：在同分类动画中随机挑选。 */
	randomMode: boolean;
	/** Working 动画配置；用于接管底部 Working... 状态。 */
	working: string;
	/** Thinking 动画配置；用于底部 thinking phase 与 hidden thinking label。 */
	thinking: string;
	/** Tool 动画配置；用于 tool 执行期底部动画。 */
	tool: string;
	/** 动画宽度。 */
	width: "full" | "default" | number;
	/** 动画帧率。 */
	fps: number;
};

export type BottomInputShortcutSettings = {
	/** Alt+S 暂存/恢复输入框。 */
	stashEditor: string;
	/** 复制输入框文本。 */
	copyEditor: string;
	/** 剪切输入框文本。 */
	cutEditor: string;
	/** 0.1.x 回滚兼容字段；现代 runtime 由 Pi 管理 transcript 滚动。 */
	scrollChatUp: string;
	/** 0.1.x 回滚兼容字段；现代 runtime 由 Pi 管理 transcript 滚动。 */
	scrollChatDown: string;
	/** 编辑器光标到开头。 */
	editorStart: string;
	/** 编辑器光标到末尾。 */
	editorEnd: string;
	/** 0.1.x 回滚兼容字段；现代 runtime 不执行 transcript 跳转。 */
	jumpPreviousUserMessage: string;
	/** 0.1.x 回滚兼容字段；现代 runtime 不执行 transcript 跳转。 */
	jumpNextUserMessage: string;
	/** 0.1.x 回滚兼容字段；现代 runtime 不执行 transcript 跳转。 */
	jumpPreviousAssistantMessage: string;
	/** 0.1.x 回滚兼容字段；现代 runtime 不执行 transcript 跳转。 */
	jumpNextAssistantMessage: string;
	/** 0.1.x 回滚兼容字段；现代 runtime 不执行 transcript 跳转。 */
	jumpChatBottom: string;
};

export type AlpsPiSettings = {
	/** 美化总开关与消息线框子项配置。 */
	chromeFrame: ChromeFrameSettings;
	/** 仅为 0.1.x 回滚保留的 legacy 配置，不参与现代 runtime。 */
	fixedBottomEditor: FixedBottomEditorSettings;
	/** 输入框线框美化配置。 */
	beautifiedInput: BeautifiedInputSettings;
	/** 输入框边框内嵌指标配置。 */
	inputMetrics: InputMetricsSettings;
	/** 底部 Footer 配置。 */
	footer: FooterSettings;
	/** 内置 Animations 配置。 */
	animations: AnimationsSettings;
	/** 底部输入框快捷键配置。 */
	shortcuts: BottomInputShortcutSettings;
};

export const DEFAULT_SETTINGS: AlpsPiSettings = {
	chromeFrame: {
		enabled: true,
		assistantFrame: true,
		toolCompactMode: "compact",
		compactEditTool: false,
	},
	fixedBottomEditor: {
		enabled: true,
	},
	beautifiedInput: {
		enabled: true,
	},
	inputMetrics: cloneDefaultInputMetricsSettings(),
	footer: {
		enabled: true,
	},
	animations: {
		enabled: true,
		randomMode: false,
		working: "crush",
		thinking: "shimmer",
		tool: "pipeline",
		width: "default",
		fps: 16,
	},
	shortcuts: {
		stashEditor: "alt+s",
		copyEditor: "ctrl+alt+c",
		cutEditor: "ctrl+alt+x",
		scrollChatUp: "super+up",
		scrollChatDown: "super+down",
		editorStart: "super+shift+up",
		editorEnd: "super+shift+down",
		jumpPreviousUserMessage: "ctrl+shift+u",
		jumpNextUserMessage: "ctrl+shift+i",
		jumpPreviousAssistantMessage: "ctrl+alt+,",
		jumpNextAssistantMessage: "ctrl+alt+.",
		jumpChatBottom: "ctrl+shift+g",
	},
};

export function cloneDefaultSettings(): AlpsPiSettings {
	return {
		chromeFrame: { ...DEFAULT_SETTINGS.chromeFrame },
		fixedBottomEditor: { ...DEFAULT_SETTINGS.fixedBottomEditor },
		beautifiedInput: { ...DEFAULT_SETTINGS.beautifiedInput },
		inputMetrics: { ...DEFAULT_SETTINGS.inputMetrics },
		footer: { ...DEFAULT_SETTINGS.footer },
		animations: { ...DEFAULT_SETTINGS.animations },
		shortcuts: { ...DEFAULT_SETTINGS.shortcuts },
	};
}
