/** 功能：保留 bottom-status 兼容入口，实际委托统一 bottom-input runtime 实现者：alps 实现日期：2026-05-28 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBottomInputRuntime,
	isStashShortcutInput,
	type BottomInputRuntime,
} from "../bottom-input/index.ts";

export type BottomStatusRuntime = BottomInputRuntime;

/** 创建兼容 runtime；不再单独注册 above/below widget。 */
export function createBottomStatusRuntime(options: Parameters<typeof createBottomInputRuntime>[0] = {}): BottomStatusRuntime {
	return createBottomInputRuntime(options);
}

/** 注册 Alt+S 快捷键；raw input 由 bottom-input runtime 统一处理。 */
export function registerBottomStatusShortcuts(pi: ExtensionAPI, runtime: BottomStatusRuntime): void {
	pi.registerShortcut?.("alt+s", {
		description: "暂存/恢复当前输入框文本",
		handler: (ctx: any) => {
			runtime.stashOrRestoreEditorText(ctx);
		},
	});
}

export { isStashShortcutInput };
