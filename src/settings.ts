/** 功能：管理 Alps Pi 美化扩展的统一运行时设置 实现者：alps 实现日期：2026-05-27 */

export type ChromeFrameSettings = {
	/** 线框美化：控制是否启用消息外框 patch。 */
	enabled: boolean;
	/** Assistant 正文线框：控制普通 assistant 回复是否包裹外框。 */
	assistantFrame: boolean;
	/** Tool 极简模式：未展开的 LLM tool 只显示第一条有效文本行。 */
	toolCompactMode: boolean;
	/** 极简下收起 edit：允许 edit tool 也按极简模式展示。 */
	compactEditTool: boolean;
};

export type FixedBottomEditorSettings = {
	/** 固定输入框：只控制编辑器是否固定在底部。 */
	enabled: boolean;
};

export type BeautifiedInputSettings = {
	/** 美化输入框：控制输入框线框与嵌入边框状态。 */
	enabled: boolean;
};

export type BottomInputShortcutSettings = {
	/** Alt+S 暂存/恢复输入框。 */
	stashEditor: string;
	/** 复制输入框文本。 */
	copyEditor: string;
	/** 剪切输入框文本。 */
	cutEditor: string;
	/** 聊天区向上滚动。 */
	scrollChatUp: string;
	/** 聊天区向下滚动。 */
	scrollChatDown: string;
	/** 编辑器光标到开头。 */
	editorStart: string;
	/** 编辑器光标到末尾。 */
	editorEnd: string;
	/** 跳到上一条用户消息。 */
	jumpPreviousUserMessage: string;
	/** 跳到下一条用户消息。 */
	jumpNextUserMessage: string;
	/** 跳到上一条助手消息。 */
	jumpPreviousAssistantMessage: string;
	/** 跳到下一条助手消息。 */
	jumpNextAssistantMessage: string;
	/** 回到聊天底部。 */
	jumpChatBottom: string;
};

export type FixedBottomEditorStatus = {
	/** 用户期望的运行时开关状态。 */
	enabled: boolean;
	/** runtime 是否已完成 editor/footer/compositor 安装。 */
	installed: boolean;
	/** runtime 启停失败原因；失败时必须 fail closed。 */
	failure?: string;
};

export type AlpsPiSettings = {
	/** 线框美化功能配置。 */
	chromeFrame: ChromeFrameSettings;
	/** 固定底部输入框功能配置。 */
	fixedBottomEditor: FixedBottomEditorSettings;
	/** 输入框线框美化配置。 */
	beautifiedInput: BeautifiedInputSettings;
	/** 底部输入框快捷键配置。 */
	shortcuts: BottomInputShortcutSettings;
};

export const DEFAULT_SETTINGS: AlpsPiSettings = {
	chromeFrame: {
		enabled: false,
		assistantFrame: true,
		toolCompactMode: true,
		compactEditTool: false,
	},
	fixedBottomEditor: {
		enabled: true,
	},
	beautifiedInput: {
		enabled: true,
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
		shortcuts: { ...DEFAULT_SETTINGS.shortcuts },
	};
}
