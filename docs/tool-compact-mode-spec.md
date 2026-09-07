# Tool 显示模式规范

> 状态：已实现
> 配置：`chromeFrame.toolCompactMode`、`chromeFrame.collapseThinking`、`chromeFrame.compactEditTool`

## 模式与迁移

`toolCompactMode` 是三态持久化设置：

```ts
type ToolDisplayMode = "off" | "compact" | "collapsed";

chromeFrame: {
  toolCompactMode: "compact";
  collapseThinking: true;
  compactEditTool: false;
}
```

默认模式是 `compact`。读取旧 Boolean 配置时执行兼容迁移：

- `true -> "compact"`
- `false -> "off"`

写回时只保存三态字符串，不再产生 Boolean。未知值归一化为默认值 `compact`。

`collapseThinking` 独立持久化并默认 `true`。旧配置缺少该字段时使用默认值。它只改变 Collapsed Thinking frame 的内容展示，不改变分组、计时或 token 语义。设置界面仅在选择 Collapsed 时显示该项；切换到其他模式会隐藏但保留原值。

`compactEditTool` 也独立持久化。选择 Collapsed 时设置界面隐藏 Compact Edit，但不修改该偏好；离开 Collapsed 后恢复显示和原值。Collapsed 摘要不读取该偏好。

## Off

- 保留现有逐 frame 渲染和完整 Tool 内容。
- 不应用 Compact 首行提取。
- Pi 原生展开行为保持不变。

## Compact

- 保留原有逐 Tool frame 行为。
- 未展开 Tool 使用现有 Compact 提取：跳过空白、控制标记和图片，显示第一条有效文本行。
- 展开后恢复完整原始内容。
- `compactEditTool` 决定 Edit 是否应用 Compact；默认 `false`。
- 用户 `!` / `!!` 的 Bash frame 保持原有行为。

## Collapsed

### 分组

Collapsed 有两类互斥的连续组：

- `Thinking`：连续、可见且非空的 Thinking 内容。
- `Tools`：连续、可见的非对话 frame，包括 Tool、Bash、Skill、Resource/Custom、Compaction、Branch 和 Working。

Thinking 与 Tools 互相关闭前一组并开始新组。可见且非空的 User 或 Assistant 正文也会关闭当前组。空内容、隐藏内容和只含 tool call 的 Assistant 不创建 frame，也不改变分组。`assistantFrame` 只控制 Assistant 正文是否包框，不改变这些边界。

组内仅首项作为锚点渲染，其他成员不再各自输出 frame。成员按稳定身份去重；重复渲染、streaming 更新和组件实例重建会替换原记录，不增加调用行或上下文贡献。历史恢复必须收敛到与实时渲染相同的顺序、状态、摘要和贡献值。

### Thinking 显示

Thinking frame 使用连续段的原始 Thinking 文本：

- `collapseThinking: false` 时保留该段全部有效行。
- `collapseThinking: true` 时先移除 ANSI 与 Markdown 标题、引用、列表、链接、强调和反引号装饰，再生成纯文本摘要；一行输入显示一行，多行输入最多显示首行和末行。
- 摘要正文使用 Tool 正文 token，不使用粗体；每条摘要固定一行，超过可用宽度时以 ASCII `...` 截断。
- 摘要规则完全确定，不调用模型或外部摘要服务。

折叠只影响 frame 内的可见内容行。分组边界、原始上下文贡献和耗时不受开关影响。

### Tools 显示

标题显示组内实际调用总数，例如：

```text
Tools ×4 [ 24.6k ]
```

正文复用 Compact 调用摘要，并按每次调用首次出现的原始顺序逐项显示：

```text
 ● Read package.json
 ● Grep "collapsed" in src/
 ● Bash npm test
 ● Read src/features/chrome-frame/patch.ts
```

每次调用恰好占一行，不按类型合并，也不设置最大行数。所有项都移除树形连接符，只保留同列对齐的 `●`；运行中的 `●` 复用 User label 的 `accent` 语义 token，完成和失败的 `●` 分别使用 `success`、`error`。Read 路径、Grep 条件、Bash 命令、Edit 目标等关键信息来自现有 Compact 提取。流式结果与状态变化只替换同一稳定调用的行，完成或失败不会移除该行。Edit 不显示 diff，也不读取 `compactEditTool`。

窄终端按现有 frame 宽度和 ANSI/CJK 可见宽度规则把每次调用截断在同一行，并以 ASCII `...` 结束；不允许自动换出额外内容行。静态标题括号、分隔符、正文、状态点、边框和底栏字符在内嵌 ANSI reset 后必须恢复所属主题 token，不能泄漏为终端默认色。

### Token 与上下文指标

Collapsed Thinking 和 Tools 标题都只显示一个上下文贡献字段：

```text
[ <tokens> ]
```

该值描述线框所代表的原始内容会给后续模型上下文增加多少，不是 provider billing、模型 input/output usage 或累计 session token。当前实现没有运行时模型 tokenizer，统一按 4 字符约 1 Token 估算；标题中不额外显示估算符号。

Thinking 贡献来自组内完整原始 thinking blocks，包括可见摘要未展示的中间内容；普通 Assistant 正文、Markdown 清理结果、标题和边框不计入。Tools 贡献逐项汇总实际工具名称、参数和已送入模型的结果文本或错误/命令输出；pending 不计尚未返回的结果，工具内部保留但在送模前已截除的 full output 不计入。Compact 摘要、列表缩进、状态点、颜色、单行宽度裁剪和其他 UI 派生字符均不计入。

成员 streaming 更新时先移除旧贡献再加入新贡献；重复 render、同 identity 组件重建和历史恢复不得重复累计。非 Collapsed 的 Assistant/Thinking 继续使用原有真实 usage，Off/Compact 的既有上下文估算格式不变。

### 耗时

所有实际显示的 frame 使用统一口径：

```text
当前 frame 最后更新时间 - 上一个实际显示 frame 最后更新时间
```

- 首个实际显示 frame 没有前序基准，因此省略耗时。
- 开放 frame 在 streaming 或 pending 状态下随最后更新时间更新。
- frame 完成后冻结，不因迟到的重复 render 或 cache refresh 增长。
- Tools 组使用组内最后更新成员的时间作为完成点。
- 隐藏或不成框的内容不进入显示 frame 时间链。
- 历史恢复和组件实例重建必须得到相同耗时。

## 实现约束

- 仅改变 TUI 呈现和对应指标，不改变 Tool 执行结果、模型消息或 session 内容。
- 复用现有 Compact 提取、frame、图标、主题 token 和 timing 基础设施。
- Collapsed 聚合更新保持 O(1)，聚合快照按组版本缓存；2000+ 成员不得出现成员查询乘全组扫描的 O(n²) 路径。
- 不引入额外兼容 shim、第二套 Tool formatter、模型摘要调用或隐藏展开语义。
- 配置、边界、摘要、逐调用顺序、去重、状态、单值上下文贡献、timing、normal/narrow 渲染及历史/流式收敛均由自动化测试覆盖。
