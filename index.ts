/** 功能：pi 美化扩展入口，默认启用消息外框并注册 fixed editor runtime 生命周期 实现者：alps 实现日期：2026-05-26 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAlpsPiCommand } from "./src/commands.ts";
import { disablePatch, enablePatch, getGlobalPatchState, recordChromeFrameLifecycleEvent, setChromeFramePreference } from "./src/features/chrome-frame/index.ts";
import { cloneSettings, readPersistedSettings, trackSettingsBaseline, writePersistedSettings } from "./src/settings-store.ts";
import { configureBottomInputDebug } from "./src/features/bottom-input/debug.ts";
import { createBottomInputRuntime, registerBottomInputShortcuts, type BottomInputRuntime } from "./src/features/bottom-input/index.ts";
import { bindAnimationsSession, configureAnimations, configureAnimationsRenderRequest, disposeAnimations, handleAnimationsAgentEnd, handleAnimationsAgentStart, handleAnimationsMessageEnd, handleAnimationsMessageUpdate, handleAnimationsToolExecutionEnd, handleAnimationsToolExecutionStart, recordAnimationsLifecycleEvent } from "./src/features/animations/index.ts";
import { formatPiCapabilityFailures, inspectPiRuntimeCapabilities, isTuiSessionContext, type PiRuntimeCapabilities } from "./src/pi-compat.ts";

export type AlpsPiRuntimeDeps = {
	/** 测试注入点：生产环境使用模块级 bottom input runtime。 */
	bottomInputRuntime?: BottomInputRuntime;
	/** 测试注入点：生产环境检测真实 Pi 组件能力。 */
	inspectCapabilities?: () => PiRuntimeCapabilities;
};

const defaultBottomInputRuntime = createBottomInputRuntime();

/** 当前进程中唯一允许管理 Alps TUI 资源的 extension instance。 */
const TUI_OWNER_KEY = Symbol.for("alps.pi.tui-owner.v1");

/** 注册扩展入口；deps 仅供生命周期测试注入，生产环境不传。 */
export function registerAlpsPiExtension(pi: ExtensionAPI, deps: AlpsPiRuntimeDeps = {}) {
	const bottomInputRuntime = deps.bottomInputRuntime ?? defaultBottomInputRuntime;
	const inspectCapabilities = deps.inspectCapabilities ?? (() => inspectPiRuntimeCapabilities());

	const ownerToken = Symbol("alps-pi-tui-owner");
	let ownsTuiRuntime = false;
	const isCurrentTuiOwner = () => ownsTuiRuntime && (globalThis as any)[TUI_OWNER_KEY] === ownerToken;
	const applyPersistedSettings = () => {
		const state = getGlobalPatchState();
		const persistedSettings = readPersistedSettings();
		state.config.settings.chromeFrame.enabled = persistedSettings.chromeFrame.enabled;
		state.config.settings.chromeFrame.assistantFrame = persistedSettings.chromeFrame.assistantFrame;
		state.config.settings.chromeFrame.toolCompactMode = persistedSettings.chromeFrame.toolCompactMode;
		state.config.settings.chromeFrame.compactEditTool = persistedSettings.chromeFrame.compactEditTool;
		state.config.settings.fixedBottomEditor.enabled = persistedSettings.fixedBottomEditor.enabled;
		state.config.settings.beautifiedInput.enabled = persistedSettings.beautifiedInput.enabled;
		state.config.settings.animations = { ...persistedSettings.animations };
		state.config.settings.shortcuts = { ...persistedSettings.shortcuts };
		trackSettingsBaseline(state.config.settings, persistedSettings);
		return state;
	};
	registerAlpsPiCommand(pi, {
		enable: () => setChromeFramePreference(true),
		disable: () => setChromeFramePreference(false),
		setBeautifiedInputEnabled: (enabled, ctx) => {
			const state = getGlobalPatchState();
			state.config.settings.beautifiedInput.enabled = enabled;
			bottomInputRuntime.bindSession(ctx);
			const status = bottomInputRuntime.configure({ beautifiedInputEnabled: enabled });
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

	// 只有真实 TUI session 可以取得全局渲染资源所有权；无 UI 子代理不参与 runtime 生命周期。
	pi.on("session_start", (_event: any, ctx: any) => {
		if (!isTuiSessionContext(ctx)) return;
		(globalThis as any)[TUI_OWNER_KEY] = ownerToken;
		ownsTuiRuntime = true;

		const state = applyPersistedSettings();
		configureBottomInputDebug(undefined);
		configureAnimationsRenderRequest(() => bottomInputRuntime.requestRender());
		const capabilities = inspectCapabilities();
		for (const failure of formatPiCapabilityFailures(capabilities)) console.debug?.(`[alps-pi] ${failure}`);
		configureAnimations(state.config.settings.animations);
		if (state.config.settings.chromeFrame.enabled && capabilities.chromeFrame.supported) {
			enablePatch();
		} else {
			disablePatch();
			if (state.config.settings.chromeFrame.enabled) {
				state.failures.clear();
				for (const [id, reason] of capabilities.chromeFrame.failures) state.failures.set(`compat:${id}`, reason);
			}
		}

		bindAnimationsSession(ctx);
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.resetSessionStartTime();
		bottomInputRuntime.setLastPrompt("");
		bottomInputRuntime.setShortcuts?.(state.config.settings.shortcuts);
		bottomInputRuntime.configure({ beautifiedInputEnabled: state.config.settings.beautifiedInput.enabled });
	});

	pi.on("model_select", (_event: any, ctx: any) => {
		if (!isCurrentTuiOwner()) return;
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.requestRender();
	});

	pi.on("thinking_level_select", (event: any, ctx: any) => {
		if (!isCurrentTuiOwner()) return;
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.setThinkingLevel(event?.level);
	});

	pi.on("before_agent_start", (event: any, ctx: any) => {
		if (!isCurrentTuiOwner()) return;
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.setLastPrompt(event?.prompt);
	});

	pi.on("agent_start", (event: any, ctx: any) => {
		if (!isCurrentTuiOwner()) return;
		recordChromeFrameLifecycleEvent("agent_start", event, ctx);
		recordAnimationsLifecycleEvent("agent_start", ctx, event);
		handleAnimationsAgentStart(event, ctx);
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.setStreaming?.(true);
	});

	pi.on("message_update", (event: any, ctx: any) => {
		if (!isCurrentTuiOwner()) return;
		recordChromeFrameLifecycleEvent("message_update", event, ctx);
		recordAnimationsLifecycleEvent("message_update", ctx, event);
		handleAnimationsMessageUpdate(event, ctx);
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.setLiveUsage(event?.message?.usage);
	});

	pi.on("message_end", (event: any, ctx: any) => {
		if (!isCurrentTuiOwner()) return;
		recordChromeFrameLifecycleEvent("message_end", event, ctx);
		recordAnimationsLifecycleEvent("message_end", ctx, event);
		handleAnimationsMessageEnd(ctx);
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.clearLiveUsage();
	});

	pi.on("tool_execution_start", (event: any, ctx: any) => {
		if (!isCurrentTuiOwner()) return;
		recordChromeFrameLifecycleEvent("tool_execution_start", event, ctx);
		recordAnimationsLifecycleEvent("tool_execution_start", ctx, event);
		handleAnimationsToolExecutionStart(event, ctx);
	});

	pi.on("tool_execution_update", (event: any, ctx: any) => {
		if (!isCurrentTuiOwner()) return;
		recordChromeFrameLifecycleEvent("tool_execution_update", event, ctx);
		recordAnimationsLifecycleEvent("tool_execution_update", ctx, event);
	});

	pi.on("tool_execution_end", (event: any, ctx: any) => {
		if (!isCurrentTuiOwner()) return;
		recordChromeFrameLifecycleEvent("tool_execution_end", event, ctx);
		recordAnimationsLifecycleEvent("tool_execution_end", ctx, event);
		handleAnimationsToolExecutionEnd(event, ctx);
	});

	pi.on("agent_end", (event: any, ctx: any) => {
		if (!isCurrentTuiOwner()) return;
		recordChromeFrameLifecycleEvent("agent_end", event, ctx);
		recordAnimationsLifecycleEvent("agent_end", ctx, event);
		handleAnimationsAgentEnd(event, ctx);
	});

	pi.on("turn_end", (event: any, ctx: any) => {
		if (!isCurrentTuiOwner()) return;
		recordChromeFrameLifecycleEvent("turn_end", event, ctx);
		recordAnimationsLifecycleEvent("turn_end", ctx, event);
		bottomInputRuntime.bindSession(ctx);
		bottomInputRuntime.clearLiveUsage();
	});

	// 只有持有当前 TUI owner token 的实例可以释放全局资源；子代理 shutdown 必须无副作用。
	pi.on("session_shutdown", (event: any, ctx: any) => {
		if (!isCurrentTuiOwner()) return;
		ownsTuiRuntime = false;
		delete (globalThis as any)[TUI_OWNER_KEY];
		recordAnimationsLifecycleEvent("session_shutdown", ctx, event);
		const persisted = cloneSettings(getGlobalPatchState().config.settings);
		try {
			bottomInputRuntime.dispose();
		} finally {
			const state = getGlobalPatchState();
			state.config.settings.chromeFrame.enabled = persisted.chromeFrame.enabled;
			state.config.settings.chromeFrame.assistantFrame = persisted.chromeFrame.assistantFrame;
			state.config.settings.chromeFrame.toolCompactMode = persisted.chromeFrame.toolCompactMode;
			state.config.settings.chromeFrame.compactEditTool = persisted.chromeFrame.compactEditTool;
			state.config.settings.fixedBottomEditor.enabled = persisted.fixedBottomEditor.enabled;
			state.config.settings.beautifiedInput.enabled = persisted.beautifiedInput.enabled;
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
