/** 功能：注册 /alps-pi 命令并实现 settings/status/preview 契约 实现者：alps 实现日期：2026-05-26 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPreviewComponent } from "./preview.ts";
import { createSettingsComponent } from "./settings-ui.ts";
import { disablePatch, enablePatch, formatPatchStatus, getGlobalPatchState, getRuntimeTheme, type PatchState } from "./patch.ts";

export type CommandOps = {
	enable?: () => PatchState;
	disable?: () => PatchState;
	status?: () => PatchState;
};

const HELP = "用法：/alps-pi 打开美化设置；可选参数 preview/status。";

function notify(ctx: any, message: string, level: "info" | "warning" | "error" = "info") {
	if (ctx?.ui?.notify) {
		ctx.ui.notify(message, level);
	}
}

export function registerAlpsPiCommand(pi: ExtensionAPI, ops: CommandOps = {}): void {
	pi.registerCommand("alps-pi", {
		description: "打开 Alps Pi 美化设置",
		handler: async (args: string, ctx: any) => {
			const action = (args ?? "").trim().split(/\s+/)[0] || "settings";
			const statusFn = ops.status ?? getGlobalPatchState;
			const enableFn = ops.enable ?? (() => enablePatch());
			const disableFn = ops.disable ?? (() => disablePatch());

			switch (action) {
				case "settings":
				case "config-ui": {
					if (!ctx?.ui?.custom) {
						notify(ctx, "Settings require interactive UI.", "warning");
						return;
					}
					try {
						const fallbackTheme = ctx?.ui?.theme ?? getRuntimeTheme();
						await ctx.ui.custom(
							(_tui: any, theme: any, _keybindings: any, done: () => void) => createSettingsComponent(theme ?? fallbackTheme, done, {
								getState: statusFn,
								enable: enableFn,
								disable: disableFn,
							}),
							{
								overlay: true,
								overlayOptions: { anchor: "center", width: "72%", minWidth: 56, maxHeight: "60%", margin: 1 },
							},
						);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						notify(ctx, `Settings failed: ${message}`, "error");
					}
					return;
				}
				case "status": {
					notify(ctx, formatPatchStatus(statusFn()), "info");
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
