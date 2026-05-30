# alps-pi

## 安装

```bash
pi install git:https://github.com/MrCKR/alps-pi
```

安装后在 pi 内执行：

```text
/reload
```

更新时最简单的方式：

```bash
pi remove git:https://github.com/MrCKR/alps-pi
pi install git:https://github.com/MrCKR/alps-pi
```

然后：

```text
/reload
```

## 这是什么

`alps-pi` 是我的 pi 美化扩展。目前它会给 pi 内置的主要消息块加统一外框，让对话、工具调用和执行结果在终端里更容易区分；也提供默认开启的固定底部输入框、输入框线框美化、内置 Animations 和内置 `alps` 主题。

扩展特点：

- 消息线框默认启用，无需每次手动打开。
- 固定底部输入框默认开启，可以在 `/alps-pi` 设置界面关闭。
- 美化输入框默认开启，会显示完整输入框线框，并把模型、thinking、上下文进度和耗时嵌入边框。
- 内置 Animations 默认开启，会完整替代外部 `pi-animations` 的底部 Working/Thinking/Tool 动画，并兼容替换 Pi hidden thinking 的 `Thinking...`。
- `/alps-pi` 设置会持久化到 Pi 原生 `~/.pi/agent/settings.json` 的 `"alps-pi"` 字段，`/reload` 或新会话后会按上次设置恢复。
- `/alps-pi` 提供设置界面。
- 内置 `alps` theme，基于 Synthwave '84 配色整理进本包。
- 运行期 monkey patch 和固定输入框 runtime 可回滚。
- 普通空消息不会渲染成空白框。
- 消息正文不铺大面积背景色，只渲染边框、标题和正文颜色。
- 可关闭 assistant 正文线框，方便复制回复内容。

## 命令

```text
/alps-pi             打开设置界面
/alps-pi preview     预览美化线框样式
```

`/alps-pi` 设置界面目前保留六个开关、一个 Animations 配置项和一个快捷键配置项：

```text
Message Frame       控制消息、工具与 bash 外框，默认 ON
Assistant Frame     控制 assistant 正文回复是否包线框，默认 ON
Compact Tools       未展开 tool 只显示第一条有效文本行，默认 ON
Compact Edit        允许 edit tool 也按极简模式展示，默认 OFF
Fixed Input         控制实验性底部固定编辑器 runtime，默认 ON
Beautified Input    控制输入框线框与嵌入边框状态，默认 ON
Animations          配置底部 Working/Thinking/Tool 与 hidden thinking 内置动画，默认 ON
Shortcuts           管理底部输入框快捷键
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

开启 `固定输入框` 后，扩展会临时接管 editor/footer 和 terminal 绘制，以实现“聊天区在上方滚动、输入框固定在底部”。这属于实验性绘制接管，也是独占 editor/footer 的能力：如果其它扩展同时接管 editor/footer，可能互斥；检测到必要 UI API 缺失或安装失败时会 fail closed 并自动关闭 Fixed Input。关闭开关或 `session_shutdown` 时会恢复 Pi 默认 editor/footer，并重置终端滚动区域和光标状态；reload/session replacement 的旧 runtime 不会清理新 session 已安装的 UI。当前 Pi 只对 editor 暴露可确认 owner 的 getter，footer 缺少公开 getter/owner token/disposable handle；alps-pi 会用保存的 footer component active sentinel 做保守清理，不能确认仍属 alps-pi 时会跳过清理，这是不改 picore 前提下的 partial mitigation。

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

- 扩展默认启用消息线框 patch；固定输入框、美化输入框和内置 Animations 默认开启。
- 设置界面里的线框美化开关会恢复原始 render 方法；如果 render 已被后续扩展接管，alps-pi 会跳过恢复，避免覆盖其它 wrapper。
- patch 是幂等的，重复启用不会重复包裹。
- 核心组件 patch 失败时会自动回滚。
- 用户 prompt、extension status、消息正文进入 terminal 展示前会剥离 OSC/DCS/APC/PM 与非 SGR CSI；主题层生成的 SGR 颜色仍保留。
- 固定输入框启用失败会 fail closed，并回滚 editor/footer/compositor，同时把 Fixed Input 设置同步为 OFF。
- 固定输入框会接管 `terminal.write`、`terminal.rows`、`tui.render`、`tui.doRender` 和滚动区域；关闭或 shutdown 时会尽力恢复。
- image escape 行会回退或跳过包装，避免破坏终端图片协议。
- assistant / user / custom / skill / compaction / branch 空内容不会渲染空框。
- tool / bash / working 即使正文为空也保留外框，因为标题和状态本身有信息价值。

## 兼容性

当前测试版本窗口：

```text
@earendil-works/pi-coding-agent >=0.75.5 <0.76.0
@earendil-works/pi-tui          >=0.75.5 <0.76.0
```

`alps-pi` 的 Message Frame、Fixed Input 与 Beautified Input 依赖 Pi 当前导出的 TUI component、`render(width)`、`ctx.ui.setEditorComponent`、`ctx.ui.setFooter`、terminal descriptor 等内部 UI 能力。不在上述窗口内的 Pi 版本不再声明兼容；运行时如果发现关键字段或方法缺失，对应功能会 fail closed 或跳过 patch，而不是继续覆盖原型或 editor/footer。

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

本扩展依赖 Pi 当前的内置 TUI 组件导出。升级 pi 后如果内置组件名称、构造方式或 `render(width)` 行为变化，需要重新跑测试并同步适配；验证通过后再扩大 peer dependency 窗口。
