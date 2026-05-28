# Bottom Input / Powerline Parity BDD-TDD 需求冻结

## 1. 背景与目标

本轮目标是把 `alps-pi` 的底部输入框相关能力从“fixed editor runtime + bottom status widget”重构为一个统一的 **bottom-input runtime**，运行模型对齐原版 `pi-powerline-footer`：

```text
一个 ctx.ui.setFooter owner
  捕获 tui / theme / footerData
  安装 fixed editor compositor
  统一组装 fixed editor cluster
  统一渲染主状态栏、extension statuses、editor、last prompt
```

用户已确认：这些能力本质上都是“底部输入框功能”，不应继续拆成多个 `setFooter` / `setWidget` 入口。当前 `bottomStatusRuntime` 通过 `ctx.ui.setWidget(aboveEditor/belowEditor)` 绕开 footerData，是早期实现偏差，本轮必须修正。

工程组织不照搬原版巨型闭包；采用“运行模型对齐原版，代码组织保持 alps-pi 模块化”的方式。

建议结构：

```text
src/features/bottom-input/
  index.ts
  runtime.ts       # 唯一 session/runtime owner：setEditorComponent + setFooter + footerData
  compositor.ts    # 从 fixed-bottom-editor/compositor.ts 迁移/演进
  cluster.ts       # 原版式分层 cluster
  status.ts        # model/think/context/elapsed/statuses/last prompt 渲染
  shortcuts.ts     # 快捷键默认值、配置、匹配、冲突解析
  icons.ts         # Nerd Font / ASCII 图标选择
```

旧目录可保留薄 re-export 或兼容适配，避免一次性破坏外部引用与测试：

```text
src/features/fixed-bottom-editor/*
src/features/bottom-status/*
```

## 2. 本轮范围

### 2.1 必做细节

- 细节 4：context streaming 精细刷新。
- 细节 5：状态栏布局缓存/节流。
- 细节 6：fixed editor 鼠标选择/复制体验。
- 细节 7：editor 边界快捷键。
- 细节 8：message jump 快捷键。

### 2.2 必做大功能

- 大功能 6：extension statuses 聚合。
- 大功能 12：copy/cut editor。
- 大功能 13：shortcut 配置与冲突解析，并在 `/alps-pi` 设置界面提供二级快捷键绑定界面。
- 大功能 14：Nerd Font 自动检测与 ASCII fallback。

### 2.3 明确不做

- 大功能 7：custom items。本轮不做，后续单独讨论。
- 大功能 1：完整 preset/config 系统。
- 大功能 10：bash mode。
- welcome overlay。
- working vibes。
- stash history 面板。
- git/path/cost/token in/out/cache 独立 segment。
- 恢复 `/alps-pi enable`、`/alps-pi disable`、`/alps-pi config`、`/alps-pi config-ui`、literal `/alps-pi settings` 等旧子命令。

## 3. 原版行为证据

参考仓库：

```text
D:/workspace/alps-unity-mcp/Temp/pi-powerline-footer
```

关键文件：

```text
index.ts
fixed-editor/cluster.ts
fixed-editor/terminal-split.ts
segments.ts
context-usage.ts
powerline-config.ts
shortcuts.ts
icons.ts
theme.ts
```

### 3.1 单一 footer owner

原版 `index.ts` 使用一个 `ctx.ui.setFooter((tui, theme, footerData) => ...)` 入口：

```ts
ctx.ui.setFooter((tui, _theme, footerData) => {
  footerDataRef = footerData;
  installFooterStatusRepaintHook(footerData);
  ...
});
```

所有底部状态能力通过同一个 footer owner 获取：

```ts
footerDataRef?.getGitBranch()
footerDataRef?.getExtensionStatuses()
```

本轮必须对齐这个运行模型：`bottom-input runtime` 是唯一 footer owner。`bottom status` 不再调用 `ctx.ui.setWidget` 注册 above/below widget 来渲染底部状态。

### 3.2 fixed cluster 分层

原版 `fixed-editor/cluster.ts` 分层：

```text
statusLines
トップ topLines
editorLines
secondaryLines
transcriptLines
lastPromptLines
```

本轮不做 transcript/bash mode，但保留同类分层：

```text
statusLines       # 原生 status / working 动画 / todo 等
 topLines         # 主状态栏：model / think / context / elapsed
 editorLines      # 输入框
 secondaryLines   # extension statuses / stash indicator 等
 lastPromptLines  # ↳ 上一个问题
```

顺序必须保证：working 动画位于主状态栏上方，不得插在主状态栏和输入框之间。

### 3.3 context usage

原版 `context-usage.ts`：

```ts
ctx.getContextUsage() -> tokens/contextWindow/percent
```

原版 `index.ts` 在 streaming 时避免旧 core context usage 覆盖 live usage：

```ts
const coreContextUsage = isStreaming && liveAssistantUsage ? null : readCoreContextUsage(ctx);
```

本轮需对齐此策略。

### 3.4 thinking segment

原版 `segments.ts`：

- `high` / `xhigh` 使用 `rainbow(content)`。
- `minimal` / `low` / `medium` / `off` 使用语义色。

原版 `theme.ts`：

```text
#b281d6 #d787af #febc38 #e4c00f #89d281 #00afaf #178fb9 #b281d6
```

`rainbow(text)` 对除空格和冒号之外的字符轮换上色，冒号不着色。

### 3.5 shortcuts

原版 `shortcuts.ts` 提供：

- `matchesConfiguredShortcut()`
- `shortcutUsesSuper()`
- `isSupportedSuperShortcut()`
- `shortcutConflictKey()`

原版支持 `cmd` / `command` 作为 `super` 语义，并针对 Super/Command 箭头类快捷键做终端 escape fallback。

### 3.6 selection / copy

原版 `fixed-editor/terminal-split.ts` 支持：

- 鼠标拖拽选择 root/chat 区和 cluster 区文本。
- 选区反色。
- release 自动复制。
- 拖到 viewport 边缘时滚动。
- 双击选择整行。
- 右键选区时临时暂停 mouse reporting，让终端菜单接管。

本轮需实现核心能力，但以稳定和可恢复优先。

## 4. 架构冻结

### 4.1 BottomInputRuntime 是唯一底部输入框 runtime

新增统一 runtime，负责：

```text
bindSession(ctx)
setEnabled(enabled)
dispose()
getStatus()
setBottomStatusEnabled(enabled)
setThinkingLevel(level)
setLastPrompt(prompt)
setLiveUsage(usage)
clearLiveUsage()
setStreaming(streaming)
stash/copy/cut editor
shortcuts install/uninstall
```

### 4.2 唯一 setFooter owner

`BottomInputRuntime` 同时调用：

```ts
ctx.ui.setEditorComponent(editorFactory)
ctx.ui.setFooter(footerFactory)
```

`footerFactory(tui, theme, footerData)` 负责：

```text
保存 tui/theme/footerData
安装 compositor
给 compositor renderCluster 回调提供所有底部行
安装 footerData repaint hook
```

### 4.3 Bottom status 不再注册 widget

删除或停用当前：

```text
ctx.ui.setWidget("alps-pi-bottom-status", ..., { placement: "aboveEditor" })
ctx.ui.setWidget("alps-pi-last-prompt", ..., { placement: "belowEditor" })
```

状态行改由 `renderCluster` 注入：

```ts
renderFixedEditorCluster({
  statusLines,
  topLines: renderTopStatusLines(...),
  editorLines,
  secondaryLines: renderExtensionStatusLines(...),
  lastPromptLines: renderLastPromptLines(...),
});
```

### 4.4 fixed editor 关闭时 bottom status 的行为

`固定输入框` 是底部输入框系统的总开关。`底部状态栏` 是底部输入框内部的状态行开关。

规则：

```text
fixedBottomEditor.enabled = false:
  不安装 bottom-input footer/compositor
  bottomStatus.enabled 可保持持久化为 true，但运行时不显示
  /alps-pi 设置面板说明 bottom status requires fixed editor

fixedBottomEditor.enabled = true 且 bottomStatus.enabled = true:
  显示 topLines / secondaryLines / lastPromptLines

fixedBottomEditor.enabled = true 且 bottomStatus.enabled = false:
  仍固定输入框，但不显示主状态栏、extension statuses、last prompt
```

不自动改写用户的 `bottomStatus.enabled` 设置。

## 5. 功能规格

### 5.1 主状态栏 topLines

启用 bottom status 时，输入框上方显示：

```text
[model] › [think] › [ctx] › [elapsed]
```

- model：只显示模型名，例如 `GPT-5.5`，不显示 host/provider。
- think：按原版 thinking segment；`high/xhigh` rainbow。
- ctx：细线进度条；百分比和 context window 与进度条同色。
- elapsed：从当前 UI session 打开/绑定时刻开始，不用历史 conversation 创建时间；最小单位秒，无小数。

context 有 window：

```text
ctx ━━╸─── 59.8%/272k
```

context 无 window 但有 used tokens：

```text
ctx 37k
```

context 连 used tokens 都没有：隐藏该 segment。

### 5.2 extension statuses secondaryLines

启用 bottom status 时，输入框下方、last prompt 上方显示 extension statuses 聚合行。

来源：

```ts
footerData.getExtensionStatuses()
```

过滤规则对齐原版：

- 跳过空值。
- 跳过纯 ANSI / 无可见宽度值。
- 跳过 notification 型，即 trimStart 后以 `[` 开头的值。
- 跳过 internal hidden key（本轮至少跳过 bottom-input 自己内部用的 key）。

显示格式：

```text
statusA › statusB › statusC
```

如无可显示状态，隐藏该行。

### 5.3 last prompt lastPromptLines

输入框下方最后显示：

```text
↳ 上一个问题
```

来源：`before_agent_start` 的 `event.prompt`。

规则：

- 压缩连续空白为单个空格。
- 一行显示。
- 按宽度截断。
- 无内容隐藏。

### 5.4 context streaming 精细刷新

运行时维护：

```text
isStreaming
liveUsage
latestAssistantUsage
```

事件：

```text
agent_start      -> isStreaming = true; liveUsage = null
message_update   -> 如果是 assistant usage，更新 liveUsage
message_end      -> isStreaming = false; liveUsage = null
turn_end         -> isStreaming = false; liveUsage = null
```

渲染：

```text
if isStreaming && liveUsage:
  不读取或不优先使用 ctx.getContextUsage()
  使用 liveUsage/latestUsage 估算 context used
else:
  优先 ctx.getContextUsage()
```

### 5.5 状态栏缓存/节流

`requestRender()` 进入 debounce 调度，不应在高频事件中直接连续 `tui.requestRender()`。

建议：

```text
STATUS_RENDER_DEBOUNCE_MS = 33
LAYOUT_CACHE_TTL_MS = 250
STREAMING_LAYOUT_CACHE_TTL_MS = 1000
```

缓存 key 至少包含：

```text
width
model
thinking
context tokens/window/percent
elapsed seconds
last prompt
extension statuses snapshot
bottomStatus enabled
icons mode
```

输入期间不要强制整屏 reset；普通状态变化使用普通 repaint/requestRender。

### 5.6 鼠标选择/复制体验

启用 fixed editor 且 mouse reporting 可用时：

- 左键按下开始选择。
- 左键拖拽更新 selection。
- release 时复制选中文本。
- selection 区域支持 root/chat 区与 cluster 区。
- selection 高亮使用反色。
- 双击选择当前行。
- 在 root/chat 区拖到 viewport 顶/底边缘时自动滚动。
- 右键点击已选区域时，临时暂停 mouse reporting，让终端上下文菜单接管。

复制实现使用 Pi 官方 `copyToClipboard` 或同等 API。

失败策略：

- 复制失败不破坏输入和滚动。
- dispose 时清空 selection、timer、mouse mode。
- overlay 可见时不消费选择输入。

### 5.7 editor 边界快捷键

默认快捷键：

```text
editorStart: super+shift+up
editorEnd:   super+shift+down
```

行为：

- 移动 editor cursor 到输入内容开头/末尾。
- 如 editor 实例没有稳定 API，则 fail-soft，不消费输入。
- 支持原版 Super/Command 箭头 escape fallback。

### 5.8 message jump 快捷键

默认快捷键：

```text
jumpPreviousUserMessage:      ctrl+shift+u
jumpNextUserMessage:          ctrl+shift+i
jumpPreviousAssistantMessage: ctrl+alt+,
jumpNextAssistantMessage:     ctrl+alt+.
jumpChatBottom:               ctrl+shift+g
```

行为：

- 只在 fixed editor 已安装时生效。
- 根据 TUI component tree 识别 user/assistant message component。
- 计算目标 message 起始行。
- 调整 compositor 内部 scrollOffset。
- `jumpChatBottom` 回到最新底部。
- 识别失败时 fail-soft，不影响输入。

### 5.9 copy/cut editor

默认快捷键：

```text
copyEditor: ctrl+alt+c
cutEditor:  ctrl+alt+x
```

行为：

```text
copy:
  editor 有文本 -> copyToClipboard(text), notify "Copied editor text"
  editor 为空 -> notify "Nothing to copy"

cut:
  editor 有文本 -> copyToClipboard(text), setEditorText(""), notify "Cut editor text"
  editor 为空 -> notify "Nothing to cut"
```

约束：

- 不改变 stash 状态。
- 不改变 stash history（本轮不做 stash history）。
- overlay 可见时 raw input 不消费。

### 5.10 shortcut 配置与二级设置界面

新增顶层设置：

```ts
settings.shortcuts = {
  stashEditor,
  copyEditor,
  cutEditor,
  scrollChatUp,
  scrollChatDown,
  editorStart,
  editorEnd,
  jumpPreviousUserMessage,
  jumpNextUserMessage,
  jumpPreviousAssistantMessage,
  jumpNextAssistantMessage,
  jumpChatBottom,
}
```

默认值对齐原版语义：

```text
stashEditor: alt+s
copyEditor: ctrl+alt+c
cutEditor: ctrl+alt+x
scrollChatUp: super+up
scrollChatDown: super+down
editorStart: super+shift+up
editorEnd: super+shift+down
jumpPreviousUserMessage: ctrl+shift+u
jumpNextUserMessage: ctrl+shift+i
jumpPreviousAssistantMessage: ctrl+alt+,
jumpNextAssistantMessage: ctrl+alt+.
jumpChatBottom: ctrl+shift+g
```

`/alps-pi` 设置界面新增第五项：

```text
快捷键设置    管理底部输入框快捷键
```

二级界面：

```text
快捷键设置
  Alt+S 暂存/恢复        alt+s
  复制输入框             ctrl+alt+c
  剪切输入框             ctrl+alt+x
  聊天上滚               super+up
  聊天下滚               super+down
  编辑器到开头           super+shift+up
  编辑器到末尾           super+shift+down
  上一条用户消息         ctrl+shift+u
  下一条用户消息         ctrl+shift+i
  上一条助手消息         ctrl+alt+,
  下一条助手消息         ctrl+alt+.
  回到底部               ctrl+shift+g
```

交互：

```text
↑/↓        选择
Enter      进入快捷键捕获模式
Backspace  恢复当前项默认值
Esc/q      返回上级
```

捕获模式：

```text
请按新的快捷键，Esc 取消，Backspace 恢复默认
```

冲突规则：

- 拒绝 Pi 保留键。
- 拒绝与其他 alps-pi 快捷键重复。
- `cmd` / `command` 归一为 `super`。
- 不支持的 Command-letter 不应误判为普通文本输入。
- 冲突时 UI 提示，不静默覆盖。
- settings 缺字段时使用默认值。

### 5.11 Nerd Font / ASCII fallback

新增图标选择模块，轻量实现，不引入完整原版 icon/preset 系统。

检测优先级：

```text
ALPS_PI_NERD_FONT=1 -> 强制 nerd
ALPS_PI_NERD_FONT=0 -> 强制 ascii
POWERLINE_NERD_FONTS=1 -> 强制 nerd
POWERLINE_NERD_FONTS=0 -> 强制 ascii
TERM_PROGRAM / terminal 名称命中 iTerm / WezTerm / Kitty / Ghostty / Alacritty -> nerd
否则 ascii
```

状态栏保持简洁；图标只能增强，不应破坏当前纯文本可读性。

示例：

```text
nerd: 󰚩 GPT-5.5 › think:xhigh › ctx ━━╸── 59.8%/272k › 󰥔 3m24s
ascii: GPT-5.5 › think:xhigh › ctx ━━╸── 59.8%/272k › 3m24s
```

如图标造成乱码，应通过 env 强制 ASCII。

## 6. BDD 场景

### 6.1 唯一 footer owner

Given fixed editor 与 bottom status 均启用  
When session_start 安装底部输入框  
Then 只应调用一次 `ctx.ui.setFooter(factory)`  
And bottom status 不应调用 `ctx.ui.setWidget(... aboveEditor/belowEditor ...)` 渲染状态栏  
And footer factory 应捕获 `footerData` 供 extension statuses 使用。

### 6.2 status/working 不插入主状态栏和输入框之间

Given 原生 statusContainer 正在显示 working 动画  
And bottom status top line 已启用  
When fixed cluster 渲染  
Then working 动画应位于 top status 上方  
And top status 应贴近 editor 上方  
And editor 下方显示 secondary/last prompt。

### 6.3 extension statuses 聚合

Given footerData.getExtensionStatuses 返回多个 status  
And 其中包含空值、notification `[xxx]`、纯 ANSI 值  
When 渲染 secondaryLines  
Then 只显示有效 compact statuses  
And 使用 ` › ` 分隔  
And 放在 editor 下方、last prompt 上方。

### 6.4 context streaming

Given agent 正在 streaming  
And message_update 提供 liveUsage  
And ctx.getContextUsage 返回旧值  
When 渲染 context segment  
Then 应优先使用 liveUsage/latest usage 估算  
And 不应被旧 core context usage 覆盖。

### 6.5 render debounce/cache

Given 多个状态事件在 33ms 内连续触发  
When requestRender 被调用多次  
Then TUI repaint 应被合并  
And 不应连续触发多次完整 render。

### 6.6 鼠标选择复制

Given fixed editor 已启用 mouse reporting  
When 用户在聊天区拖拽选择文本并释放  
Then 选中文本被复制到剪贴板  
And 选择区域在拖拽期间反色  
And 不破坏滚轮滚动。

### 6.7 右键菜单让路

Given 当前有选中文本  
When 用户右键点击选区  
Then mouse reporting 临时暂停  
And 终端右键菜单可打开  
And 后续自动恢复 mouse reporting。

### 6.8 editor 边界快捷键

Given editor 中有多行文本  
When 用户按 editorStart  
Then cursor 移到输入开头  
When 用户按 editorEnd  
Then cursor 移到输入末尾。

### 6.9 message jump

Given 聊天区包含多条 user/assistant message  
When 用户按 jumpPreviousUserMessage  
Then viewport 跳到上一条 user message  
When 用户按 jumpChatBottom  
Then viewport 回到底部。

### 6.10 copy/cut editor

Given editor 有文本  
When 用户按 copyEditor  
Then 文本复制到剪贴板且 editor 不变  
When 用户按 cutEditor  
Then 文本复制到剪贴板且 editor 清空  
And stash 状态不改变。

### 6.11 快捷键二级设置界面

Given 用户打开 `/alps-pi`  
When 选择 `快捷键设置` 并按 Enter  
Then 进入二级快捷键界面  
When 对某项按 Enter 并输入新快捷键  
Then 若合法则持久化并立即生效  
And 若冲突则显示错误并保留旧值。

### 6.12 Nerd Font fallback

Given `ALPS_PI_NERD_FONT=0`  
When 渲染状态栏  
Then 不显示 Nerd Font 图标  
Given `ALPS_PI_NERD_FONT=1`  
When 渲染状态栏  
Then 可显示 Nerd Font 图标。

## 7. TDD 测试计划

### 7.1 新增/改造测试文件

建议新增：

```text
test/bottom-input-runtime.test.ts
test/bottom-input-shortcuts.test.ts
test/bottom-input-status.test.ts
test/bottom-input-icons.test.ts
```

保留并迁移现有：

```text
test/fixed-bottom-editor-cluster.test.ts
test/fixed-bottom-editor-compositor.test.ts
test/fixed-bottom-editor-runtime.test.ts
test/bottom-status.test.ts
```

可将旧测试改为兼容 re-export 或逐步迁移到 bottom-input 命名。

### 7.2 Runtime 测试

断言：

- fixed editor + bottom status 启用时，只安装一个 footer factory。
- bottom status 不再注册 above/below widget。
- footer factory 捕获 footerData。
- fixed editor OFF 时 bottom status 运行时不显示，但设置不被强制改写。
- session_shutdown 恢复 editor/footer/compositor，清理 timers/listeners/selection。
- `/reload` 后按持久化设置恢复。

### 7.3 Cluster 测试

断言：

- 分层顺序：`status -> top -> editor -> secondary -> lastPrompt`。
- 高度不足时优先保留 editor/top/lastPrompt。
- working/status 不会插入 top 和 editor 之间。
- cursor marker 提取正确。
- ANSI/CJK/emoji 宽度不越界。

### 7.4 Status 测试

断言：

- model 只显示模型名。
- think high/xhigh rainbow，冒号不着色。
- context 有 window 显示细线进度和同色百分比。
- context 无 window 只显示 used tokens。
- streaming 时 liveUsage 优先级高于旧 ctx.getContextUsage。
- extension statuses 过滤和聚合。
- last prompt 压缩、截断、隐藏。
- elapsed 从 session bind/start 开始。

### 7.5 Shortcut 测试

断言：

- 默认 shortcut 与原版语义一致。
- `cmd`/`command` normalize 为 `super`。
- 保留键被拒绝。
- 重复快捷键被拒绝。
- Backspace 恢复默认。
- 设置持久化后 `/reload` 恢复。
- raw terminal input 能匹配 configured shortcut。
- Alt+S 多编码仍兼容。

### 7.6 Compositor selection 测试

断言：

- 鼠标拖拽 root 区建立 selection。
- release 时调用 copy callback。
- cluster 区 selection 可复制。
- 双击选择整行。
- viewport edge drag 改变 scrollOffset。
- overlay 可见时不消费 selection input。
- dispose 清理 selection/timers/mouse mode。

### 7.7 Settings UI 测试

断言：

- `/alps-pi` 设置面板出现 `快捷键设置` 第五项。
- Enter 进入二级面板。
- 捕获模式渲染提示。
- 合法快捷键写入 settings 并调用 `onSettingsChanged`。
- 冲突快捷键显示错误并保留原值。
- Esc 从二级返回一级；再次 Esc 关闭。

### 7.8 README 回归测试

断言 README 说明：

- 统一 bottom input footer owner。
- 快捷键二级设置。
- copy/cut editor。
- message jump。
- mouse selection/copy。
- extension statuses 聚合。
- Nerd Font fallback。

## 8. 实施阶段

### 阶段 1：架构迁移

- 新增 `bottom-input` feature。
- 迁移 fixed editor compositor/cluster。
- bottom status 不再使用 `ctx.ui.setWidget`。
- 统一 footer factory 捕获 `footerData`。
- 维持现有功能测试通过。

### 阶段 2：状态与 extension statuses

- 抽 `status.ts`。
- 实现 streaming context。
- 实现 extension statuses secondary line。
- 实现 render cache/debounce。

### 阶段 3：快捷键基础设施与 UI

- 新增 `shortcuts.ts`。
- settings 增加 shortcuts。
- 设置面板增加二级快捷键绑定界面。
- copy/cut editor 接入。

### 阶段 4：fixed editor 增强

- 鼠标 selection/copy。
- editor boundary shortcuts。
- message jump。

### 阶段 5：Nerd Font / ASCII fallback

- 新增 icons module。
- 环境变量 override。
- README 与测试。

## 9. 风险与回滚

- terminal mouse selection 是最高风险项；必须 fail-soft，dispose 必须恢复 mouse reporting。
- 架构迁移可能影响 fixed editor 默认 ON；必须保留强 teardown/recovery。
- shortcut 捕获不能吞掉普通输入；overlay 可见时不消费。
- extension statuses 拿不到 footerData 时隐藏，不报错。
- Nerd Font 检测不准时必须允许 env 强制 ASCII。

## 10. 验证命令

```bash
cd /d/workspace/alps-pi && C:/Users/Administrator/AppData/Local/nvm/v22.22.3/npm.cmd test
```

安装验证：

```bash
cd /d/workspace/alps-pi && C:/Users/Administrator/AppData/Local/nvm/v22.22.3/pi.cmd install D:/workspace/alps-pi
```

手测：

```text
/reload
/alps-pi
开启固定输入框与底部状态栏
进入快捷键设置二级面板
测试 copy/cut、jump、selection、context streaming、extension statuses、Nerd Font fallback
```
