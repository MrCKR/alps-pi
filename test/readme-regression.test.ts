/** 功能：验证 README 关键使用约束不会回退 实现者：alps 实现日期：2026-05-27 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

/** 读取 README 正文，供回归断言复用。 */
async function readReadme(): Promise<string> {
	return readFile(resolve(import.meta.dirname, "..", "README.md"), "utf-8");
}

test("README 说明固定输入框默认开启且设置持久化", async () => {
	const readme = await readReadme();

	assert.match(readme, /固定底部输入框默认开启/);
	assert.match(readme, /Fixed Input\s+控制实验性底部固定编辑器 runtime，默认 ON/);
	assert.match(readme, /设置会持久化/);
});

test("README 说明内置 alps 主题", async () => {
	const readme = await readReadme();

	assert.match(readme, /内置 `alps` 主题/);
	assert.match(readme, /"theme": "alps"/);
	assert.match(readme, /themes\/alps\.json/);
	assert.match(readme, /themes\/LICENSE\.synthwave-84/);
});

test("README 说明设置面板项目", async () => {
	const readme = await readReadme();

	assert.match(readme, /Message Frame\s+控制消息、工具与 bash 外框，默认 ON/);
	assert.match(readme, /Assistant Frame\s+控制 assistant 正文回复是否包线框，默认 ON/);
	assert.match(readme, /Compact Tools\s+未展开 tool 只显示第一条有效文本行，默认 ON/);
	assert.match(readme, /Compact Edit\s+允许 edit tool 也按极简模式展示，默认 OFF/);
	assert.match(readme, /Fixed Input\s+控制实验性底部固定编辑器 runtime，默认 ON/);
	assert.match(readme, /Beautified Input\s+控制输入框线框与嵌入边框状态，默认 ON/);
	assert.match(readme, /Shortcuts\s+管理底部输入框快捷键/);
	assert.doesNotMatch(readme, /底部状态栏\s+显示模型/);
});

test("README 说明美化输入框默认开启与 Alt+S 行为", async () => {
	const readme = await readReadme();

	assert.match(readme, /美化输入框默认开启/);
	assert.match(readme, /10 字符上下文进度/);
	assert.match(readme, /extension statuses 与上一个问题保持在线框下方/);
	assert.match(readme, /缺失的数据不会显示占位/);
	assert.match(readme, /Alt\+S.*暂存并清空输入框/);
});

test("README 说明固定输入框绘制接管风险", async () => {
	const readme = await readReadme();

	assert.match(readme, /接管 editor\/footer 和 terminal 绘制/);
	assert.match(readme, /聊天区在上方滚动、输入框固定在底部/);
	assert.match(readme, /session_shutdown/);
});
