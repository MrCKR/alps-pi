# Animations 独立模块冻结方案

## 背景

`pi-animations` 当前作为外部插件运行。它通过 `ctx.ui.setWorkingMessage()`、`ctx.ui.setWidget()` 与 monkey patch `AssistantMessageComponent` 实现动画。后续将完全摒弃外部 `pi-animations`，把其能力复制并内置到 `alps-pi`。

本轮定位是：在 `alps-pi` 内实现独立 Animations 功能，完整替代外部 `pi-animations` 能替换的可见动画：底部 Working/Thinking/Tool 状态动画，以及 Pi hidden thinking 的 `Thinking...` label，并由 `/alps-pi` 设置界面的二级页面统一管理。

后续真实 UI 校准确认：fixed bottom editor 下不能再用 `setWidget()` 承载多行动画，否则会与 Todo widget 混排；多行动画应整体写入 `ctx.ui.setWorkingMessage(lines.join("\n"))`，仅清理旧 widget 残留。

原始外部插件代码已冻结复制到：

```text
.temp/pi-animations.original.ts
```

## 冻结目标

1. 在 `alps-pi` 内置 Animations 功能，后续不依赖外部 `pi-animations` 插件。
2. 复制原插件动画 registry 与主要动画函数，保留原动画名称、分类、描述与单行/多行能力。
3. 用内置动画替代外部 `pi-animations` 原本接管的可见状态：
   - 底部 Pi 原生 `Working...` loader；
   - assistant thinking 流式阶段的 thinking 动画；
   - tool 执行阶段的 tool 动画；
   - Pi hidden thinking label 的 `Thinking...`。
4. 设置入口集中到 `/alps-pi` 设置页的二级界面：
   - 不保留 `/animation` 命令；
   - 不做独立外部配置入口。
5. 模块尽量与现有 fixed bottom editor、bottom input、chrome frame 视觉 patch 解耦。

## 非目标

本轮不做：

- 不把动画塞进 bottom-input runtime 或 fixed cluster。
- 不直接修改 fixed-bottom-editor / bottom-input 的容器排序。
- 不接管 todo/status/widget 容器顺序本身；只通过 Pi 原生 extension UI API 更新 working message，并清理旧 widget 残留。
- 不保留外部插件的 `/animation` 命令。
- 不自动禁用外部 `pi-animations` 插件；只在文档中提醒用户禁用。

## 代码边界

允许新增：

```text
src/features/animations/
  registry.ts
  patch.ts
  settings.ts
  settings-ui.ts
  runtime.ts
  index.ts
```

允许修改：

```text
index.ts
src/settings.ts
src/settings-store.ts
src/settings-ui.ts
README.md
test/*
```

原则上不修改：

```text
src/features/bottom-input/*
src/features/fixed-bottom-editor/*
src/features/chrome-frame/*
```

除非实现中发现必须改动；若必须改动，需要先停止并重新确认冻结方案。

## 设计方案

### 1. Animation registry

从 `.temp/pi-animations.original.ts` 迁移动画函数与 registry。

保留类型语义：

```ts
type AnimationPhase = "thinking" | "working" | "tool";
type AnimationCategory = "thinking" | "working" | "both";
type AnimationWidth = "full" | "default" | number;

type AnimationDefinition = {
  name: string;
  fn: (frame: number, width: number, phase?: AnimationPhase) => string | string[];
  category: AnimationCategory;
  description: string;
  lines: number;
};
```

需要导出：

```ts
ANIMATIONS
getAnimation(name)
getAnimationsForCategory(category)
renderAnimationFrame(name, frame, width, phase)
pickRandomAnimation(category)
resolveAnimationWidth(setting, terminalWidth)
```

### 2. Hidden thinking patch

Pi 原生 hidden thinking 逻辑位于：

```text
node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js
```

核心行为：当 `hideThinkingBlock === true` 时，在 `contentContainer` 中添加：

```ts
new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), 1, 0)
```

alps-pi Animations 模块通过独立 patch 包装：

```ts
AssistantMessageComponent.prototype.updateContent
```

要求：

- patch 可重复 enable，不重复包裹。
- patch 可 disable/dispose，恢复原始 `updateContent`。
- patch 不依赖 chrome-frame patch 状态。
- patch 只处理 hidden thinking label。
- patch disabled 时不改变原生渲染。
- patch 出错必须 fail-soft，不破坏 assistant 消息渲染。

### 3. 多行动画

旧 `pi-animations` thinking patch 只替换 `Text` 的第一行：

```ts
child.setText(renderFrame(...)[0])
```

alps-pi 内置版本应支持多行动画。建议实现 `AnimatedThinkingComponent`：

```ts
class AnimatedThinkingComponent implements Component {
  render(width: number): string[];
  invalidate(): void;
}
```

它根据当前 settings 与 frame 返回单行或多行动画。

### 4. Runtime / timer

Animations runtime 维护：

```ts
settings
frame
timer
currentCtx
activeComponents
agent/phase state
```

timer 默认按配置 fps 推进：

```ts
frame++
更新 bottom working message/widget
必要时 requestRender 或更新 hidden thinking label
```

要求：

- `session_start` / `message_update` / tool 事件可绑定当前 ctx，用于更新 Pi 原生 extension UI。
- `agent_start` 启动底部动画；`agent_end` / `session_shutdown` 必须清理 timer、widget、working message 与 patch。
- stale ctx 错误必须忽略。
- 没有 UI 或不能 request render 时不抛错。

### 5. Working / thinking / tool runtime

Animations runtime 通过 Pi 原生 extension UI API 替代外部 `pi-animations` 的底部可见动画：

```ts
ctx.ui.setWorkingMessage(lines.join("\n"))
ctx.ui.setWidget("alps-pi-animations", undefined) // 仅用于清理旧残留
```

phase 优先级：

```text
thinkingActive        -> thinking animation
runningToolIds 非空   -> tool animation
否则 agentActive      -> working animation
```

生命周期：

- `agent_start`：启动 timer，显示 working 动画。
- `message_update`：根据 `assistantMessageEvent.type` 在 thinking / working phase 间切换。
- `tool_execution_start`：记录 tool id，进入 tool phase。
- `tool_execution_end`：移除 tool id，无 tool 时回到 working phase。
- `message_end`：只退出 thinking phase，不停止底部动画。
- `agent_end` / `session_shutdown`：停止 timer，清理 widget，并恢复 Pi 默认 working message。

单行动画写 `setWorkingMessage(line)`；多行动画整体写 `setWorkingMessage(lines.join("\n"))`，避免动画行被 Todo/widget 容器插开。`setWidget("alps-pi-animations", undefined)` 只用于清理旧版本或外部插件残留。

### 6. Settings

在 `AlpsPiSettings` 增加：

```ts
animations: {
  enabled: boolean;
  randomMode: boolean;
  working: string;
  thinking: string;
  tool: string;
  width: "full" | "default" | number;
  fps: number;
}
```

默认值：

```ts
animations: {
  enabled: true,
  randomMode: false,
  working: "crush",
  thinking: "shimmer",
  tool: "pipeline",
  width: "default",
  fps: 16,
}
```

说明：

- `working` 用于 agent 普通输出期底部动画。
- `thinking` 用于 assistant thinking 流式阶段和 hidden thinking label。
- `tool` 用于 tool 执行期底部动画。
- settings-store 读取旧 alps settings 时必须补齐 `animations` 默认值。

### 7. Settings UI

`/alps-pi` 主设置页新增：

```text
Animations    configure
```

建议位置：`Beautified Input` 后，`Shortcuts` 前。

二级页面项目：

```text
Enabled       ON/OFF
Random Mode   ON/OFF
Thinking      shimmer
Working       crush
Tool          pipeline
Width         default
FPS           16
Preview       open
```

要求：

- 二级页面内完成所有配置，不再跳外部命令。
- `Thinking` 可选 `thinking` + `both` 分类动画。
- `Working` 可选 `working` + `both` 分类动画。
- `Tool` 可选 `working` + `both` 分类动画，保持旧插件逻辑。
- `Width` 可选固定集合：`full`、`default`、`20`、`40`、`60`、`80`。
- `FPS` 可选固定集合：`8`、`12`、`16`、`24`、`30`。
- 设置变更后立即持久化并重新 configure animations runtime。
- `Preview` 打开只读预览子页，可切换所有内置动画与 phase，不影响真实 runtime。

## 生命周期接入

`index.ts` 只负责把设置与事件转给 animations 模块：

```ts
configureAnimations(state.config.settings.animations);

pi.on("session_start", (_event, ctx) => {
  bindAnimationsSession(ctx);
  configureAnimations(state.config.settings.animations);
});

pi.on("agent_start", (_event, ctx) => {
  bindAnimationsSession(ctx);
  resumeAnimationsRuntime();
});

pi.on("message_update", (event, ctx) => {
  bindAnimationsSession(ctx);
  handleAnimationsMessageUpdate(event);
});

pi.on("message_end", () => {
  handleAnimationsMessageEnd();
});

pi.on("tool_execution_start", (event, ctx) => {
  bindAnimationsSession(ctx);
  handleAnimationsToolExecutionStart(event);
});

pi.on("tool_execution_end", (event, ctx) => {
  bindAnimationsSession(ctx);
  handleAnimationsToolExecutionEnd(event);
});

pi.on("agent_end", (_event, ctx) => {
  bindAnimationsSession(ctx);
  pauseAnimationsRuntime();
});

pi.on("session_shutdown", () => {
  disposeAnimations();
});
```

若设置页切换 `animations.enabled`：

```ts
state.config.settings.animations.enabled = enabled;
configureAnimations(state.config.settings.animations);
writePersistedSettings(state.config.settings);
```

## 外部插件冲突

外部 `pi-animations` 如果仍启用，会继续 monkey patch 或写 UI。alps-pi 不做自动探测和禁用。

README 需要明确：

```text
Alps Pi 已内置 Animations。启用后请禁用/卸载外部 pi-animations，否则可能出现重复动画或 patch 冲突。
```

## 测试门禁

至少补充：

1. registry：动画名称、分类过滤、未知动画 fallback。
2. settings：默认值包含 `animations`。
3. settings-store：旧配置缺 `animations` 时合并默认值。
4. patch：enable 后 hidden thinking label 被替换为动画 component。
5. patch：disable 后恢复原始 `updateContent`。
6. patch：重复 enable 不重复包裹。
7. patch：disabled settings 不替换原生 `Thinking...`。
8. patch：多行动画 render 返回多行，完成后显示 `Thinking complete` 并保留 thinking 文案配色。
9. runtime：多行底部动画整体写入 working message，并清理旧 widget 残留。
10. registry：随机动画按行数分组，能覆盖多行动画集合。
11. settings-ui：主页面出现 `Animations configure`。
12. settings-ui：Animations 二级页可修改 Enabled、Random Mode、Thinking、Working、Tool、Width、FPS，并提供 Preview 入口。
13. extension-entry：session_start 配置 animations，session_shutdown dispose animations。
14. 全量测试通过：

```bash
cd /d/workspace/alps-pi && C:/Users/Administrator/AppData/Local/nvm/v22.22.3/npm.cmd test
```

15. 静态检查：

```bash
git diff --check
find . -maxdepth 1 \( -iname 'nul' -o -iname 'NUL' \) -print
```

## 停止点

本文件写完后暂停，不进入实现。下一步实现前需要再次确认冻结方案。
