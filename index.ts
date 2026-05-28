/** 功能：pi 美化扩展入口，默认启用消息外框并注册 fixed editor runtime 生命周期 实现者：alps 实现日期：2026-05-26 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAlpsPiCommand } from "./src/commands.ts";
import { disablePatch, enablePatch, getGlobalPatchState } from "./src/features/chrome-frame/index.ts";
import { cloneSettings, readPersistedSettings, writePersistedSettings } from "./src/settings-store.ts";
import { registerBottomStatusShortcuts } from "./src/features/bottom-status/index.ts";
import { createBottomInputRuntime, type BottomInputRuntime } from "./src/features/bottom-input/index.ts";

export type AlpsPiRuntimeDeps = {
	/** 测试注入点：生产环境使用模块级 bottom input runtime。 */
	bottomInputRuntime?: BottomInputRuntime;
	/** 兼容旧测试注入名：会被当作 bottom input runtime 使用。 */
	fixedBottomEditorRuntime?: BottomInputRuntime;
	/** 兼容旧测试注入名：不再单独注册 widget。 */
	bottomStatusRuntime?: BottomInputRuntime;
};

const defaultBottomInputRuntime = createBottomInputRuntime();

/** 注册扩展入口；deps 仅供生命周期测试注入，生产环境不传。 */
export function registerAlpsPiExtension(pi: ExtensionAPI, deps: AlpsPiRuntimeDeps = {}) {
	const bottomInputRuntime = deps.bottomInputRuntime ?? deps.fixedBottomEditorRuntime ?? deps.bottomStatusRuntime ?? defaultBottomInputRuntime;

	const state = getGlobalPatchState();
	const persistedSettings = readPersistedSettings();
	state.config.settings.chromeFrame.enabled = persistedSettings.chromeFrame.enabled;
	state.config.settings.chromeFrame.assistantFrame = persistedSettings.chromeFrame.assistantFrame;
	state.config.settings.fixedBottomEditor.enabled = persistedSettings.fixedBottomEditor.enabled;
	state.config.settings.bottomStatus.enabled = persistedSettings.bottomStatus.enabled;
	state.config.settings.shortcuts = { ...persistedSettings.shortcuts };
	bottomInputRuntime.setShortcuts?.(state.config.settings.shortcuts);

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
			bottomInputRuntime.bindSession(ctx);
			const status = bottomInputRuntime.setEnabled(enabled);
			state.config.settings.fixedBottomEditor.enabled = status.enabled;
			bottomInputRuntime.setBottomStatusEnabled?.(state.config.settings.bottomStatus.enabled);
			writePersistedSettings(state.config.settings);
			return status;
		},
		setBottomStatusEnabled: (enabled, ctx) => {
			const state = getGlobalPatchState();
			state.config.settings.bottomStatus.enabled = enabled;
			bottomInputRuntime.bindSession(ctx);
			bottomInputRuntime.setBottomStatusEnabled?.(enabled);
			writePersistedSettings(state.config.settings);
		},
		onSettingsChanged: (settings) => {
			bottomInputRuntime.setShortcuts?.(settings.shortcuts);
			writePersistedSettings(settings);
		},
	});
	registerBottomStatusShortcuts(pi, bottomInputRuntime);

	// session_start 保存当前 ctx；若设置已打开，则立即尝试安装 fixed editor。
	pi.on("session_start", (_event: any, ctx: any) => {
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.resetSessionStartTime();
		bottomInputRuntime.setLastPrompt("");
		bottomInputRuntime.setShortcuts?.(getGlobalPatchState().config.settings.shortcuts);
		const state = getGlobalPatchState();
		if (state.config.settings.fixedBottomEditor.enabled) {
			const status = bottomInputRuntime.setEnabled(true);
			state.config.settings.fixedBottomEditor.enabled = status.enabled;
		} else {
			bottomInputRuntime.setEnabled(false);
		}
		bottomInputRuntime.setBottomStatusEnabled?.(state.config.settings.bottomStatus.enabled);
	});

	pi.on("model_select", (_event: any, ctx: any) => {
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.requestRender();
	});

	pi.on("thinking_level_select", (event: any, ctx: any) => {
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.setThinkingLevel(event?.level);
	});

	pi.on("before_agent_start", (event: any, ctx: any) => {
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.setLastPrompt(event?.prompt);
	});

	pi.on("agent_start", (_event: any, ctx: any) => {
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.setStreaming?.(true);
	});

	pi.on("message_update", (event: any, ctx: any) => {
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.setLiveUsage(event?.message?.usage);
	});

	pi.on("message_end", (_event: any, ctx: any) => {
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.clearLiveUsage();
	});

	pi.on("turn_end", (_event: any, ctx: any) => {
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.clearLiveUsage();
	});

	// runtime shutdown/reload 时只释放 UI/terminal 资源；开关状态保留并持久化，供下一次 session_start 恢复。
	pi.on("session_shutdown", () => {
		const persisted = cloneSettings(getGlobalPatchState().config.settings);
		try {
			bottomInputRuntime.dispose();
		} finally {
			const state = getGlobalPatchState();
			state.config.settings.fixedBottomEditor.enabled = persisted.fixedBottomEditor.enabled;
			state.config.settings.bottomStatus.enabled = persisted.bottomStatus.enabled;
			state.config.settings.shortcuts = { ...persisted.shortcuts };
			writePersistedSettings(state.config.settings);
			disablePatch();
		}
	});
}

export default function alpsPi(pi: ExtensionAPI) {
	registerAlpsPiExtension(pi);
}
