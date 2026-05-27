/** 功能：管理 Alps Pi 美化扩展的统一运行时设置 实现者：alps 实现日期：2026-05-27 */

export type ChromeFrameSettings = {
	/** 线框美化：控制是否启用消息外框 patch。 */
	enabled: boolean;
	/** Assistant 正文线框：控制普通 assistant 回复是否包裹外框。 */
	assistantFrame: boolean;
};

export type AlpsPiSettings = {
	/** 线框美化功能配置。 */
	chromeFrame: ChromeFrameSettings;
};

export const DEFAULT_SETTINGS: AlpsPiSettings = {
	chromeFrame: {
		enabled: false,
		assistantFrame: true,
	},
};

export function cloneDefaultSettings(): AlpsPiSettings {
	return {
		chromeFrame: { ...DEFAULT_SETTINGS.chromeFrame },
	};
}
