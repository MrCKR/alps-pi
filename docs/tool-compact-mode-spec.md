# Tool 显示模式规范

> 状态：已实现
> 配置：`chromeFrame.toolCompactMode`、`chromeFrame.compactEditTool`

## 模式与迁移

`toolCompactMode` 是三态持久化设置：

```ts
type ToolDisplayMode = "off" | "compact" | "collapsed";

chromeFrame: {
  toolCompactMode: "compact";
  compactEditTool: false;
}
```

默认模式是 `compact`。读取旧 Boolean 配置时执行一次兼容迁移：

- `true -> "compact"`
- `false -> "off"`

写回时只保存三态字符串，不再产生 Boolean。未知值归一化为默认值 `compact`。

`compactEditTool` 独立持久化。选择 `collapsed` 时设置界面立即隐藏 Compact Edit，但不修改该偏好；离开 Collapsed 后恢复显示和原值。Collapsed 摘要从不读取该偏好。

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

### 分组边界

一个连续组包含所有可见的非对话、非 Thinking frame，包括：

- Tool 及 pending/success/error 等价 kind
- Bash
- Skill
- Resource/Custom
- Compaction
- Branch
- Working

组内仅首项作为锚点渲染，其他成员不再各自输出 frame。只有可见且非空的 User、Assistant 或 Thinking 会关闭当前组；空内容、隐藏内容和只含 tool call 的 Assistant 不切组。

成员按稳定身份去重。重复渲染、streaming 更新和组件重建会替换原记录，不增加 count、failed count 或上下文贡献。失败成员保留在同一组中，沿用普通失败文字和状态符号，不改变 Collapsed frame 颜色。

### 显示

标题严格为 `Tools`。正文固定两行：

```text
×N · N failed       # 无失败时不显示后半段
TOOL <name> <status> : <existing Compact summary>
```

第二行选择最近启动或更新的 Tool；同时间戳事件按 lifecycle 顺序稳定破平。无新事件的重渲染不改变选择，组关闭后保留最终 Tool 摘要。

Collapsed 直接复用 Compact 摘要提取，不维护第二套 formatter。Tool 名称只出现一次。Edit 只显示路径，不显示 diff，也不读取 `compactEditTool`。

窄终端保持 Tool 行为单行，优先保留 `TOOL`、名称和状态，再截断 Compact 内容。成员自己的 token/time 不在正文重复显示。

### 上下文贡献指标

普通 frame 的单一 `[...]` 总数只表示该 frame 的原始 session 内容中，新保留给后续模型上下文的贡献。它不表示累计 session/billing usage，不计完整 prompt 重传、重复记录或 UI 文案，也不受折行、截断和图片隐藏影响。

Collapsed 顶边使用方向总数：

```text
[ ↑<upstream> · ↓<downstream> ]
```

- `↑`：上传、本地或 Tool 侧保留内容，例如 Tool result、context injection、summary。
- `↓`：模型侧保留内容，例如 Tool call 名称/参数和 Assistant/model 内容。
- 每个底层 entry/content 只计一次；streaming 和重渲染更新原贡献。

Input 使用 `#7AA2F7`，Output 使用 `#73DACA`，分隔符使用 Alps orange `#FF8B39`。耗时沿用 success 绿色。

### 耗时

组右下角耗时沿用现有 frame 时间语义：

- 开放组从前一可见 frame 的时间点开始实时增长。
- 可见非空 User、Assistant 或 Thinking 关闭组时冻结。
- 迟到的 streaming/rerender/cache refresh 不延长已关闭组。
- 下一可见 frame 从该冻结终点计算自己的耗时。

## 实现约束

- 仅改变 TUI 呈现和对应 retained-context 指标，不改变 Tool 执行结果或 session 内容。
- 复用现有 Compact 提取、frame、图标、颜色、timing 和 cache 基础设施。
- 不引入 per-tool Collapsed formatter、额外兼容 shim 或隐藏展开语义。
- 配置、聚合、边界、去重、方向统计、current 选择、timing、normal/narrow 渲染均由自动化测试覆盖。
