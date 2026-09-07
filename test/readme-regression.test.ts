/** 功能：验证 README 关键使用约束不会回退 实现者：alps 实现日期：2026-05-27 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

/** 读取 README 正文，供回归断言复用。 */
async function readReadme(): Promise<string> {
	return readFile(resolve(import.meta.dirname, "..", "README.md"), "utf-8");
}

async function readToolCompactSpec(): Promise<string> {
	return readFile(resolve(import.meta.dirname, "..", "docs", "tool-compact-mode-spec.md"), "utf-8");
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

	assert.match(readme, /Master Switch\s+统一启用或关闭消息线框、输入框美化、Footer 与动画，默认 ON/);
	assert.match(readme, /Assistant Frame\s+控制 assistant 正文回复是否包线框，默认 ON/);
	assert.match(readme, /Compact Tools\s+Off \/ Compact \/ Collapsed 三态，默认 Compact/);
	assert.match(readme, /Collapse Thinking\s+Collapsed 模式下将连续 Thinking 收起为一至两行稳定摘要，默认 ON/);
	assert.match(readme, /Compact Edit\s+Compact 模式下允许 edit 也极简展示，默认 OFF；Collapsed 时隐藏但保留偏好/);
	assert.match(readme, /`true -> "compact"`，`false -> "off"`/);
	assert.match(readme, /Thinking 与 Tools 互相切组/);
	assert.match(readme, /多行内容最多显示首尾两行/);
	assert.match(readme, /Tools 标题显示实际调用总数，例如 `Tools ×4`/);
	assert.match(readme, /调用数量不设上限，单行超宽时以 `\.\.\.` 截断/);
	assert.match(readme, /所有项都移除树形连接符，只保留同列对齐的 `●`/);
	assert.match(readme, /`\[ N \]`/);
	assert.doesNotMatch(readme, /按工具类型首次出现顺序|最新活动项 `TOOL|`\[ ↑N · ↓N \]`|\+ctx ~|`\[ in N · out N \]`/);
	assert.doesNotMatch(readme, /Fixed Input\s+控制/);
	assert.match(readme, /Beautified Input\s+控制输入框线框与嵌入边框状态，默认 ON/);
	assert.match(readme, /Input Metrics\s+分别控制输入、输出、缓存命中率、Token 速度和耗时，默认全部 ON/);
	assert.match(readme, /Footer\s+控制 Alps Pi 是否接管底部状态栏，默认 ON/);
	assert.match(readme, /Animations\s+配置底部 Working\/Thinking\/Tool 与 hidden thinking 内置动画，默认 ON/);
	assert.match(readme, /Shortcuts\s+管理暂存、复制、剪切和 editor 光标快捷键/);
	assert.doesNotMatch(readme, /底部状态栏\s+显示模型/);
});

test("Collapsed 规格锁定逐调用列表和单一上下文贡献语义", async () => {
	const spec = await readToolCompactSpec();

	assert.match(spec, / ● Read package\.json[\s\S]* ● Grep "collapsed" in src\/[\s\S]* ● Bash npm test[\s\S]* ● Read src\/features\/chrome-frame\/patch\.ts/);
	assert.doesNotMatch(spec, /[├└]/);
	assert.match(spec, /每次调用恰好占一行，不按类型合并，也不设置最大行数/);
	assert.match(spec, /\[ <tokens> \]/);
	assert.match(spec, /Thinking 贡献来自组内完整原始 thinking blocks/);
	assert.match(spec, /pending 不计尚未返回的结果/);
	assert.match(spec, /先移除旧贡献再加入新贡献/);
	assert.doesNotMatch(spec, /Read ×2|最近活动项|\[ ↑<input> · ↓<output> \]/);
});

test("README 说明美化输入框默认开启与 Alt+S 行为", async () => {
	const readme = await readReadme();

	assert.match(readme, /美化输入框默认开启/);
	assert.match(readme, /10 字符进度条和百分比\/窗口显示上下文/);
	assert.match(readme, /`Input Metrics` 子页可分别关闭这五项/);
	assert.match(readme, /`\[图标\] \[数据\]` 紧凑格式/);
	assert.match(readme, /缓存命中率按 `>= 90%`、`>= 60%`、`< 60%` 分别显示为绿、金、红/);
	assert.match(readme, /缓存、输出、输入、速度的顺序整项隐藏/);
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
