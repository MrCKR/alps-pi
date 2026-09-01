/** 功能：使用真实 Pi reload/new/resume 生命周期验证 Alps UI owner 幂等。 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	createAgentSession,
	createAgentSessionRuntime,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const TUI_OWNER_KEY = Symbol.for("alps.pi.tui-owner.v1");

function createUiHarness() {
	const terminal = { columns: 80, rows: 24, write() {} };
	const tui = {
		mode: "regular",
		terminal,
		children: [],
		requestRender() {},
		hasOverlay: () => false,
		setFocus() {},
	};
	let editorFactory: any;
	let footerFactory: any;
	let editor: any;
	let footer: any;
	let editorInstalls = 0;
	let footerInstalls = 0;
	const inputHandlers = new Set<Function>();
	let editorText = "";
	const theme = {
		fg: (_token: string, text: string) => text,
		bg: (_token: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
	};
	const ui: any = {
		theme,
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify() {},
		onTerminalInput(handler: Function) {
			inputHandlers.add(handler);
			return () => inputHandlers.delete(handler);
		},
		setStatus() {},
		setWorkingMessage() {},
		setWorkingVisible() {},
		setWorkingIndicator() {},
		setHiddenThinkingLabel() {},
		setWidget() {},
		setHeader() {},
		setTitle() {},
		pasteToEditor() {},
		setEditorText(text: string) { editorText = text; },
		getEditorText: () => editorText,
		editor: async () => undefined,
		addAutocompleteProvider() {},
		getEditorComponent: () => editorFactory,
		setEditorComponent(factory: any) {
			editorFactory = factory;
			if (!factory) {
				editor = undefined;
				return;
			}
			editorInstalls += 1;
			editor = factory(tui, { borderColor: (text: string) => text, selectList: {} }, {});
		},
		setFooter(factory: any) {
			footer?.dispose?.();
			footerFactory = factory;
			if (!factory) {
				footer = undefined;
				return;
			}
			footerInstalls += 1;
			footer = factory(tui, theme, { getExtensionStatuses: () => new Map(), onBranchChange: () => () => undefined });
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: true }),
		getToolsExpanded: () => false,
		setToolsExpanded() {},
	};
	return {
		ui,
		counts: () => ({
			activeEditor: editorFactory ? 1 : 0,
			activeFooter: footerFactory ? 1 : 0,
			activeInputListeners: inputHandlers.size,
			editorInstalls,
			footerInstalls,
		}),
	};
}

test("真实 reload/new/resume 后仅保留一个 Alps UI owner", async () => {
	const dir = mkdtempSync(join(tmpdir(), "alps-pi-replacement-"));
	const sessionDir = join(dir, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const previousSettingsPath = process.env.ALPS_PI_SETTINGS_PATH;
	process.env.ALPS_PI_SETTINGS_PATH = join(dir, "alps-settings.json");
	delete (globalThis as any)[TUI_OWNER_KEY];
	const cwd = resolve(import.meta.dirname, "..");
	const uiHarness = createUiHarness();

	const createRuntime = async (options: { cwd: string; agentDir: string; sessionManager: SessionManager; sessionStartEvent?: any }) => {
		const settingsManager = SettingsManager.inMemory({});
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: dir,
			settingsManager,
			additionalExtensionPaths: [resolve(cwd, "index.ts")],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const result = await createAgentSession({
			cwd,
			agentDir: dir,
			settingsManager,
			resourceLoader: loader,
			sessionManager: options.sessionManager,
			sessionStartEvent: options.sessionStartEvent,
			tools: [],
		});
		return { ...result, services: { cwd, agentDir: dir } as any, diagnostics: [] };
	};

	const initialManager = SessionManager.create(cwd, sessionDir);
	const runtime = await createAgentSessionRuntime(createRuntime as any, { cwd, agentDir: dir, sessionManager: initialManager });
	const bind = (session: typeof runtime.session) => session.bindExtensions({ mode: "tui", uiContext: uiHarness.ui });
	try {
		runtime.setRebindSession(bind);
		await bind(runtime.session);
		const initialFile = runtime.session.sessionFile;
		assert.ok(initialFile);
		assert.deepEqual(uiHarness.counts(), { activeEditor: 1, activeFooter: 1, activeInputListeners: 1, editorInstalls: 1, footerInstalls: 1 });
		assert.ok((globalThis as any)[TUI_OWNER_KEY]);

		await runtime.session.reload();
		assert.deepEqual(uiHarness.counts(), { activeEditor: 1, activeFooter: 1, activeInputListeners: 1, editorInstalls: 2, footerInstalls: 2 });

		await runtime.newSession();
		assert.deepEqual(uiHarness.counts(), { activeEditor: 1, activeFooter: 1, activeInputListeners: 1, editorInstalls: 3, footerInstalls: 3 });

		await runtime.switchSession(initialFile!);
		assert.deepEqual(uiHarness.counts(), { activeEditor: 1, activeFooter: 1, activeInputListeners: 1, editorInstalls: 4, footerInstalls: 4 });
		assert.ok((globalThis as any)[TUI_OWNER_KEY]);
	} finally {
		await runtime.dispose();
		assert.deepEqual(uiHarness.counts(), { activeEditor: 0, activeFooter: 0, activeInputListeners: 0, editorInstalls: 4, footerInstalls: 4 });
		assert.equal((globalThis as any)[TUI_OWNER_KEY], undefined);
		if (previousSettingsPath === undefined) delete process.env.ALPS_PI_SETTINGS_PATH;
		else process.env.ALPS_PI_SETTINGS_PATH = previousSettingsPath;
		rmSync(dir, { recursive: true, force: true });
	}
});
