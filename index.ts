/** 功能：pi 美化扩展入口，默认启用消息外框并注册 fixed editor runtime 生命周期 实现者：alps 实现日期：2026-05-26 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAlpsPiCommand } from "./src/commands.ts";
import { disablePatch, enablePatch, getGlobalPatchState } from "./src/features/chrome-frame/index.ts";
import { createFixedBottomEditorRuntime, type FixedBottomEditorRuntime } from "./src/features/fixed-bottom-editor/index.ts";

export type AlpsPiRuntimeDeps = {
	/** 测试注入点：生产环境使用模块级 fixed bottom editor runtime。 */
	fixedBottomEditorRuntime?: FixedBottomEditorRuntime;
};

const defaultFixedBottomEditorRuntime = createFixedBottomEditorRuntime();

/** 注册扩展入口；deps 仅供生命周期测试注入，生产环境不传。 */
export function registerAlpsPiExtension(pi: ExtensionAPI, deps: AlpsPiRuntimeDeps = {}) {
	const fixedBottomEditorRuntime = deps.fixedBottomEditorRuntime ?? defaultFixedBottomEditorRuntime;

	// 默认启用运行时外框；固定输入框仍默认关闭，只由设置面板开关控制。
	enablePatch();
	registerAlpsPiCommand(pi, {
		setFixedBottomEditorEnabled: (enabled) => {
			const state = getGlobalPatchState();
			state.config.settings.fixedBottomEditor.enabled = enabled;
			const status = fixedBottomEditorRuntime.setEnabled(enabled);
			state.config.settings.fixedBottomEditor.enabled = status.enabled;
			return status;
		},
		getFixedBottomEditorStatus: () => fixedBottomEditorRuntime.getStatus(),
	});

	// session_start 保存当前 ctx；若设置已打开，则立即尝试安装 fixed editor。
	pi.on("session_start", (_event: any, ctx: any) => {
		fixedBottomEditorRuntime.bindSession(ctx);
		const state = getGlobalPatchState();
		if (state.config.settings.fixedBottomEditor.enabled) {
			const status = fixedBottomEditorRuntime.setEnabled(true);
			state.config.settings.fixedBottomEditor.enabled = status.enabled;
		}
	});

	// runtime shutdown/reload 时先恢复 editor/footer/compositor，并保证固定输入框回到默认关闭。
	pi.on("session_shutdown", () => {
		try {
			fixedBottomEditorRuntime.dispose();
		} finally {
			getGlobalPatchState().config.settings.fixedBottomEditor.enabled = false;
			disablePatch();
		}
	});
}

export default function alpsPi(pi: ExtensionAPI) {
	registerAlpsPiExtension(pi);
}
