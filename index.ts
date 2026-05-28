/** 功能：pi 美化扩展入口，默认启用消息外框并注册 fixed editor runtime 生命周期 实现者：alps 实现日期：2026-05-26 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAlpsPiCommand } from "./src/commands.ts";
import { disablePatch, enablePatch, getGlobalPatchState } from "./src/features/chrome-frame/index.ts";
import { cloneSettings, readPersistedSettings, writePersistedSettings } from "./src/settings-store.ts";
import { createBottomStatusRuntime, registerBottomStatusShortcuts, type BottomStatusRuntime } from "./src/features/bottom-status/index.ts";
import { createFixedBottomEditorRuntime, type FixedBottomEditorRuntime } from "./src/features/fixed-bottom-editor/index.ts";

export type AlpsPiRuntimeDeps = {
	/** 测试注入点：生产环境使用模块级 fixed bottom editor runtime。 */
	fixedBottomEditorRuntime?: FixedBottomEditorRuntime;
	/** 测试注入点：生产环境使用模块级 bottom status runtime。 */
	bottomStatusRuntime?: BottomStatusRuntime;
};

const defaultFixedBottomEditorRuntime = createFixedBottomEditorRuntime();
const defaultBottomStatusRuntime = createBottomStatusRuntime();

/** 注册扩展入口；deps 仅供生命周期测试注入，生产环境不传。 */
export function registerAlpsPiExtension(pi: ExtensionAPI, deps: AlpsPiRuntimeDeps = {}) {
	const fixedBottomEditorRuntime = deps.fixedBottomEditorRuntime ?? defaultFixedBottomEditorRuntime;
	const bottomStatusRuntime = deps.bottomStatusRuntime ?? defaultBottomStatusRuntime;

	const state = getGlobalPatchState();
	const persistedSettings = readPersistedSettings();
	state.config.settings.chromeFrame.enabled = persistedSettings.chromeFrame.enabled;
	state.config.settings.chromeFrame.assistantFrame = persistedSettings.chromeFrame.assistantFrame;
	state.config.settings.chromeFrame.toolCompactMode = persistedSettings.chromeFrame.toolCompactMode;
	state.config.settings.chromeFrame.compactEditTool = persistedSettings.chromeFrame.compactEditTool;
	state.config.settings.fixedBottomEditor.enabled = persistedSettings.fixedBottomEditor.enabled;
	state.config.settings.bottomStatus.enabled = persistedSettings.bottomStatus.enabled;

	// 消息线框按持久化设置启停；固定输入框和底部状态栏由 session_start 在 UI 可用后安装。
	if (state.config.settings.chromeFrame.enabled) {
		enablePatch();
	} else {
		disablePatch();
	}
	registerAlpsPiCommand(pi, {
		setFixedBottomEditorEnabled: (enabled, ctx) => {
			const state = getGlobalPatchState();
			state.config.settings.fixedBottomEditor.enabled = enabled;
			// 某些 /reload 路径不会重新触发 session_start；命令 ctx 是当前可交互 session 的最新来源。
			fixedBottomEditorRuntime.bindSession(ctx);
			const status = fixedBottomEditorRuntime.setEnabled(enabled);
			state.config.settings.fixedBottomEditor.enabled = status.enabled;
			writePersistedSettings(state.config.settings);
			return status;
		},
		setBottomStatusEnabled: (enabled, ctx) => {
			const state = getGlobalPatchState();
			state.config.settings.bottomStatus.enabled = enabled;
			bottomStatusRuntime.bindSession(ctx);
			bottomStatusRuntime.setEnabled(enabled);
			writePersistedSettings(state.config.settings);
		},
		onSettingsChanged: (settings) => {
			writePersistedSettings(settings);
		},
	});
	registerBottomStatusShortcuts(pi, bottomStatusRuntime);

	// session_start 保存当前 ctx；若设置已打开，则立即尝试安装 fixed editor。
	pi.on("session_start", (_event: any, ctx: any) => {
		fixedBottomEditorRuntime.bindSession(ctx);
		bottomStatusRuntime.bindSession(ctx);
		bottomStatusRuntime.resetSessionStartTime();
		bottomStatusRuntime.setLastPrompt("");
		const state = getGlobalPatchState();
		if (state.config.settings.fixedBottomEditor.enabled) {
			const status = fixedBottomEditorRuntime.setEnabled(true);
			state.config.settings.fixedBottomEditor.enabled = status.enabled;
		}
		bottomStatusRuntime.setEnabled(state.config.settings.bottomStatus.enabled);
	});

	pi.on("model_select", (_event: any, ctx: any) => {
		bottomStatusRuntime.bindSession(ctx);
		bottomStatusRuntime.requestRender();
	});

	pi.on("thinking_level_select", (event: any, ctx: any) => {
		bottomStatusRuntime.bindSession(ctx);
		bottomStatusRuntime.setThinkingLevel(event?.level);
	});

	pi.on("before_agent_start", (event: any, ctx: any) => {
		bottomStatusRuntime.bindSession(ctx);
		bottomStatusRuntime.setLastPrompt(event?.prompt);
	});

	pi.on("message_update", (event: any, ctx: any) => {
		bottomStatusRuntime.bindSession(ctx);
		bottomStatusRuntime.setLiveUsage(event?.message?.usage);
	});

	pi.on("message_end", (_event: any, ctx: any) => {
		bottomStatusRuntime.bindSession(ctx);
		bottomStatusRuntime.clearLiveUsage();
	});

	pi.on("turn_end", (_event: any, ctx: any) => {
		bottomStatusRuntime.bindSession(ctx);
		bottomStatusRuntime.clearLiveUsage();
	});

	// runtime shutdown/reload 时只释放 UI/terminal 资源；开关状态保留并持久化，供下一次 session_start 恢复。
	pi.on("session_shutdown", () => {
		const persisted = cloneSettings(getGlobalPatchState().config.settings);
		try {
			fixedBottomEditorRuntime.dispose();
			bottomStatusRuntime.dispose();
		} finally {
			const state = getGlobalPatchState();
			state.config.settings.chromeFrame.toolCompactMode = persisted.chromeFrame.toolCompactMode;
			state.config.settings.chromeFrame.compactEditTool = persisted.chromeFrame.compactEditTool;
			state.config.settings.fixedBottomEditor.enabled = persisted.fixedBottomEditor.enabled;
			state.config.settings.bottomStatus.enabled = persisted.bottomStatus.enabled;
			writePersistedSettings(state.config.settings);
			disablePatch();
		}
	});
}

export default function alpsPi(pi: ExtensionAPI) {
	registerAlpsPiExtension(pi);
}
