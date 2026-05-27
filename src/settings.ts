/** 功能：管理 alps pi 美化扩展的运行时设置 实现者：alps 实现日期：2026-05-26 */

export type AlpsPiSettings = {
	/** 总开关：控制是否启用美化线框 patch。 */
	patchEnabled: boolean;
	/** 正文线框：控制普通 assistant 回复是否包裹外框。 */
	assistantFrame: boolean;
};

export const DEFAULT_SETTINGS: AlpsPiSettings = {
	patchEnabled: true,
	assistantFrame: true,
};

export function cloneDefaultSettings(): AlpsPiSettings {
	return { ...DEFAULT_SETTINGS };
}
