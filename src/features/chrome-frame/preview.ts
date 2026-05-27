/** 功能：提供 /alps-pi preview 的自定义 UI 组件 实现者：alps 实现日期：2026-05-26 */

import { Key, matchesKey } from "@earendil-works/pi-tui";
import { renderNeonBox } from "./chrome.ts";
import type { ThemeLike } from "./styles.ts";

export class AlpsPiPreviewComponent {
	private readonly theme: ThemeLike;
	private readonly done?: () => void;
	private closed = false;

	constructor(theme: ThemeLike, done?: () => void) {
		this.theme = theme;
		this.done = done;
	}

	render(width: number): string[] {
		const samples: Array<{ kind: any; lines: string[]; options?: Record<string, unknown> }> = [
			{ kind: "custom", lines: ["Alps Pi preview — press Esc, q, Enter, or Ctrl+C to close."] },
			{ kind: "user", lines: ["测试底板 / user message"] },
			{ kind: "assistant", lines: ["这里是 assistant 回复内容，包含 **markdown** 与长中文换行示例。"] },
			{ kind: "custom", lines: ["扩展 custom message"] },
			{ kind: "skill", lines: ["skill invocation block"] },
			{ kind: "compaction", lines: ["Compacted summary preview"] },
			{ kind: "branch", lines: ["Branch summary preview"] },
			{ kind: "tool", lines: ["● pending"], options: { toolName: "read", status: "pending" } },
			{ kind: "tool", lines: ["● completed"], options: { toolName: "todo", status: "success" } },
			{ kind: "tool", lines: ["● failed"], options: { toolName: "bash", status: "error" } },
			{ kind: "bash", lines: ["$ npm test", "running..."], options: { status: "pending" } },
			{ kind: "bash", lines: ["$ npm test", "all tests passed"], options: { status: "success" } },
			{ kind: "bash", lines: ["$ npm test", "exit 1"], options: { status: "error" } },
			{ kind: "working", lines: ["⠋ Working..."] },
			{ kind: "assistant", lines: ["\x1b[32mANSI green text\x1b[39m and normal text"] },
			{ kind: "assistant", lines: ["```ts", "const ok = true;", "```"] },
			{ kind: "tool", lines: ["very long line ".repeat(20)], options: { toolName: "grep", status: "success" } },
		];
		const rendered: string[] = [];
		for (const sample of samples) {
			rendered.push(...renderNeonBox(sample.kind, sample.lines, Math.max(1, width), this.theme, sample.options as any));
			rendered.push("");
		}
		return rendered.slice(0, -1);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.enter) ||
			matchesKey(data, Key.ctrl("c")) ||
			data === "q" ||
			data === "Q"
		) {
			this.close();
		}
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.done?.();
	}
}

export function createPreviewComponent(theme: ThemeLike, done?: () => void): AlpsPiPreviewComponent {
	return new AlpsPiPreviewComponent(theme, done);
}
