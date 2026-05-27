/** 功能：检测 Kitty / iTerm 图片 escape 行，避免普通文本包装破坏图片协议 实现者：alps 实现日期：2026-05-26 */

const KITTY_IMAGE_PREFIX = "\x1b_G";
const ITERM_IMAGE_PREFIX = "\x1b]1337;File=";

export function isImageEscapeLine(line: string): boolean {
	return line.includes(KITTY_IMAGE_PREFIX) || line.includes(ITERM_IMAGE_PREFIX);
}

export function containsImageLine(lines: readonly string[]): boolean {
	return lines.some(isImageEscapeLine);
}
