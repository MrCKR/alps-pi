/** 功能：静态证明 0.2.0 生产代码不再包含 terminal viewport compositor。 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = resolve(ROOT, "src");

function sourceFiles(path: string): string[] {
	return readdirSync(path).flatMap((name) => {
		const entry = resolve(path, name);
		return statSync(entry).isDirectory() ? sourceFiles(entry) : entry.endsWith(".ts") ? [entry] : [];
	});
}

test("legacy fixed-bottom compositor 与 re-export 已从生产源码删除", () => {
	assert.equal(existsSync(resolve(SRC, "features", "fixed-bottom-editor")), false);
	assert.equal(existsSync(resolve(SRC, "features", "bottom-input", "compositor.ts")), false);
	assert.equal(existsSync(resolve(SRC, "features", "bottom-input", "cluster.ts")), false);
});

test("生产源码不再接管 terminal/TUI renderer 或发送私有终端模式序列", () => {
	const source = sourceFiles(SRC).map((file) => readFileSync(file, "utf-8")).join("\n");
	for (const forbidden of [
		"tui.render =",
		"tui.doRender =",
		"terminal.write =",
		"Object.defineProperty(this.terminal, \"rows\"",
		"COMPOSITOR_OWNER",
		"previousViewportTop",
		"hardwareCursorRow",
		"viewportTop",
		"collectChatMessageStartLines",
		"scrollBy(",
		"\\x1b[?1049h",
		"\\x1b[?1002h",
		"parseSgrMouse",
	]) {
		assert.equal(source.includes(forbidden), false, forbidden);
	}
});
