/** 功能：管理 Alps Pi 美化扩展的统一运行时设置 实现者：alps 实现日期：2026-05-27 */

export type ChromeFrameSettings = {
	/** 线框美化：控制是否启用消息外框 patch。 */
	enabled: boolean;
	/** Assistant 正文线框：控制普通 assistant 回复是否包裹外框。 */
	assistantFrame: boolean;
};

export type FixedBottomEditorSettings = {
	/** 固定输入框：控制是否启用底部固定编辑器运行时。 */
	enabled: boolean;
};

export type BottomStatusSettings = {
	/** 底部状态栏：显示模型、thinking、总 token 和当前时间。 */
	enabled: boolean;
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
	/** 底部状态栏功能配置。 */
	bottomStatus: BottomStatusSettings;
};

export const DEFAULT_SETTINGS: AlpsPiSettings = {
	chromeFrame: {
		enabled: false,
		assistantFrame: true,
	},
	fixedBottomEditor: {
		enabled: true,
	},
	bottomStatus: {
		enabled: false,
	},
};

export function cloneDefaultSettings(): AlpsPiSettings {
	return {
		chromeFrame: { ...DEFAULT_SETTINGS.chromeFrame },
		fixedBottomEditor: { ...DEFAULT_SETTINGS.fixedBottomEditor },
		bottomStatus: { ...DEFAULT_SETTINGS.bottomStatus },
	};
}
