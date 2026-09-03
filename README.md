# alps-pi

## 安装

```bash
pi install npm:alps-pi
```

也可以直接从 GitHub 安装：

```bash
pi install git:https://github.com/MrCKR/alps-pi
```

安装后在 pi 内执行：

```text
/reload
```

更新时最简单的方式：

```bash
pi update npm:alps-pi
```

如果使用 GitHub 安装：

```bash
pi remove git:https://github.com/MrCKR/alps-pi
pi install git:https://github.com/MrCKR/alps-pi
```

然后：

```text
/reload
```

## 这是什么

`alps-pi` 是面向 Pi 0.84.4+ 的 TUI 美化扩展。它会给 Pi 内置主要消息块加统一外框，让对话、工具调用和执行结果更容易区分，并提供输入框线框美化、内置 Animations 和 `alps` 主题。固定底部输入框由 Pi 原生 fullscreen TUI 提供。

扩展特点：

- 消息线框默认启用，无需每次手动打开。
- Pi `/settings` 中选择 `TUI mode: fullscreen` 后，使用 Pi 原生固定 editor/status/widget/footer dock。
- 美化输入框默认开启，会显示完整输入框线框，并把模型、thinking、上下文进度和耗时嵌入边框。
- 内置 Animations 默认开启，会完整替代外部 `pi-animations` 的底部 Working/Thinking/Tool 动画，并兼容替换 Pi hidden thinking 的 `Thinking...`。
- `/alps-pi` 设置持久化到独立的 `~/.pi/agent/alps-pi/settings.json`，`/reload` 或新会话后按上次设置恢复。首次升级按“独立主文件 → Pi settings 的 `alps-pi` namespace → `~/.pi/agent/alps-pi.json` → 默认值”读取，并保留原 namespace 供回滚。
- `/alps-pi` 提供设置界面。
- 内置 `alps` theme，基于 Synthwave '84 配色整理进本包。
- 消息组件 monkey patch 可回滚；输入美化只使用 Pi 公开 UI API。
- 普通空消息不会渲染成空白框。
- 消息正文不铺大面积背景色，只渲染边框、标题和正文颜色。
- 可关闭 assistant 正文线框，方便复制回复内容。

## 命令

```text
/alps-pi             打开设置界面
/alps-pi preview     预览美化线框样式
```

`/alps-pi` 设置界面包含五个开关、一个 Animations 配置项和一个快捷键配置项：

```text
Master Switch       统一启用或关闭消息线框、输入框美化与动画，默认 ON
Assistant Frame     控制 assistant 正文回复是否包线框，默认 ON
Compact Tools       未展开 tool 只显示第一条有效文本行，默认 ON
Compact Edit        允许 edit tool 也按极简模式展示，默认 OFF
Beautified Input    控制输入框线框与嵌入边框状态，默认 ON
Animations          配置底部 Working/Thinking/Tool 与 hidden thinking 内置动画，默认 ON
Shortcuts           管理暂存、复制、剪切和 editor 光标快捷键
```

操作方式：

```text
↑/↓ 选择
Enter/Space 切换
Esc/q 关闭
```

## 覆盖范围

扩展会包装这些 Pi TUI 组件：

- `UserMessageComponent`
- `AssistantMessageComponent`
- `CustomMessageComponent`
- `SkillInvocationMessageComponent`
- `CompactionSummaryMessageComponent`
- `BranchSummaryMessageComponent`
- `ToolExecutionComponent`
- `BashExecutionComponent`

默认不会包装：

- 基础 `Loader`
- editor
- footer
- header
- overlay

`alps-pi 0.2.0` 不再接管 terminal viewport。需要固定输入框时，请在 Pi `/settings` 中将 `TUI mode` 设为 `fullscreen`；滚动、选区、鼠标、粘贴和 dock 布局全部由 Pi 原生 TUI 管理。`regular` 模式仍保留消息线框、Beautified Input、状态、Animations 和输入框快捷键，但不会模拟固定 dock。旧 `fixedBottomEditor.enabled` 以及 transcript 滚动/跳转快捷键字段仅原样保留，供回滚到 `0.1.5`，现代 runtime 不读取或执行。

开启 `美化输入框` 后，扩展会把 editor 包装成完整线框：顶部左侧显示模型与 thinking，顶部右侧显示 10 字符上下文进度和百分比/窗口，底部右侧显示本次对话耗时。extension statuses 与上一个问题保持在线框下方，不塞进边框。缺失的数据不会显示占位。`Alt+S` 对齐原版行为：有输入时暂存并清空输入框，输入框为空时恢复暂存内容。

开启 `Animations` 后，扩展会接管 Pi 底部 `Working...` loader：普通 agent 输出期显示 Working 动画，thinking 流式阶段切换为 Thinking 动画，tool 执行阶段切换为 Tool 动画；多行动画会整体写入底部 working 区域，避免和 Todo/widget 混排。hidden thinking 会在思考中播放动画，思考完成后停为 `Thinking complete`，并沿用 Pi thinking 文案配色。该功能用于替代外部 `pi-animations`，请禁用/卸载外部 `pi-animations`，否则可能出现重复动画或 monkey patch 冲突。

## 主题

本包内置 `alps` 主题，随 `pi install git:https://github.com/MrCKR/alps-pi` 一起加载。安装并 `/reload` 后，可在 `/settings` 里选择 `alps`，或写入 Pi 设置：

```json
{
  "theme": "alps"
}
```

`alps` 主题位于：

```text
themes/alps.json
```

该主题基于 `pi-theme-synthwave-84` 的 MIT 授权配色整理并改名，授权文本保留在 `themes/LICENSE.synthwave-84`。

## 颜色控制

线框颜色通过扩展内的 token 映射控制，实际颜色来自当前 pi theme。

默认映射位于：

```text
src/features/chrome-frame/styles.ts
```

常见映射：

```text
user.border          borderAccent
assistant.border     borderMuted
toolSuccess.border   success
toolError.border     error
```

如果只想改本扩展的线框分配，改 `src/features/chrome-frame/styles.ts`。
如果想改所有使用同一 token 的地方，改当前 theme 中对应 token 的颜色。

## 安全策略

- 扩展默认启用消息线框 patch、美化输入框和内置 Animations。
- 设置界面里的线框美化开关会恢复原始 render 方法；如果 render 已被后续扩展接管，alps-pi 会跳过恢复，避免覆盖其它 wrapper。
- patch 是幂等的，重复启用不会重复包裹。
- 核心组件 patch 失败时会自动回滚。
- 用户 prompt、extension status、消息正文进入 terminal 展示前会剥离 OSC/DCS/APC/PM 与非 SGR CSI；主题层生成的 SGR 颜色仍保留。
- Beautified Input 仅通过 Pi 公开的 editor/footer/input API 安装；能力缺失时只关闭对应运行时功能，不回滚用户偏好。
- Alps 不覆盖 `terminal.write`、`terminal.rows`、`tui.render` 或 `tui.doRender`，也不发送 alternate-screen/mouse-reporting 控制序列。
- image escape 行会回退或跳过包装，避免破坏终端图片协议。
- assistant / user / custom / skill / compaction / branch 空内容不会渲染空框。
- tool / bash / working 即使正文为空也保留外框，因为标题和状态本身有信息价值。

## 兼容性

正式运行基线为 Pi `>=0.84.4`。Pi 核心包按官方 package 规则声明为 wildcard peer，开发与发布验证使用 `0.84.4`。

Master Switch 下的消息线框仍依赖 Pi 导出的消息组件与 `render(width)`；Beautified Input 只依赖 `ctx.ui.setEditorComponent`、`ctx.ui.setFooter` 和 `ctx.ui.onTerminalInput`。运行时集中检测组件、Animations 和 TUI mode 能力，缺失时按功能 fail closed 并输出诊断，不修改持久化用户偏好。旧 Pi 用户可回滚到 `alps-pi 0.1.5`。

## 开发

安装依赖：

```bash
npm install
```

运行测试：

```bash
npm test
```

在 Windows nvm 环境里也可以直接指定 npm：

```bash
C:/Users/Administrator/AppData/Local/nvm/v22.22.3/npm.cmd test
```

## 注意

本扩展依赖 Pi 当前的内置 TUI 组件导出。升级 Pi 后如果组件名称、构造方式或 `render(width)` 行为变化，集中 capability gate 会按功能 fail closed；发布前仍必须重新运行真实组件、stable proxy、lifecycle、图片与 Windows Terminal 门禁。
