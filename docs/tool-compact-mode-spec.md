# Tool 极简模式需求冻结

> 状态：需求冻结草案  
> 范围：仅冻结行为规格与测试设计；本文不包含实现代码。  
> 背景：Alps Pi 已为 Pi TUI 消息、tool 调用与执行结果添加外层线框。本需求在保持线框不变的前提下，增加 tool 调用的极简展示模式。

## 目标

在不改变现有线框样式的前提下，新增一个默认开启的 Tool 极简模式：

- 普通模式保持当前行为不变。
- 极简模式下，未展开的 tool 调用内部只显示原始内容的第一条有效文本行。
- tool 名称、成功/失败/执行中状态继续由线框标题与颜色表达，内部不重复显示。
- `Ctrl+O` 沿用 Pi 原生展开机制；展开后显示完整原始内容。
- `edit` 默认不参与极简收起；另有设置允许在极简模式下也收起 `edit`。

## 非目标

- 不为每种 tool 单独设计摘要格式。
- 不在内部额外显示 toolName、状态、勾叉、错误标签或 `Ctrl+O` 提示。
- 不改变用户手动 `!` / `!!` 触发的 `BashExecutionComponent` 行为。
- 不改 Pi 原生 `Ctrl+O` 快捷键语义。
- 不修改 tool 实际执行结果、上下文内容或日志内容；只影响 TUI 展示。

## 术语

- **普通模式**：当前 Alps Pi 行为。外层线框包裹 Pi 原始 tool 渲染内容。
- **极简模式**：未展开时，Alps Pi 将 tool 内部内容压缩为第一条有效文本行。
- **ToolExecutionComponent**：Pi 内部用于展示 LLM tool call 的组件，例如 `read`、`edit`、`bash`、`grep`、`find` 等。
- **BashExecutionComponent**：Pi 内部用于展示用户手动 `!` / `!!` shell 命令的组件。本需求不处理它。
- **有效文本行**：原始渲染结果中，去除空白和纯控制标记后仍有可见文本的第一行。
- **图片行**：包含 Kitty / iTerm image escape 的行。

## 设置项

新增两个设置项，建议放在现有 `chromeFrame` 配置下：

```ts
chromeFrame: {
  toolCompactMode: boolean;
  compactEditTool: boolean;
}
```

### 默认值

```ts
toolCompactMode: true;
compactEditTool: false;
```

含义：

- 默认启用 Tool 极简模式。
- 默认不收起 `edit`，因为 `edit` 展示的是文件修改信息，风险更高。

## 行为规则

### 普通模式

当 `toolCompactMode = false`：

- 所有 `ToolExecutionComponent` 保持当前渲染行为。
- `edit`、`bash`、`read` 等都不被 Alps Pi 额外压缩。
- `Ctrl+O` 行为完全等同 Pi 原生。

### 极简模式

当 `toolCompactMode = true` 且组件未展开：

- 对 `ToolExecutionComponent` 生效。
- 内部只显示原始内容的第一条有效文本行。
- 不显示图片行。
- 不显示除第一条有效文本行以外的参数、输出、截断提示、历史行提示或展开提示。
- 外层线框保持当前样式，包括标题、颜色、成功/失败勾叉。

### 展开模式

当 `Ctrl+O` 将 tool 设置为展开状态：

- 极简模式不再压缩该 tool。
- 内部恢复 Pi 原始完整渲染内容。
- 图片行也按现有逻辑显示或回退。

### edit 例外

当 `toolCompactMode = true` 且 `compactEditTool = false`：

- `edit` 保持普通模式内容。
- 其他 `ToolExecutionComponent` 仍按极简模式收起。

当 `toolCompactMode = true` 且 `compactEditTool = true`：

- `edit` 也按极简模式收起，只显示第一条有效文本行。

### 用户 Bash 例外

用户手动输入 `!` / `!!` 产生的 `BashExecutionComponent`：

- 始终保持普通模式。
- 不受 `toolCompactMode` 影响。
- 不受 `compactEditTool` 影响。

LLM 调用的 `bash` tool 仍属于 `ToolExecutionComponent`，受极简模式影响。

### 图片处理

极简模式下：

- 不显示图片行。
- 如果原始内容只有图片行、没有有效文本行，则 tool 内部可以为空；外层 tool 线框仍保留，因为标题和状态有信息价值。
- 展开后恢复现有图片处理逻辑。

## BDD 场景

### 场景 1：默认极简模式收起普通 tool

Given 默认设置 `toolCompactMode = true`  
And 默认设置 `compactEditTool = false`  
And 一个未展开的 `read` tool 渲染出多行内容  
When Alps Pi 包装该 tool  
Then 外层线框保持存在  
And 线框标题仍显示 `TOOL read` 及状态  
And 内部只显示原始内容的第一条有效文本行  
And 不显示第二行及之后的内容

### 场景 2：极简模式不重复显示 toolName 和状态

Given 一个未展开且执行成功的 `bash` tool  
When 极简模式渲染它  
Then 状态由线框标题、颜色和勾叉表达  
And 内部不额外添加 `bash`、`success`、`✓` 等状态文本  
And 内部只来自原始渲染内容的第一条有效文本行

### 场景 3：普通模式保持现状

Given 设置 `toolCompactMode = false`  
And 一个未展开的 `grep` tool 渲染出多行内容  
When Alps Pi 包装该 tool  
Then 内部内容与当前普通模式一致  
And Alps Pi 不额外压缩为第一行

### 场景 4：Ctrl+O 展开后显示完整内容

Given 设置 `toolCompactMode = true`  
And 一个 `find` tool 原始内容有多行  
And 该 tool 初始未展开  
When 渲染该 tool  
Then 内部只显示第一条有效文本行  
When 用户按 `Ctrl+O` 使 tool 展开  
Then 内部显示 Pi 原始完整内容  
And 不再应用极简压缩

### 场景 5：edit 默认不收起

Given 设置 `toolCompactMode = true`  
And 设置 `compactEditTool = false`  
And 一个未展开的 `edit` tool 渲染出多行 diff 或修改信息  
When Alps Pi 包装该 tool  
Then `edit` 内部保持普通模式内容  
And 不压缩为第一条有效文本行

### 场景 6：设置允许收起 edit

Given 设置 `toolCompactMode = true`  
And 设置 `compactEditTool = true`  
And 一个未展开的 `edit` tool 渲染出多行内容  
When Alps Pi 包装该 tool  
Then `edit` 内部只显示第一条有效文本行

### 场景 7：用户 Bash 不受极简模式影响

Given 设置 `toolCompactMode = true`  
And 用户通过 `!` 或 `!!` 执行 shell 命令  
And Pi 使用 `BashExecutionComponent` 展示结果  
When Alps Pi 包装该 bash 组件  
Then 该组件保持普通模式内容  
And 不被压缩为第一条有效文本行

### 场景 8：LLM bash tool 受极简模式影响

Given 设置 `toolCompactMode = true`  
And LLM 调用了 `bash` tool  
And Pi 使用 `ToolExecutionComponent` 展示该调用  
When Alps Pi 包装该 tool  
Then 该 tool 内部只显示第一条有效文本行  
And 外层标题仍为 `TOOL bash` 及状态

### 场景 9：极简模式不显示图片行

Given 设置 `toolCompactMode = true`  
And 一个未展开 tool 的原始内容包含图片 escape 行  
When Alps Pi 生成极简内容  
Then 图片行不显示  
And 如果存在有效文本行，只显示第一条有效文本行  
And 如果不存在有效文本行，内部内容为空但外层 tool 线框保留

### 场景 10：展开后恢复图片显示逻辑

Given 设置 `toolCompactMode = true`  
And 一个 tool 的原始内容包含图片 escape 行  
When 该 tool 处于展开状态  
Then Alps Pi 不应用极简压缩  
And 图片行按现有 image fallback / 安全渲染逻辑处理

## TDD 测试清单

### 设置层测试

- 默认设置包含：
  - `chromeFrame.toolCompactMode === true`
  - `chromeFrame.compactEditTool === false`
- 设置 UI 展示四个选项：
  - 线框美化
  - Assistant 正文线框
  - Tool 极简模式
  - 极简下收起 edit
- 设置 UI 可切换 `toolCompactMode`。
- 设置 UI 可切换 `compactEditTool`。

### wrapper 行为测试

- `ToolExecutionComponent` / kind=`tool` 在极简模式、未展开、非 edit 时只渲染第一条有效文本行。
- kind=`tool` 在普通模式下保持原始多行内容。
- kind=`tool` 在 `expanded = true` 时保持原始多行内容。
- `toolName = "edit"` 且 `compactEditTool = false` 时保持原始多行内容。
- `toolName = "edit"` 且 `compactEditTool = true` 时只渲染第一条有效文本行。
- kind=`bash` 对应 `BashExecutionComponent` 不受极简模式影响。
- kind=`tool` 且 `toolName = "bash"` 受极简模式影响。

### 第一行提取测试

- 跳过空行，取第一条非空文本行。
- 跳过纯 OSC marker 行。
- 保留第一行中的 ANSI 样式。
- 原始内容只有空行时，返回空内容。
- 原始内容只有图片行时，返回空内容。
- 原始内容为“文本 + 图片 + 文本”时，只返回第一条文本行，不返回图片行。

### 展开与缓存测试

- 同一 tool 从未展开切换到展开后，缓存失效并显示完整内容。
- `toolCompactMode` 切换后，缓存失效。
- `compactEditTool` 切换后，缓存失效。
- 极简内容变化时，缓存失效。

### 回归测试

- 图片 escape 行在普通模式和展开模式下仍不被截断、不被破坏。
- tool 空内容仍保留外层线框。
- assistant/user/custom/skill/compaction/branch 渲染不受 tool 极简设置影响。
- `npm test` 全量通过。

## 实现约束

- 仅影响展示层，不改变 tool 执行、结果、上下文写入。
- 不引入新依赖。
- 不做 per-tool 特殊摘要映射。
- 不修改 Pi 内部源码。
- 保持现有外框渲染、安全回退、image/OSC 处理策略。
- 新增代码应保持职责单一；若 `patch.ts` 变复杂，应抽出纯函数模块并以单元测试覆盖。

## 待确认项

当前无待确认项。本文件按以下决策冻结：

- 默认开启 Tool 极简模式。
- 默认不收起 `edit`。
- 极简模式下不显示图片。
- 用户 `!` / `!!` 的 `BashExecutionComponent` 保持普通模式。
