/** 功能：注册 /alps-pi 命令并实现 settings/preview 契约 实现者：alps 实现日期：2026-05-26 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPreviewComponent, disablePatch, enablePatch, getGlobalPatchState, getRuntimeTheme, type PatchState } from "./features/chrome-frame/index.ts";
import { createSettingsComponent } from "./settings-ui.ts";
import type { AlpsPiSettings, FixedBottomEditorStatus } from "./settings.ts";

export type CommandOps = {
	enable?: () => PatchState;
	disable?: () => PatchState;
	setFixedBottomEditorEnabled?: (enabled: boolean, ctx: any) => FixedBottomEditorStatus | void;
	setBottomStatusEnabled?: (enabled: boolean, ctx: any) => void;
	onSettingsChanged?: (settings: AlpsPiSettings, ctx: any) => void;
};

const HELP = "用法：/alps-pi 打开美化设置；可选参数 preview。";

function notify(ctx: any, message: string, level: "info" | "warning" | "error" = "info") {
	if (ctx?.ui?.notify) {
		ctx.ui.notify(message, level);
	}
}

export function registerAlpsPiCommand(pi: ExtensionAPI, ops: CommandOps = {}): void {
	pi.registerCommand("alps-pi", {
		description: "打开 Alps Pi 美化设置",
		handler: async (args: string, ctx: any) => {
			const trimmedArgs = (args ?? "").trim();
			const action = trimmedArgs === "" ? "" : trimmedArgs.split(/\s+/)[0]!;
			const enableFn = ops.enable ?? (() => enablePatch());
			const disableFn = ops.disable ?? (() => disablePatch());
			const setBottomStatusEnabled = ops.setBottomStatusEnabled ?? ((enabled: boolean) => {
				getGlobalPatchState().config.settings.bottomStatus.enabled = enabled;
			});
			const onSettingsChanged = ops.onSettingsChanged ?? (() => undefined);
			const setFixedEnabled = ops.setFixedBottomEditorEnabled ?? ((enabled: boolean) => {
				const state = getGlobalPatchState();
				state.config.settings.fixedBottomEditor.enabled = false;
				const status: FixedBottomEditorStatus = { enabled: false, installed: false };
				if (enabled) {
					status.failure = "fixed bottom editor runtime ops not registered";
				}
				return status;
			});

			switch (action) {
				case "": {
					let settingsOverlayHandle: { focus?: () => void } | undefined;
					let settingsOverlayComponent: any;
					let settingsTui: any;
					const refocusSettingsOverlay = () => {
						try {
							const focusedBeforeRefocus = settingsTui?.focusedComponent;
							const overlayStack = Reflect.get(settingsTui ?? {}, "overlayStack");
							const entry = Array.isArray(overlayStack)
								? overlayStack.find((candidate) => candidate?.component === settingsOverlayComponent)
								: undefined;
							if (entry && focusedBeforeRefocus && focusedBeforeRefocus !== settingsOverlayComponent) {
								entry.preFocus = focusedBeforeRefocus;
							}
							settingsOverlayHandle?.focus?.();
						} catch {
							// 焦点恢复是 best-effort，不能影响开关状态回写。
						}
					};
					if (!ctx?.ui?.custom) {
						notify(ctx, "Settings require interactive UI.", "warning");
						return;
					}
					try {
						const fallbackTheme = ctx?.ui?.theme ?? getRuntimeTheme();
						await ctx.ui.custom(
							(_tui: any, theme: any, _keybindings: any, done: () => void) => {
								settingsTui = _tui;
								settingsOverlayComponent = createSettingsComponent(theme ?? fallbackTheme, done, {
									getState: getGlobalPatchState,
									disableChromeFrame: () => {
										const result = disableFn();
										onSettingsChanged(result.config.settings, ctx);
										return result;
									},
									enableChromeFrame: () => {
										const result = enableFn();
										onSettingsChanged(result.config.settings, ctx);
										return result;
									},
									setFixedBottomEditorEnabled: (enabled) => {
										try {
											// 固定输入框依赖当前 interactive session；从命令 ctx 懒绑定可覆盖 /reload 后未触发 session_start 的场景。
											return setFixedEnabled(enabled, ctx);
										} finally {
											refocusSettingsOverlay();
										}
									},
									setBottomStatusEnabled: (enabled) => {
										try {
											setBottomStatusEnabled(enabled, ctx);
										} finally {
											refocusSettingsOverlay();
										}
									},
									onSettingsChanged: (settings) => onSettingsChanged(settings, ctx),
								});
								return settingsOverlayComponent;
							},
							{
								overlay: true,
								overlayOptions: { anchor: "center", width: "72%", minWidth: 56, maxHeight: "60%", margin: 1 },
								onHandle: (handle: any) => {
									settingsOverlayHandle = handle;
								},
							},
						);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						notify(ctx, `Settings failed: ${message}`, "error");
					}
					return;
				}
				case "preview": {
					if (!ctx?.ui?.custom) {
						notify(ctx, "Preview requires interactive UI.", "warning");
						return;
					}
					try {
						const fallbackTheme = ctx?.ui?.theme ?? getRuntimeTheme();
						await ctx.ui.custom(
							(_tui: any, theme: any, _keybindings: any, done: () => void) => createPreviewComponent(theme ?? fallbackTheme, done),
							{
								overlay: true,
								overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%", margin: 1 },
							},
						);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						notify(ctx, `Preview failed: ${message}`, "error");
					}
					return;
				}
				default:
					notify(ctx, HELP, "warning");
					return;
			}
		},
	});
}
