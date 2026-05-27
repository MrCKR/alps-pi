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

`alps-pi` 是我的 pi 美化扩展。目前它会给 pi 内置的主要消息块加统一外框，让对话、工具调用和执行结果在终端里更容易区分；也提供一个默认关闭的实验性固定底部输入框。

扩展特点：

- 消息线框默认启用，无需每次手动打开。
- 固定底部输入框默认关闭，需要在 `/alps-pi` 设置界面手动开启。
- 固定输入框默认关闭，`/reload` 或 `session_shutdown` 后不会自动重装。
- `/alps-pi` 提供设置界面。
- 运行期 monkey patch 和固定输入框 runtime 可回滚。
- 普通空消息不会渲染成空白框。
- 消息正文不铺大面积背景色，只渲染边框、标题和正文颜色。
- 可关闭 assistant 正文线框，方便复制回复内容。

## 命令

```text
/alps-pi             打开设置界面
/alps-pi status      查看当前 patch 与固定输入框状态
/alps-pi preview     预览美化线框样式
```

`/alps-pi` 设置界面目前保留三个开关：

```text
线框美化              控制消息、工具与 bash 外框
Assistant 正文线框    控制 assistant 正文回复是否包线框
固定输入框            控制实验性底部固定编辑器 runtime，默认 OFF
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

开启 `固定输入框` 后，扩展会临时接管 editor/footer 和 terminal 绘制，以实现“聊天区在上方滚动、输入框固定在底部”。这属于实验性绘制接管。关闭开关或 `session_shutdown` 时会恢复 Pi 默认 editor/footer，并重置终端滚动区域和光标状态。

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

- 扩展默认启用消息线框 patch；固定输入框默认关闭。
- 设置界面里的线框美化开关会恢复原始 render 方法。
- patch 是幂等的，重复启用不会重复包裹。
- 核心组件 patch 失败时会自动回滚。
- 固定输入框启用失败会 fail closed，并回滚 editor/footer/compositor。
- 固定输入框会接管 `terminal.write`、`terminal.rows`、`tui.render`、`tui.doRender` 和滚动区域；关闭或 shutdown 时会尽力恢复。
- image escape 行会回退或跳过包装，避免破坏终端图片协议。
- assistant / user / custom / skill / compaction / branch 空内容不会渲染空框。
- tool / bash / working 即使正文为空也保留外框，因为标题和状态本身有信息价值。

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

本扩展依赖 Pi 当前的内置 TUI 组件导出。升级 pi 后如果内置组件名称、构造方式或 `render(width)` 行为变化，需要重新跑测试并同步适配。
