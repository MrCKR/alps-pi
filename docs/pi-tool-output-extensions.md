# Pi 工具输出折叠与美化扩展核验

研究日期：2026-09-03

## 结论

- **真正把连续工具合成一个组：** `pi-claude-style-tools`、`pi-pretty-tui` 的 clean 模式，以及 `alps-pi` 0.3.0 的 Collapsed 模式。
- **只压缩单条工具消息，没有连续合并：** `pi-foldable-tools`、`pi-collapse-tools`、`pi-tool-display`、`pi-terse-tools`、`@mobrienv/pi-tidy-tools` 和 `@diegopetrucci/pi-quiet-tools`；`alps-pi` 0.3.0 的 Compact 模式也保留逐条压缩行为。
- **连续 thinking：** 本次候选中没有一个把多条 thinking 保存为可逐项恢复的组。`pi-claude-style-tools` 单独处理 thinking；`pi-pretty-tui` clean 模式隐藏 collapsed thinking；`alps-pi` 0.3.0 把可见非空 Thinking 当作工具组边界。
- **不是本用途：** `pi-fold` 折叠的是发送给模型的历史上下文，不是终端里的工具执行输出。

## 判定口径

Pi 的自定义工具 renderer 会收到 `expanded` 状态；默认快捷键 `app.tools.expand`（`Ctrl+O`）切换全局工具输出展开状态。因此本文区分：

1. **独立折叠：** 扩展自己增加状态、命令或快捷键，不只读取 Pi 的 `expanded`。
2. **原生展开：** 扩展在 `expanded === false` 时压缩/隐藏，在 `expanded === true` 时恢复详细 renderer；展开操作仍由 Pi 的 `Ctrl+O` 完成。
3. **仅美化：** 只改颜色、边框或排版，没有减少/隐藏输出的行为。

Pi 一手文档：

- [Extension API：`renderResult` 与 `expanded`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Keybindings：`app.tools.expand`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/keybindings.md)
- [Packages：`pi install npm:<package>`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [Themes：工具颜色 token](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/themes.md)

## 真正支持独立折叠/展开

### `pi-foldable-tools` 0.1.0

- **功能：** 默认 folded；显示调用标题和单行结果。expanded 显示完整输出；hidden 将整个工具 block 从 transcript 隐藏。`Ctrl+Q` 循环三态，`/tools folded|expanded|hidden` 直接选择。Pi 原生 `Ctrl+O` 在 folded/expanded 状态中仍可临时显示完整内容。
- **安装：** `pi install npm:pi-foldable-tools`
- **适用范围：** 覆盖 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`，执行仍委托 Pi 内置工具。
- **限制与不确定性：** npm 元数据未声明 GitHub repository/homepage；只能核验 npm 发布包源码，无法核对公开仓库历史。hidden 模式读取图片时，图片仍可能显示；与其他覆盖同名内置工具的扩展可能冲突。
- **一手来源：** [pi.dev 包页](https://pi.dev/packages/pi-foldable-tools) · [npm](https://www.npmjs.com/package/pi-foldable-tools) · [0.1.0 发布源码](https://unpkg.com/pi-foldable-tools@0.1.0/index.ts)

## 默认压缩显示，由 Pi 原生 Ctrl+O 展开

### `pi-collapse-tools` 0.1.7

- **功能：** 保留工具调用及关键参数，已完成结果在未展开时返回空内容；`Ctrl+O` 后委托原始 renderer 显示完整结果。
- **安装：** `pi install npm:pi-collapse-tools`
- **适用范围：** 只覆盖当前启用的 Pi 内置工具；默认包括 `read`、`bash`、`edit`、`write`，也支持 `grep`、`find`、`ls`。
- **限制与不确定性：** 覆盖内置工具会产生 warning；与其他 built-in override 可能冲突。行为由源码直接确认，无功能性不确定项。
- **一手来源：** [pi.dev 包页](https://pi.dev/packages/pi-collapse-tools) · [npm](https://www.npmjs.com/package/pi-collapse-tools) · [官方源码](https://github.com/xRyul/pi-collapse-tools/blob/79aead3fb2326ec648fa09d5a1ab0f44192a3e04/index.ts)

### `pi-tool-display` 0.5.0

- **功能：** 按 preset 和工具类型选择 hidden、summary、preview 或 full；原生展开状态显示更多内容。默认 `opencode` preset 隐藏 read/search/MCP 结果，bash 折叠到最多 10 行；还提供 edit/write diff 和 `/tool-display` 配置界面。
- **安装：** `pi install npm:pi-tool-display`
- **适用范围：** Pi 内置 read/search/bash/edit/write、MCP 工具，以及主动采用其 API 的自定义工具。
- **限制与不确定性：** 不同 preset 的默认可见量差异较大；它不是“全部工具统一折成一行”。已核验默认配置及各 renderer 对 `options.expanded` 的分支。
- **一手来源：** [pi.dev 包页](https://pi.dev/packages/pi-tool-display) · [npm](https://www.npmjs.com/package/pi-tool-display) · [默认配置源码](https://github.com/MasuRii/pi-tool-display/blob/91cef7580078371f8dc49a8607222807ad6a424d/src/types.ts) · [renderer 源码](https://github.com/MasuRii/pi-tool-display/blob/91cef7580078371f8dc49a8607222807ad6a424d/src/tool-overrides.ts)

### `pi-terse-tools` 0.3.1

- **功能：** 每个工具 block 默认固定为两行：输入摘要和结果摘要；`Ctrl+O` 后追加原始完整输出、diff 或写入内容。只替换显示 renderer，不改 schema 或执行。
- **安装：** `pi install npm:pi-terse-tools`
- **适用范围：** 七个 Pi 内置工具：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`。
- **限制与不确定性：** 不处理第三方/MCP 工具；与其他同名工具 override 不能叠加。两行摘要及 expanded 分支已由源码确认。
- **一手来源：** [pi.dev 包页](https://pi.dev/packages/pi-terse-tools) · [npm](https://www.npmjs.com/package/pi-terse-tools) · [官方源码](https://github.com/Astro-Han/pi-terse-tools/blob/3ada37279071ac772a3986d71ab06e16137184c7/packages/terse/src/index.ts)

### `@mobrienv/pi-tidy-tools` 0.4.2

- **功能：** 默认将调用和结果排成两行，也可用 reasoning/result 单行布局；`Ctrl+O` 追加完整输出。提供实时状态、diff 和 `/tidy` 配置。
- **安装：** `pi install npm:@mobrienv/pi-tidy-tools`
- **适用范围：** 七个 Pi 内置工具；默认执行委托原工具。默认/reasoning 模式会给工具 schema 增加必填 `reasoning` 参数，result 模式保留原 schema。
- **限制与不确定性：** 它并非纯视觉层，因为部分模式会改变 schema；可选集成 `pi-fff`。collapsed/expanded 行为由官方包页与源码确认。
- **一手来源：** [pi.dev 包页](https://pi.dev/packages/%40mobrienv%2Fpi-tidy-tools) · [npm](https://www.npmjs.com/package/@mobrienv/pi-tidy-tools) · [官方源码](https://github.com/mikeyobrien/pi-tidy-tools/blob/33a0f4adab9c317a4af1668fd88085211aca3658/packages/pi-tidy-tools/index.ts)

### `@diegopetrucci/pi-quiet-tools` 0.1.12

- **功能：** collapsed 时只显示一行调用和一行 `Ctrl+O` 提示，工具结果完全隐藏；expanded 时复用 Pi 原始完整 renderer。明确不截断、总结或改写发给模型的工具结果。
- **安装：** `pi install npm:@diegopetrucci/pi-quiet-tools`
- **适用范围：** 七个 Pi 内置工具；用户直接执行的 `!`/`!!` shell 命令不受影响；`/quiet-tools` 可在当前 session 开关。
- **限制与不确定性：** 只处理内置工具，不处理任意第三方工具；与其他 built-in override 可能冲突。显示分支已由源码确认。
- **一手来源：** [pi.dev 包页](https://pi.dev/packages/%40diegopetrucci%2Fpi-quiet-tools) · [npm](https://www.npmjs.com/package/@diegopetrucci/pi-quiet-tools) · [官方源码](https://github.com/diegopetrucci/pi-extensions/blob/bf849e251c10d28a3fc601d489fa0ae4768419b1/extensions/quiet-tools/index.ts)

### `pi-claude-style-tools` 1.0.68

- **功能：** 将 built-in、MCP、自定义/OpenAI 工具渲染为 Claude Code 风格的分组行；collapsed 时显示状态、摘要或计数，原生 `Ctrl+O` 显示详细输出。另有 Shiki diff 和 read/search/bash/MCP 输出模式。
- **安装：** `pi install npm:pi-claude-style-tools`
- **适用范围：** 内置工具、MCP 工具和多类自定义工具，覆盖面比只重写七个 built-ins 的扩展更广。
- **限制与不确定性：** 它额外注册的 `Ctrl+Shift+O` 只切换“已展开视图”的 detail cap，不替代 Pi 的 collapsed/expanded 状态；核心展开仍是原生 `Ctrl+O`。相关两个状态已由源码分别确认。
- **一手来源：** [pi.dev 包页](https://pi.dev/packages/pi-claude-style-tools) · [npm](https://www.npmjs.com/package/pi-claude-style-tools) · [官方源码](https://github.com/FammasMaz/pi-cc-tools/blob/48d6e67eafbf575c3e375e97873f38a37057fd60/extensions/index.ts)

### `alps-pi` 0.3.0

- **功能：** Compact Tools 提供 Off、Compact、Collapsed 三态，默认 Compact。Compact 保留逐 Tool 首条有效文本摘要；Collapsed 把连续非对话/非 Thinking frame 聚合成一个 `Tools` frame，并显示计数、失败数、当前 Tool、方向性上下文贡献和冻结耗时。
- **安装：** `pi install npm:alps-pi@0.3.0`
- **适用范围：** 对 Pi 内部消息与工具执行组件做通用 TUI patch，覆盖 Tool、Bash、Skill、Resource/Custom、Compaction、Branch 和 Working 等运行时 kind。包同时提供消息框、输入框、动画和主题。
- **限制与不确定性：** 这是对 Pi 内部 TUI component 的 patch，比只实现公开 custom renderer API 更依赖 Pi 内部结构。默认值为 `toolCompactMode: "compact"`、`compactEditTool: false`；旧 Boolean 自动迁移为 `true -> "compact"`、`false -> "off"`。
- **一手来源：** [npm 0.3.0](https://www.npmjs.com/package/alps-pi/v/0.3.0) · [GitHub Release](https://github.com/MrCKR/alps-pi/releases/tag/v0.3.0) · [模式规范](./tool-compact-mode-spec.md) · [聚合源码](../src/features/chrome-frame/collapsed.ts) · [渲染源码](../src/features/chrome-frame/patch.ts)

## 可选压缩模式，由 Pi 原生 Ctrl+O 展开

### `pi-pretty-tui` 0.1.4

- **功能：** 提供 full、compact、clean 三种持久模式。compact 在 collapsed 时显示简短调用/结果；clean 将支持的工具聚合为 Running/Done，并隐藏 collapsed thinking；`Ctrl+O` 绕过隐藏逻辑并恢复完整 transcript。
- **安装：** `pi install npm:pi-pretty-tui`
- **适用范围：** 七个 Pi 内置工具；第三方工具保持原样。还会美化列表 marker。
- **限制与不确定性：** 默认模式是 **full**，安装后不会自动折叠；必须通过 `/pretty-tui` 选择 compact 或 clean。模式默认值和 `!expanded` 分支已由源码确认。
- **一手来源：** [pi.dev 包页](https://pi.dev/packages/pi-pretty-tui) · [npm](https://www.npmjs.com/package/pi-pretty-tui) · [官方源码](https://github.com/ykn0309/pi-pretty-tui/blob/d714c89aac3086d5b94b0fff7ea04cf76c472460/extensions/index.ts)

## 不是工具输出折叠

### `pi-fold` 4.1.0

- **功能：** 将较旧的 session/context entries 替换为可恢复 brief，并把原文保存在 fold store；注册 `pi_fold_context` 供模型主动折叠上下文。
- **安装：** `pi install npm:pi-fold`
- **适用范围：** 模型上下文轮换、压缩和恢复，不是 TUI tool execution component。
- **限制与不确定性：** 包名中的 “fold” 容易与 UI 折叠混淆，但 README、架构说明和工具定义都明确指向 context；不属于本次目标。
- **一手来源：** [pi.dev 包页](https://pi.dev/packages/pi-fold) · [npm](https://www.npmjs.com/package/pi-fold) · [官方仓库](https://github.com/shaneconner/fold/tree/65d04829cdf243b62c2b96f8b25100e4df562807)

## 仅美化但不折叠

本次指定的十个候选中没有这种保留项。普通 Pi theme 可以修改 `toolPendingBg`、`toolSuccessBg`、`toolErrorBg`、`toolTitle`、`toolOutput` 等颜色 token，但 theme API 本身没有工具折叠状态或输出 renderer；因此“主题好看”不能作为“支持折叠”的证据。

## 连续工具/思考的组级折叠

### 判定口径

这里的“组级折叠”不是把每条工具输出各自缩成一行，而是同时满足：

1. 收集两个边界之间的多个 transcript/TUI component。
2. 用一个组组件或锚点替代这些成员的独立显示。
3. 组头展示数量、状态或当前活动项。
4. 明确说明展开时能否恢复组内成员，而不只是把摘要文字变长。

按这个口径，只有以下三个实现符合；其中没有一个完整实现“连续 tool + 连续 thinking 都作为可恢复子项”的混合组。

### `pi-claude-style-tools`：真实子组件组

- **数据结构：** `ToolGroupComponent` 内保存 `tools[]`；`ACTIVE_TOOL_GROUPS` 跟踪活动组。
- **分组边界：** patch `Container.prototype.addChild`，遇到 `ToolExecutionComponent` 时由 `maybeGroupToolComponent()` 和 `findPreviousToolSibling()` 查找相邻工具。允许跨过少量 `Spacer` 或空 assistant component；不是按时间窗口，也不是按工具类型。`edit`、`write`、`apply_patch` 被排除。
- **渲染：** 组头汇总 pending、success、error 数；展开时逐项调用组内原始工具 renderer。
- **展开：** `ToolGroupComponent.setExpanded()` 把 Pi 的全局 expanded 状态传播给每个子工具，因而 `Ctrl+O` 可以恢复组内每个工具内容。它没有 transcript 光标，所以仍是所有组一起展开，而不是选择某一组。
- **Thinking：** thinking 使用独立的 `thinkingBlockInFlight` / `HiddenThinkingSummary` 路径，没有加入 `tools[]`。
- **源码：** [`ToolGroupComponent`、`maybeGroupToolComponent()`](https://github.com/FammasMaz/pi-cc-tools/blob/48d6e67eafbf575c3e375e97873f38a37057fd60/extensions/index.ts)

这是三个方案中最接近标准 composite component 的实现：父组件真正拥有子工具，所以折叠只是改变呈现，成员没有丢失。

### `pi-pretty-tui` clean：运行级摘要加原工具隐藏

- **数据结构：** `CleanRunState` 管理一次 agent run；`ToolSummaryGroup` / `ToolSummaryData` 保存组摘要。
- **分组边界：** 同一 clean run 内的连续受支持工具归为一组；可见 assistant 文本、user entry 和 `agent_settled` 等事件结束当前组。不是时间窗口或同类工具聚合。
- **渲染：** `cleanToolCall()` / `hideCleanTool()` 隐藏原工具组件，`finishCleanGroup()` / `settleLastCleanGroup()` 生成 Running/Done 摘要；持久摘要通过 `pi.registerEntryRenderer("pretty-tui-tool-summary", ...)` 渲染。
- **展开：** patch `InteractiveMode.prototype.setToolsExpanded`，用全局 `cleanToolsExpanded` 恢复原工具的逐项渲染。摘要对象本身只保存 `count`、`failed`、`lastToolCallId`，没有完整子项列表，所以它不能脱离原 transcript 独立恢复成员。
- **Thinking：** clean 模式会隐藏 collapsed thinking，让连续运行看起来像一个干净的工作块；thinking 没有作为 `ToolSummaryGroup` 的可恢复子项保存。
- **源码：** [`ToolSummaryGroup`、`CleanRunState`、`finishCleanGroup()`](https://github.com/ykn0309/pi-pretty-tui/blob/d714c89aac3086d5b94b0fff7ea04cf76c472460/extensions/index.ts)

它的核心不是“父组件持有子组件”，而是“摘要 entry 与被隐藏的原 component 并存”。因此恢复能力依赖原 transcript 仍在内存中。

### `alps-pi` 0.3.0 Collapsed：锚点加 sibling 隐藏

- **数据结构：** [`collapsed.ts`](../src/features/chrome-frame/collapsed.ts) 用线性 `entries` 保存首次观察顺序，按组件实例和稳定 Tool/message identity 去重。`CollapsedGroupSnapshot` 汇总 count、failedCount、current、冻结耗时和方向性上下文贡献。
- **分组边界：** `roleFor()` 把可见非空 `user`、`assistant`、`thinking` 标为 boundary，其余可见 frame 标为 member；空或隐藏 frame ignored。空的 tool-call-only Assistant 不切组。
- **渲染：** [`patch.ts`](../src/features/chrome-frame/patch.ts) 让组内第一项作为 anchor，渲染 `Tools`、`×N`、失败数、当前活动 Tool、方向指标和耗时；其他 member 返回空数组。current 按 lifecycle 时间和事件顺序稳定选择。
- **摘要：** Collapsed 复用现有 Compact 提取，Edit 只显示路径。组关闭后保留最终摘要和冻结耗时；迟到的 streaming/rerender 不重复计数或延长时间。
- **展开：** Collapsed 是聚合视图，不把原生 `Ctrl+O` 解释为组成员树展开；要恢复逐项视图，应在设置中选择 Compact 或 Off。
- **Thinking：** 可见非空 Thinking 是 boundary，不属于工具组。

它比 clean 摘要更轻，但首次 render 顺序就是隐式 transcript 顺序；要支持可靠展开，需要额外保存组成员并让 expanded 分支恢复这些成员。

### 对比

| 实现 | 连续工具成组 | 组内成员保留 | `Ctrl+O` 恢复逐项内容 | Thinking 入组 |
| --- | --- | --- | --- | --- |
| `pi-claude-style-tools` | 是，相邻 component | 是，`tools[]` | 是，全局展开所有组 | 否，独立处理 |
| `pi-pretty-tui` clean | 是，同一 run 的连续序列 | 原 component 保留，摘要不持有 | 是，依赖原 transcript | 否，只隐藏 collapsed thinking |
| `alps-pi` 0.3.0 Collapsed | 是，两条可见对话之间 | 仅内部 registry/snapshot | 否 | 否，Thinking 是边界 |
| 其余候选 | 否 | 单项 renderer | 只展开单项 | 否 |

### 为什么普通 custom renderer 做不到

Pi 的公开 custom tool API 每次只给一个工具调用的 `renderCall` / `renderResult`，并传入全局 `expanded`；`Container` 也只是纵向组合已经存在的 child。公开 API 没有 transcript preprocessor 或“替换一段已有 sibling”的 hook。因此，连续组折叠只能选择以下路径之一：

- 像 `pi-claude-style-tools` 一样 patch `Container.addChild`，在 component 树建立时创建真正的父组。
- 像 `pi-pretty-tui` 一样维护 run 状态，新增摘要 entry，并隐藏原 component。
- 像 `alps-pi` 0.3.0 一样 patch 每个 component 的 `render()`，由 anchor 出组框，siblings 返回空。

Pi 原生 `Ctrl+O` 只是把一个 expanded 布尔值广播给 chat container 中所有可展开 component，没有“当前组”或“组内选中项”。若要支持单组展开或组内导航，还必须由扩展自己增加焦点状态、输入路由和持久 group identity；仅消费原生 `expanded` 不够。

### 明确没有连续合并的候选

- `pi-foldable-tools`：`makeRenderCall()` / `makeRenderResult()` 每个工具独立，三态也是单 block 状态。
- `pi-collapse-tools`：每次调用独立隐藏结果或委托原 renderer。
- `pi-tool-display`：preset 和 `options.expanded` 只作用于当前工具结果。
- `pi-terse-tools`：源码明确是 per-tool 2-line block；`TidyBlock` 不跨调用。
- `@mobrienv/pi-tidy-tools`：`TurnDiff` 虽是 turn 级数据，但只服务 `/diff`，源码明确写着 `No collector`。
- `@diegopetrucci/pi-quiet-tools`：`QuietCallRenderComponent` / `QuietResultRenderComponent` 都是单次调用 renderer。
