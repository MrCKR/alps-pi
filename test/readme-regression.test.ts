/** 功能：验证 README 关键使用约束不会回退 实现者：alps 实现日期：2026-05-27 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

/** 读取 README 正文，供回归断言复用。 */
async function readReadme(): Promise<string> {
	return readFile(resolve(import.meta.dirname, "..", "README.md"), "utf-8");
}

test("README 说明固定输入框默认关闭", async () => {
	const readme = await readReadme();

	assert.match(readme, /固定底部输入框默认关闭/);
	assert.match(readme, /固定输入框默认关闭/);
});

test("README 说明设置面板三项", async () => {
	const readme = await readReadme();

	assert.match(readme, /线框美化\s+控制消息、工具与 bash 外框/);
	assert.match(readme, /Assistant 正文线框\s+控制 assistant 正文回复是否包线框/);
	assert.match(readme, /固定输入框\s+控制实验性底部固定编辑器 runtime，默认 OFF/);
});

test("README 说明固定输入框绘制接管风险", async () => {
	const readme = await readReadme();

	assert.match(readme, /接管 editor\/footer 和 terminal 绘制/);
	assert.match(readme, /聊天区在上方滚动、输入框固定在底部/);
	assert.match(readme, /session_shutdown/);
});
