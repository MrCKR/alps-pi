/** 功能：为底部输入框选择 Nerd Font 或 ASCII 图标 实现者：alps 实现日期：2026-05-28 */

export type BottomInputIconSet = {
	/** 模型图标；ASCII 模式为空，保证纯文本可读。 */
	model: string;
	/** 耗时图标；ASCII 模式保留原有文本符号。 */
	time: string;
};

export const NERD_BOTTOM_INPUT_ICONS: BottomInputIconSet = {
	model: "󰚩",
	time: "󰥔",
};

export const ASCII_BOTTOM_INPUT_ICONS: BottomInputIconSet = {
	model: "",
	time: "◷",
};

/** 根据环境变量与常见终端名判断是否启用 Nerd Font。 */
export function hasBottomInputNerdFont(env: NodeJS.ProcessEnv = process.env): boolean {
	const alpsOverride = parseBooleanEnv(env.ALPS_PI_NERD_FONT);
	if (alpsOverride !== undefined) return alpsOverride;
	const powerlineOverride = parseBooleanEnv(env.POWERLINE_NERD_FONTS);
	if (powerlineOverride !== undefined) return powerlineOverride;
	if (env.GHOSTTY_RESOURCES_DIR) return true;

	const terminalName = `${env.TERM_PROGRAM ?? ""} ${env.TERM ?? ""}`.toLowerCase();
	return ["iterm", "wezterm", "kitty", "ghostty", "alacritty"].some((name) => terminalName.includes(name));
}

/** 读取当前图标集；图标只是增强，不影响 ASCII 文本含义。 */
export function getBottomInputIcons(env: NodeJS.ProcessEnv = process.env): BottomInputIconSet {
	return hasBottomInputNerdFont(env) ? NERD_BOTTOM_INPUT_ICONS : ASCII_BOTTOM_INPUT_ICONS;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
	if (value === "1") return true;
	if (value === "0") return false;
	return undefined;
}
