/** 功能：为 alps pi 测试提供假主题与工具函数 实现者：alps 实现日期：2026-05-26 */

import { visibleWidth } from "@earendil-works/pi-tui";

export type ThemeCall = { kind: "fg" | "bg" | "bold"; token: string; text: string };

export function createFakeTheme() {
	const calls: ThemeCall[] = [];
	return {
		calls,
		fg(token: string, text: string) {
			calls.push({ kind: "fg", token, text });
			return `\x1b[38;5;${token.length % 200}m${text}\x1b[39m`;
		},
		bg(token: string, text: string) {
			calls.push({ kind: "bg", token, text });
			return `\x1b[48;5;${token.length % 200}m${text}\x1b[49m`;
		},
		bold(text: string) {
			calls.push({ kind: "bold", token: "bold", text });
			return `\x1b[1m${text}\x1b[22m`;
		},
	};
}

export function stripAnsi(input: string): string {
	return input.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "");
}

export function assertLinesWithin(lines: string[], width: number) {
	for (const line of lines) {
		if (visibleWidth(line) > width) {
			throw new Error(`line width ${visibleWidth(line)} exceeded ${width}: ${JSON.stringify(line)}`);
		}
	}
}
