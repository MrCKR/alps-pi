# 美化输入框线框化方案

## 背景

`alps-pi` 已经有固定底部输入框能力，并把底部状态栏、extension statuses、last prompt 统一收进 bottom-input runtime。接下来要把输入框本身做成可独立开启的线框样式，并把原先状态栏内容嵌入输入框边框。

注意：用户本地当前已有一些安全相关修改，后续实现不得回滚、覆盖或顺手重构这些无关改动。所有修改必须保持外科手术式，围绕本方案最小变更。

## 目标模型

保留两个相互独立的设置：

```text
固定输入框  ON/OFF
美化输入框  ON/OFF
```

删除旧设置：

```text
底部状态栏  ON/OFF
```

### 固定输入框

只控制输入框位置与 fixed bottom runtime：

- ON：输入框固定在底部，聊天内容在上方滚动。
- OFF：回到 Pi 原生输入区位置/布局。

### 美化输入框

只控制输入框视觉样式：

- ON：输入框使用线框样式，并把 model、thinking、context、elapsed 嵌入边框。
- OFF：输入框使用普通样式，不渲染这套线框状态。

两个开关互不依赖。固定输入框关闭时，美化输入框仍可作为配置存在；如果当前实现无法在非 fixed 原生输入区接管 editor，也必须保留设置语义，不得把它强绑定到固定输入框。

## 视觉规格

美化输入框开启时，目标样式：

```text
╭ GPT-5.5 · xhigh ───────────── ━━━━━╸──── 59.5%/272k ╮
│ > 输入内容                                           │
│   多行输入内容                                       │
╰────────────────────────────────────── ◷ 6m17s ──────╯
```

要求：

- 输入区是完整线框：`╭ ╮ ╰ ╯ │ ─`。
- 顶部左侧显示 model 与 thinking：`GPT-5.5 · xhigh`。
  - 不显示 `think:`。
  - 使用 `·` 分隔。
- 顶部右侧显示 context 进度：`━━━━━╸──── 59.5%/272k`。
  - 不显示 `ctx`。
  - 不显示 `上下文`。
  - 不显示 `[]`。
- 底部右侧显示 elapsed：`◷ 6m17s`。
- 颜色保持现有状态栏颜色规则：
  - model、thinking、context、elapsed 保持当前颜色体系。
  - context 阈值颜色保持正常/警告/危险规则。
  - 线框颜色沿用当前边框 token。
- context 进度条宽度从 6 个字符改为 10 个字符。

## extension statuses 与 last prompt

保持在线框输入框下方，不塞入输入框边框：

```text
╭ GPT-5.5 · xhigh ───────────── ━━━━━╸──── 59.5%/272k ╮
│ > 输入内容                                           │
╰────────────────────────────────────── ◷ 6m17s ──────╯
CodeGraph watcher active › stash
↳ 上一个问题
```

## 配置变更

删除旧配置字段：

```ts
bottomStatus
```

新增配置字段建议：

```ts
beautifiedInput: {
  enabled: true
}
```

保留：

```ts
fixedBottomEditor: {
  enabled: true
}
```

迁移策略：

- 新默认值：`beautifiedInput.enabled = true`。
- 读取旧持久化设置时忽略并丢弃 `bottomStatus`。
- 写回 `~/.pi/agent/settings.json["alps-pi"]` 时不再输出 `bottomStatus`。
- 不要因为删除 `bottomStatus` 而影响其它 Pi 原生 settings 字段。
- `ALPS_PI_SETTINGS_PATH` 继续作为测试隔离路径。

## 设置 UI

`/alps-pi` 设置页保留 Pi 原生 settings 风格：

- non-overlay `ctx.ui.custom(factory)`。
- `SettingsList`。
- 上下 `DynamicBorder` 风格横线。
- `enableSearch: true`。
- `maxVisible = 10`。

设置项目标：

```text
线框美化                  OFF
Assistant 正文线框        ON
Tool 极简模式             ON
极简下收起 edit           OFF
固定输入框                ON
美化输入框                ON
快捷键设置                configure
```

删除：

```text
底部状态栏
```

## 性能约束

这次改动必须保护已修复的滚动性能：

- 普通聊天区滚动不得触发 full TUI render。
- 普通滚动路径不得强制重绘底部 cluster。
- 不得恢复每次滚动 `tui.requestRender()`。
- 线框渲染只能在 editor/cluster repaint 路径内完成。
- 不得重复读取昂贵状态：context usage、extension statuses、thinking 等应复用现有 status layout/cache。
- 线框包装复杂度应为 O(editorLines)，不能依赖历史消息数量。
- 必须保持 wheel coalescing 与 rootLines cache 的现有策略。

## 正确性约束

- 保持 cursor marker 提取与 cursor 坐标正确。
- editor 可用宽度应稳定，避免输入换行抖动。
- 多行输入必须每行有左右边框。
- 宽度不足时允许优雅降级，但不得抛异常。
- fixed 输入框关闭时不得强行安装 fixed runtime。
- 美化输入框关闭时不得显示边框状态。
- 状态栏独立开关删除后，状态显示由美化输入框开关决定。

## 测试要求

至少覆盖：

1. 默认设置包含：
   - `fixedBottomEditor.enabled = true`
   - `beautifiedInput.enabled = true`
   - 不再包含 `bottomStatus`
2. 设置 UI 展示 `固定输入框` 与 `美化输入框`，不展示 `底部状态栏`。
3. context bar 总宽度为 10。
4. 美化输入框 ON 时：
   - top border 包含 model/thinking/context。
   - context 不包含 `ctx`。
   - bottom border 包含 elapsed。
   - editor 内容在左右边框内。
5. 美化输入框 OFF 时：
   - 不渲染输入框线框。
   - 不渲染嵌入边框状态。
6. `extension statuses` 和 `last prompt` 仍在线框下方。
7. cursor marker 仍能被提取并正确定位。
8. 普通滚动不重绘底部 cluster 的现有性能测试不能退化。
9. settings store 写回时删除/忽略旧 `bottomStatus`，保留 Pi settings 其它字段。

## 实施提醒

- 用户明确说本地有安全修改：不要 reset、checkout 或覆盖无关文件。
- 不要顺手重构 chrome frame、settings store 以外无关逻辑。
- 不要恢复旧 `/alps-pi enable/disable/config/settings` 命令入口。
- `/alps-pi preview` 保持 overlay 行为。
