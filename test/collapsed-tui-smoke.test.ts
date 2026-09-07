/** 功能：使用真实 Pi Assistant 与 TuiAltScreen 验证 Collapsed 完成态和执行态。 */

import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	TuiAltScreen,
	stripTerminalSequences,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";
import {
	configureCollapsedRenderRequest,
	resetCollapsedRegistry,
	synchronizeCollapsedMode,
} from "../src/features/chrome-frame/collapsed.ts";
import {
	createInitialPatchState,
	createWrappedRender,
	getRuntimeTheme,
	PATCH_KEY,
	recordChromeFrameLifecycleEvent,
} from "../src/features/chrome-frame/patch.ts";
import { stripAnsi } from "./helpers.test.ts";

const assistantModuleUrl = new URL(
	"./modes/interactive/components/assistant-message.js",
	import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const { AssistantMessageComponent } = await import(assistantModuleUrl.href);

class FakeTerminal {
	columns: number;
	rows: number;
	kittyProtocolActive = false;
	writes: string[] = [];
	input?: (data: string) => void;

	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
	}

	start(onInput: (data: string) => void) { this.input = onInput; }
	stop() { this.input = undefined; }
	async drainInput() {}
	write(data: string) { this.writes.push(data); }
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
}

class StaticScreen implements Component {
	private readonly lines: string[];
	constructor(lines: string[]) { this.lines = lines; }
	render(_width: number) { return this.lines; }
	invalidate() {}
}

class SmokeTool {
	isPartial = true;
	result: any;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args: Record<string, unknown>;

	constructor(toolCallId: string, toolName: string, args: Record<string, unknown>) {
		this.toolCallId = toolCallId;
		this.toolName = toolName;
		this.args = args;
	}

	finish(isError = false) {
		this.isPartial = false;
		this.result = {
			content: [{ type: "text", text: isError ? "failed output" : "成功输出：内容很长但不应破坏线框" }],
			isError,
		};
	}

	render(_width: number) {
		const args = Object.entries(this.args).map(([key, value]) => `${key}=${String(value)}`).join(" ");
		return [`${this.toolName} ${args}`];
	}
}

function foregroundAt(line: string, target: string, fromEnd = false): string {
	const targetIndex = fromEnd ? line.lastIndexOf(target) : line.indexOf(target);
	assert.ok(targetIndex >= 0, `missing ${JSON.stringify(target)} in ${JSON.stringify(line)}`);
	let foreground = "default";
	for (const match of line.slice(0, targetIndex).matchAll(/\x1b\[([0-9;:]*)m/g)) {
		const values = (match[1] || "0").split(/[;:]/).map((value) => Number.parseInt(value, 10));
		for (let index = 0; index < values.length; index += 1) {
			const value = values[index];
			if (value === 0 || value === 39) foreground = "default";
			else if (value === 38) {
				foreground = values.slice(index).join(";");
				break;
			} else if ((value >= 30 && value <= 37) || (value >= 90 && value <= 97)) {
				foreground = String(value);
			}
		}
	}
	return foreground;
}

function expectedForeground(theme: ReturnType<typeof getRuntimeTheme>, token: string): string {
	return foregroundAt(theme.fg(token, "X"), "X");
}

function findLine(lines: string[], pattern: RegExp): string {
	const line = lines.find((candidate) => pattern.test(stripAnsi(candidate)));
	assert.ok(line, `missing ${pattern} in:\n${lines.map(stripAnsi).join("\n")}`);
	return line;
}

function renderThroughTui(lines: string[], width: number): string {
	const terminal = new FakeTerminal(width, Math.max(20, lines.length + 2));
	const tui = new TuiAltScreen(terminal as any, false, undefined, { mouse: false, copyOnSelect: false });
	const document = new Container();
	document.addChild(new StaticScreen(lines));
	tui.setLayoutRoot(document);
	try {
		tui.start();
		tui.renderNow(true);
	} finally {
		tui.stop();
	}
	return stripTerminalSequences(terminal.writes.join(""));
}

function assistantMessage(content: any[], timestamp: number, usage = { input: 11, output: 7, cacheRead: 3, cacheWrite: 2 }) {
	return {
		role: "assistant",
		content,
		timestamp,
		usage,
		stopReason: "stop",
	};
}

function createScenario(width: number) {
	initTheme("dark");
	configureCollapsedRenderRequest(undefined);
	resetCollapsedRegistry();
	synchronizeCollapsedMode(true);
	const state = createInitialPatchState();
	state.config.settings.chromeFrame.assistantFrame = true;
	state.config.settings.chromeFrame.toolCompactMode = "collapsed";
	state.config.settings.chromeFrame.collapseThinking = true;
	(globalThis as any)[PATCH_KEY] = state;
	const theme = getRuntimeTheme();
	const renderAssistant = createWrappedRender(
		"SmokeAssistant",
		"assistant",
		AssistantMessageComponent.prototype.render,
		() => theme,
	);
	const renderTool = createWrappedRender("SmokeTool", "tool", SmokeTool.prototype.render, () => theme);

	const thinkingMessage = assistantMessage([
		{ type: "thinking", thinking: "Planning step one.\nPlanning step two.\nPlanning step three." },
	], 1_000);
	const thinking = new AssistantMessageComponent(thinkingMessage, false);
	const thinkingLines = renderAssistant.call(thinking, width);

	const readOne = new SmokeTool("read-1", "read", { path: "src/alpha.ts" });
	const skill = new SmokeTool("skill-1", "skill", { name: "review" });
	const readTwo = new SmokeTool("read-2", "read", { path: "\x1b[31msrc/含中文的很长文件名.ts\x1b[0m" });
	const grep = new SmokeTool("grep-1", "grep", { query: "TODO_Supercalifragilisticexpialidocious_与超长中文搜索条件" });
	readOne.finish();
	skill.finish();
	readTwo.finish();

	for (const [tool, start, end] of [
		[readOne, 2_000, 2_400],
		[skill, 2_500, 2_900],
		[readTwo, 3_000, 3_400],
	] as const) {
		recordChromeFrameLifecycleEvent("tool_execution_start", { toolCallId: tool.toolCallId }, undefined, start);
		recordChromeFrameLifecycleEvent("tool_execution_end", { toolCallId: tool.toolCallId }, undefined, end);
		renderTool.call(tool, width);
	}
	recordChromeFrameLifecycleEvent("tool_execution_start", { toolCallId: grep.toolCallId }, undefined, 3_500);
	renderTool.call(grep, width);
	const activeToolLines = renderTool.call(readOne, width);

	grep.finish(true);
	recordChromeFrameLifecycleEvent("tool_execution_end", { toolCallId: grep.toolCallId }, undefined, 4_500);
	renderTool.call(grep, width);
	const completeToolLines = renderTool.call(readOne, width);

	const mixedMessage = assistantMessage([
		{ type: "thinking", thinking: "This thinking must not be repeated." },
		{ type: "text", text: "Final **assistant** answer." },
	], 7_000, { input: 19, output: 5, cacheRead: 4, cacheWrite: 0 });
	const mixed = new AssistantMessageComponent(mixedMessage, false);
	const assistantLines = renderAssistant.call(mixed, width);

	return { theme, thinkingLines, activeToolLines, completeToolLines, assistantLines };
}

test("真实 Pi Assistant 和 TuiAltScreen 渲染 Collapsed 执行态与完成态", () => {
	const width = 84;
	const scenario = createScenario(width);
	const thinkingText = scenario.thinkingLines.map(stripAnsi).join("\n");
	assert.match(thinkingText, /Thinking/);
	assert.match(thinkingText, /Planning step one\./);
	assert.match(thinkingText, /Planning step three\./);
	assert.doesNotMatch(thinkingText, /Planning step two\./);
	assert.match(thinkingText, /\[ 15 \]/);
	assert.equal((stripAnsi(scenario.thinkingLines[0]!).match(/\[[^\]]+\]/g) ?? []).length, 1);
	assert.doesNotMatch(thinkingText, /[↑↓]|\bin\b|\bout\b|·/i);

	const activeText = scenario.activeToolLines.map(stripAnsi).join("\n");
	assert.match(activeText, /Tools ×4/);
	assert.match(activeText, /│ ● Read path=src\/alpha\.ts[\s\S]*│ ● Skill name=review[\s\S]*│ ● Read path=src\/含中文的很长文件名\.ts[\s\S]*│ ● Grep query=TODO_Supercalifragilisticexpialidocious_与超长中文搜索条件/);
	assert.doesNotMatch(activeText, /[├└]/);
	assert.doesNotMatch(activeText, /│ {2,}●/);
	assert.match(activeText, /\[ \d+ \]/);
	assert.equal((stripAnsi(scenario.activeToolLines[0]!).match(/\[[^\]]+\]/g) ?? []).length, 1);
	assert.doesNotMatch(stripAnsi(scenario.activeToolLines[0]!), /[↑↓]|\bin\b|\bout\b|·/i);

	const completeText = scenario.completeToolLines.map(stripAnsi).join("\n");
	assert.match(completeText, /│ ● Grep query=TODO_Supercalifragilisticexpialidocious_与超长中文搜索条件/);
	assert.doesNotMatch(completeText, /[├└]/);
	const assistantText = scenario.assistantLines.map(stripAnsi).join("\n");
	assert.match(assistantText, /Final assistant answer\./);
	assert.doesNotMatch(assistantText, /This thinking must not be repeated\./);

	const thinkingTitle = scenario.thinkingLines[0]!;
	const thinkingLine = findLine(scenario.thinkingLines, /Planning step one/);
	const thinkingBottom = scenario.thinkingLines.at(-1)!;
	assert.equal(foregroundAt(thinkingTitle, "]", true), expectedForeground(scenario.theme, "accent"));
	assert.equal(foregroundAt(thinkingLine, "Planning"), expectedForeground(scenario.theme, "toolOutput"));
	assert.equal(foregroundAt(thinkingLine, "│", true), expectedForeground(scenario.theme, "borderMuted"));
	assert.equal(foregroundAt(thinkingBottom, "╯", true), expectedForeground(scenario.theme, "borderMuted"));

	const title = scenario.activeToolLines[0]!;
	const readLine = findLine(scenario.activeToolLines, /Read path=src\/alpha\.ts/);
	const grepLine = findLine(scenario.activeToolLines, /Grep query=TODO/);
	const bottom = scenario.activeToolLines.at(-1)!;
	assert.equal(foregroundAt(title, "]", true), expectedForeground(scenario.theme, "toolTitle"));
	assert.equal(foregroundAt(readLine, "Read"), expectedForeground(scenario.theme, "toolOutput"));
	assert.equal(foregroundAt(readLine, "●"), expectedForeground(scenario.theme, "success"));
	assert.equal(foregroundAt(grepLine, "●"), expectedForeground(scenario.theme, "accent"));
	assert.equal(foregroundAt(readLine, "│", true), expectedForeground(scenario.theme, "borderAccent"));
	assert.equal(foregroundAt(bottom, "╯", true), expectedForeground(scenario.theme, "borderAccent"));

	const activeScreen = renderThroughTui([...scenario.thinkingLines, ...scenario.activeToolLines], width);
	const completeScreen = renderThroughTui([...scenario.completeToolLines, ...scenario.assistantLines], width);
	assert.match(activeScreen, /Tools ×4/);
	assert.match(activeScreen, /Grep query=TODO/);
	assert.match(completeScreen, /Grep query=TODO/);
	assert.match(completeScreen, /Final assistant answer\./);
});

test("真实 TuiAltScreen 在窄宽度 ANSI 与 CJK 内容下不破框", () => {
	const width = 38;
	const scenario = createScenario(width);
	const screens = [scenario.thinkingLines, scenario.activeToolLines, scenario.completeToolLines, scenario.assistantLines];
	for (const lines of screens) {
		for (const line of lines) assert.equal(visibleWidth(line), width, JSON.stringify(stripAnsi(line)));
	}
	const terminalOutput = renderThroughTui([...scenario.thinkingLines, ...scenario.activeToolLines], width);
	assert.match(terminalOutput, /Thinking/);
	assert.match(terminalOutput, /Tools ×4/);
	assert.match(terminalOutput, /Grep query=TODO_Supercalif\w*\.\.\./);

	const failedGrep = findLine(scenario.completeToolLines, /Grep query=TODO/);
	const bottom = scenario.completeToolLines.at(-1)!;
	assert.equal(foregroundAt(failedGrep, "●"), expectedForeground(scenario.theme, "error"));
	assert.equal(foregroundAt(failedGrep, "│", true), expectedForeground(scenario.theme, "error"));
	assert.equal(foregroundAt(bottom, "╯", true), expectedForeground(scenario.theme, "error"));
});
