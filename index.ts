/** 功能：pi 美化扩展入口，默认启用消息外框并注册 fixed editor runtime 生命周期 实现者：alps 实现日期：2026-05-26 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAlpsPiCommand } from "./src/commands.ts";
import { disablePatch, enablePatch, getGlobalPatchState, recordChromeFrameLifecycleEvent } from "./src/features/chrome-frame/index.ts";
import { cloneSettings, readPersistedSettings, writePersistedSettings } from "./src/settings-store.ts";
import { configureBottomInputDebug } from "./src/features/bottom-input/debug.ts";
import { createBottomInputRuntime, registerBottomInputShortcuts, type BottomInputRuntime } from "./src/features/bottom-input/index.ts";
import { bindAnimationsSession, configureAnimations, configureAnimationsRenderRequest, disposeAnimations, handleAnimationsAgentEnd, handleAnimationsAgentStart, handleAnimationsMessageEnd, handleAnimationsMessageUpdate, handleAnimationsToolExecutionEnd, handleAnimationsToolExecutionStart, recordAnimationsLifecycleEvent } from "./src/features/animations/index.ts";

export type AlpsPiRuntimeDeps = {
	/** 测试注入点：生产环境使用模块级 bottom input runtime。 */
	bottomInputRuntime?: BottomInputRuntime;
};

const defaultBottomInputRuntime = createBottomInputRuntime();

/** 注册扩展入口；deps 仅供生命周期测试注入，生产环境不传。 */
export function registerAlpsPiExtension(pi: ExtensionAPI, deps: AlpsPiRuntimeDeps = {}) {
	const bottomInputRuntime = deps.bottomInputRuntime ?? defaultBottomInputRuntime;

	const state = getGlobalPatchState();
	const persistedSettings = readPersistedSettings();
	state.config.settings.chromeFrame.enabled = persistedSettings.chromeFrame.enabled;
	state.config.settings.chromeFrame.assistantFrame = persistedSettings.chromeFrame.assistantFrame;
	state.config.settings.chromeFrame.toolCompactMode = persistedSettings.chromeFrame.toolCompactMode;
	state.config.settings.chromeFrame.compactEditTool = persistedSettings.chromeFrame.compactEditTool;
	state.config.settings.fixedBottomEditor.enabled = persistedSettings.fixedBottomEditor.enabled;
	state.config.settings.beautifiedInput.enabled = persistedSettings.beautifiedInput.enabled;
	state.config.settings.footer.enabled = persistedSettings.footer.enabled;
	state.config.settings.animations = { ...persistedSettings.animations };
	state.config.settings.shortcuts = { ...persistedSettings.shortcuts };
	configureBottomInputDebug(undefined);
	configureAnimationsRenderRequest(() => bottomInputRuntime.requestRender());
	configureAnimations(state.config.settings.animations);
	bottomInputRuntime.setShortcuts?.(state.config.settings.shortcuts);
	bottomInputRuntime.setBeautifiedInputEnabled?.(state.config.settings.beautifiedInput.enabled);

	// 消息线框按持久化设置启停；固定输入框由 session_start 在 UI 可用后安装，美化输入框独立控制视觉。
	if (state.config.settings.chromeFrame.enabled) {
		enablePatch();
	} else {
		disablePatch();
	}
	registerAlpsPiCommand(pi, {
		setFixedBottomEditorEnabled: (enabled, ctx) => {
			const state = getGlobalPatchState();
			// fixedBottomEditor.enabled 表示用户偏好；runtime fail-closed 不得把显式 ON 永久改回 false。
			state.config.settings.fixedBottomEditor.enabled = enabled;
			// 某些 /reload 路径不会重新触发 session_start；命令 ctx 是当前可交互 session 的最新来源。
			bottomInputRuntime.bindSession(ctx);
			const status = bottomInputRuntime.configure
				? bottomInputRuntime.configure({
					fixedEnabled: enabled,
					beautifiedInputEnabled: state.config.settings.beautifiedInput.enabled,
					footerEnabled: state.config.settings.footer.enabled,
				})
				: bottomInputRuntime.setEnabled(enabled);
			if (!bottomInputRuntime.configure) bottomInputRuntime.setBeautifiedInputEnabled?.(state.config.settings.beautifiedInput.enabled);
			writePersistedSettings(state.config.settings);
			return status;
		},
		setBeautifiedInputEnabled: (enabled, ctx) => {
			const state = getGlobalPatchState();
			state.config.settings.beautifiedInput.enabled = enabled;
			bottomInputRuntime.bindSession(ctx);
			const status = bottomInputRuntime.configure?.({
				fixedEnabled: state.config.settings.fixedBottomEditor.enabled,
				beautifiedInputEnabled: enabled,
				footerEnabled: state.config.settings.footer.enabled,
			});
			if (!bottomInputRuntime.configure) bottomInputRuntime.setBeautifiedInputEnabled?.(enabled);
			writePersistedSettings(state.config.settings);
			return status;
		},
		setFooterEnabled: (enabled, ctx) => {
			const state = getGlobalPatchState();
			state.config.settings.footer.enabled = enabled;
			bottomInputRuntime.bindSession(ctx);
			const status = bottomInputRuntime.configure?.({
				fixedEnabled: state.config.settings.fixedBottomEditor.enabled,
				beautifiedInputEnabled: state.config.settings.beautifiedInput.enabled,
				footerEnabled: enabled,
			});
			writePersistedSettings(state.config.settings);
			return status;
		},
		onSettingsChanged: (settings) => {
			bottomInputRuntime.setShortcuts?.(settings.shortcuts);
			configureAnimations(settings.animations);
			writePersistedSettings(settings);
		},
	});
	registerBottomInputShortcuts(pi, bottomInputRuntime);

	// session_start 保存当前 ctx；若设置已打开，则立即尝试安装 fixed editor。
	pi.on("session_start", (_event: any, ctx: any) => {
		bindAnimationsSession(ctx);
		configureAnimations(getGlobalPatchState().config.settings.animations);
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.resetSessionStartTime();
		bottomInputRuntime.setLastPrompt("");
		bottomInputRuntime.setShortcuts?.(getGlobalPatchState().config.settings.shortcuts);
		const state = getGlobalPatchState();
		const status = bottomInputRuntime.configure
			? bottomInputRuntime.configure({
				fixedEnabled: state.config.settings.fixedBottomEditor.enabled,
				beautifiedInputEnabled: state.config.settings.beautifiedInput.enabled,
				footerEnabled: state.config.settings.footer.enabled,
			})
			: bottomInputRuntime.setEnabled(state.config.settings.fixedBottomEditor.enabled);
		if (!bottomInputRuntime.configure) bottomInputRuntime.setBeautifiedInputEnabled?.(state.config.settings.beautifiedInput.enabled);
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

	pi.on("agent_start", (event: any, ctx: any) => {
		recordChromeFrameLifecycleEvent("agent_start", event, ctx);
		recordAnimationsLifecycleEvent("agent_start", ctx, event);
		handleAnimationsAgentStart(event, ctx);
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.setStreaming?.(true);
	});

	pi.on("message_update", (event: any, ctx: any) => {
		recordChromeFrameLifecycleEvent("message_update", event, ctx);
		recordAnimationsLifecycleEvent("message_update", ctx, event);
		handleAnimationsMessageUpdate(event, ctx);
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.setLiveUsage(event?.message?.usage);
	});

	pi.on("message_end", (event: any, ctx: any) => {
		recordChromeFrameLifecycleEvent("message_end", event, ctx);
		recordAnimationsLifecycleEvent("message_end", ctx, event);
		handleAnimationsMessageEnd(ctx);
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.clearLiveUsage();
	});

	pi.on("tool_execution_start", (event: any, ctx: any) => {
		recordChromeFrameLifecycleEvent("tool_execution_start", event, ctx);
		recordAnimationsLifecycleEvent("tool_execution_start", ctx, event);
		handleAnimationsToolExecutionStart(event, ctx);
	});

	pi.on("tool_execution_update", (event: any, ctx: any) => {
		recordChromeFrameLifecycleEvent("tool_execution_update", event, ctx);
		recordAnimationsLifecycleEvent("tool_execution_update", ctx, event);
	});

	pi.on("tool_execution_end", (event: any, ctx: any) => {
		recordChromeFrameLifecycleEvent("tool_execution_end", event, ctx);
		recordAnimationsLifecycleEvent("tool_execution_end", ctx, event);
		handleAnimationsToolExecutionEnd(event, ctx);
	});

	pi.on("agent_end", (event: any, ctx: any) => {
		recordChromeFrameLifecycleEvent("agent_end", event, ctx);
		recordAnimationsLifecycleEvent("agent_end", ctx, event);
		handleAnimationsAgentEnd(event, ctx);
	});

	pi.on("turn_end", (event: any, ctx: any) => {
		recordChromeFrameLifecycleEvent("turn_end", event, ctx);
		recordAnimationsLifecycleEvent("turn_end", ctx, event);
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.clearLiveUsage();
	});

	// runtime shutdown/reload 时只释放 UI/terminal 资源；开关状态保留并持久化，供下一次 session_start 恢复。
	pi.on("session_shutdown", (event: any, ctx: any) => {
		recordAnimationsLifecycleEvent("session_shutdown", ctx, event);
		const persisted = cloneSettings(getGlobalPatchState().config.settings);
		try {
			bottomInputRuntime.dispose();
		} finally {
			const state = getGlobalPatchState();
			state.config.settings.chromeFrame.toolCompactMode = persisted.chromeFrame.toolCompactMode;
			state.config.settings.chromeFrame.compactEditTool = persisted.chromeFrame.compactEditTool;
			state.config.settings.fixedBottomEditor.enabled = persisted.fixedBottomEditor.enabled;
			state.config.settings.beautifiedInput.enabled = persisted.beautifiedInput.enabled;
			state.config.settings.footer.enabled = persisted.footer.enabled;
			state.config.settings.animations = { ...persisted.animations };
			state.config.settings.shortcuts = { ...persisted.shortcuts };
			writePersistedSettings(state.config.settings);
			configureBottomInputDebug(undefined);
			configureAnimationsRenderRequest(undefined);
			disposeAnimations();
			disablePatch();
		}
	});
}

export default function alpsPi(pi: ExtensionAPI) {
	registerAlpsPiExtension(pi);
}
