/** 功能：使用真实 Pi AgentSession 验证 no-UI 子会话不会释放父 TUI 全局资源。 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createInitialPatchState, disablePatch, enablePatch, PATCH_KEY } from "../src/features/chrome-frame/patch.ts";

const TUI_OWNER_KEY = Symbol.for("alps.pi.tui-owner.v1");

test("真实 no-UI AgentSession start/shutdown 不修改父级 chrome patch", async () => {
	const dir = mkdtempSync(join(tmpdir(), "alps-pi-child-integration-"));
	const previousSettingsPath = process.env.ALPS_PI_SETTINGS_PATH;
	process.env.ALPS_PI_SETTINGS_PATH = join(dir, "settings.json");
	delete (globalThis as any)[TUI_OWNER_KEY];
	(globalThis as any)[PATCH_KEY] = createInitialPatchState();
	const parentState = enablePatch();
	assert.equal(parentState.enabled, true);
	assert.equal(parentState.config.settings.chromeFrame.enabled, true);

	let child: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const settingsManager = SettingsManager.inMemory({});
		const loader = new DefaultResourceLoader({
			cwd: resolve(import.meta.dirname, ".."),
			agentDir: dir,
			settingsManager,
			additionalExtensionPaths: [resolve(import.meta.dirname, "..", "index.ts")],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		({ session: child } = await createAgentSession({
			cwd: resolve(import.meta.dirname, ".."),
			agentDir: dir,
			settingsManager,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(resolve(import.meta.dirname, "..")),
			tools: [],
		}));
		await child.bindExtensions({});
		await child.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		child.dispose();
		child = undefined;

		assert.equal(parentState.enabled, true);
		assert.equal(parentState.config.settings.chromeFrame.enabled, true);
		assert.ok(parentState.patched.size > 0);
		assert.equal((globalThis as any)[TUI_OWNER_KEY], undefined);
	} finally {
		child?.dispose();
		disablePatch();
		(globalThis as any)[PATCH_KEY] = createInitialPatchState();
		delete (globalThis as any)[TUI_OWNER_KEY];
		if (previousSettingsPath === undefined) delete process.env.ALPS_PI_SETTINGS_PATH;
		else process.env.ALPS_PI_SETTINGS_PATH = previousSettingsPath;
		rmSync(dir, { recursive: true, force: true });
	}
});
