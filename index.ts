/** 功能：pi 美化扩展入口，默认启用消息外框并注册控制命令 实现者：alps 实现日期：2026-05-26 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAlpsPiCommand } from "./src/commands.ts";
import { disablePatch, enablePatch } from "./src/patch.ts";

export default function alpsPi(pi: ExtensionAPI) {
	// 默认启用运行时外框；命令仍可通过 /alps-pi disable 临时回滚。
	enablePatch();
	registerAlpsPiCommand(pi);

	// runtime shutdown/reload 时尽力恢复，避免热重载留下旧 render。
	pi.on("session_shutdown", () => {
		disablePatch();
	});
}
