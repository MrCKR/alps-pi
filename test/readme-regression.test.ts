/** 功能：验证 README 关键使用约束不会回退 实现者：alps 实现日期：2026-05-27 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

/** 读取 README 正文，供回归断言复用。 */
async function readReadme(): Promise<string> {
	return readFile(resolve(import.meta.dirname, "..", "README.md"), "utf-8");
}

test("README 说明固定输入由 Pi fullscreen 原生提供", async () => {
	const readme = await readReadme();

	assert.match(readme, /固定底部输入框由 Pi 原生 fullscreen TUI 提供/);
	assert.match(readme, /`\/settings` 中将 `TUI mode` 设为 `fullscreen`/);
	assert.match(readme, /regular.*不会模拟固定 dock/);
});

test("README 说明独立设置路径、迁移优先级与 namespace 回滚保留", async () => {
	const readme = await readReadme();

	assert.match(readme, /~\/\.pi\/agent\/alps-pi\/settings\.json/);
	assert.match(readme, /独立主文件.*Pi settings.*namespace.*alps-pi\.json.*默认值/);
	assert.match(readme, /保留原 namespace 供回滚/);
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
	assert.doesNotMatch(readme, /Fixed Input\s+控制/);
	assert.match(readme, /Beautified Input\s+控制输入框线框与嵌入边框状态，默认 ON/);
	assert.match(readme, /Animations\s+配置底部 Working\/Thinking\/Tool 与 hidden thinking 内置动画，默认 ON/);
	assert.match(readme, /Shortcuts\s+管理暂存、复制、剪切和 editor 光标快捷键/);
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

test("README 说明 Animations 多行动画和 hidden thinking 完成态", async () => {
	const readme = await readReadme();

	assert.match(readme, /多行动画会整体写入底部 working 区域/);
	assert.match(readme, /Thinking complete/);
	assert.match(readme, /thinking 文案配色/);
});

test("README 说明 Alps 不再接管 terminal viewport", async () => {
	const readme = await readReadme();

	assert.match(readme, /不再接管 terminal viewport/);
	assert.match(readme, /滚动、选区、鼠标、粘贴和 dock 布局全部由 Pi 原生 TUI 管理/);
	assert.match(readme, /不覆盖 `terminal\.write`、`terminal\.rows`、`tui\.render` 或 `tui\.doRender`/);
});
