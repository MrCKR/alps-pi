/** 功能：注册 /alps-pi 命令并实现 settings/preview 契约 实现者：alps 实现日期：2026-05-26 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPreviewComponent, disablePatch, enablePatch, getGlobalPatchState, getRuntimeTheme, type PatchState } from "./features/chrome-frame/index.ts";
import { createSettingsComponent } from "./settings-ui.ts";
import type { AlpsPiSettings, FixedBottomEditorStatus } from "./settings.ts";

export type CommandOps = {
	enable?: () => PatchState;
	disable?: () => PatchState;
	setFixedBottomEditorEnabled?: (enabled: boolean, ctx: any) => FixedBottomEditorStatus | void;
	setBeautifiedInputEnabled?: (enabled: boolean, ctx: any) => void;
	onSettingsChanged?: (settings: AlpsPiSettings, ctx: any) => void;
};

const HELP = "用法：/alps-pi 打开美化设置；可选参数 preview。";

function notify(ctx: any, message: string, level: "info" | "warning" | "error" = "info") {
	try {
		if (ctx?.ui?.notify) {
			ctx.ui.notify(message, level);
		}
	} catch {
		// 通知依赖当前 session UI；reload 后旧 ctx 失效时直接忽略。
	}
}

/** 安全读取命令 UI；ctx stale 时返回 undefined，避免设置面板回调继续使用旧 session。 */
function readCommandUI(ctx: any): any | undefined {
	try {
		return ctx?.ui;
	} catch {
		return undefined;
	}
}

function isStaleCtxError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("extension ctx is stale") || message.includes("stale ctx");
}

export function registerAlpsPiCommand(pi: ExtensionAPI, ops: CommandOps = {}): void {
	pi.registerCommand("alps-pi", {
		description: "打开 Alps Pi 美化设置",
		handler: async (args: string, ctx: any) => {
			const trimmedArgs = (args ?? "").trim();
			const action = trimmedArgs === "" ? "" : trimmedArgs.split(/\s+/)[0]!;
			const enableFn = ops.enable ?? (() => enablePatch());
			const disableFn = ops.disable ?? (() => disablePatch());
			const setBeautifiedInputEnabled = ops.setBeautifiedInputEnabled ?? ((enabled: boolean) => {
				getGlobalPatchState().config.settings.beautifiedInput.enabled = enabled;
			});
			const onSettingsChanged = ops.onSettingsChanged ?? ((settings: AlpsPiSettings) => {
				getGlobalPatchState().config.settings.shortcuts = { ...settings.shortcuts };
			});
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
					const ui = readCommandUI(ctx);
					if (!ui?.custom) {
						notify(ctx, "Settings require interactive UI.", "warning");
						return;
					}
					let active = true;
					const runIfActive = <T>(operation: () => T): T | undefined => {
						if (!active || readCommandUI(ctx) !== ui) return undefined;
						try {
							return operation();
						} catch (error) {
							if (!isStaleCtxError(error)) throw error;
							active = false;
							return undefined;
						}
					};
					try {
						const fallbackTheme = ui.theme ?? getRuntimeTheme();
						let overlayHandle: { focus?: () => void } | undefined;
						const refocusSettingsOverlay = () => {
							if (!overlayHandle) return;
							queueMicrotask(() => {
								try {
									overlayHandle?.focus?.();
								} catch {
									// overlay 可能已经关闭；焦点恢复失败不能阻断设置保存。
								}
							});
						};
						await ui.custom((_tui: any, theme: any, _keybindings: any, done: () => void) => createSettingsComponent(theme ?? fallbackTheme, done, {
							getState: getGlobalPatchState,
							disableChromeFrame: () => runIfActive(() => {
								const result = disableFn();
								onSettingsChanged(result.config.settings, ctx);
								return result;
							}) ?? getGlobalPatchState(),
							enableChromeFrame: () => runIfActive(() => {
								const result = enableFn();
								onSettingsChanged(result.config.settings, ctx);
								return result;
							}) ?? getGlobalPatchState(),
							setFixedBottomEditorEnabled: (enabled) => {
								// 固定输入框依赖当前 interactive session；ctx stale 时旧设置面板回调失效。
								const result = runIfActive(() => setFixedEnabled(enabled, ctx));
								refocusSettingsOverlay();
								return result;
							},
							setBeautifiedInputEnabled: (enabled) => {
								runIfActive(() => setBeautifiedInputEnabled(enabled, ctx));
								refocusSettingsOverlay();
							},
							onSettingsChanged: (settings) => {
								runIfActive(() => onSettingsChanged(settings, ctx));
								refocusSettingsOverlay();
							},
						}), {
							overlay: true,
							overlayOptions: { anchor: "center", width: "90%", minWidth: 56, maxHeight: "80%", margin: 1 },
							onHandle: (handle: { focus?: () => void }) => {
								overlayHandle = handle;
							},
						});
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						notify(ctx, `Settings failed: ${message}`, "error");
					} finally {
						active = false;
					}
					return;
				}
				case "preview": {
					const ui = readCommandUI(ctx);
					if (!ui?.custom) {
						notify(ctx, "Preview requires interactive UI.", "warning");
						return;
					}
					try {
						const fallbackTheme = ui.theme ?? getRuntimeTheme();
						await ui.custom(
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
