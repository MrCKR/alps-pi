# Bottom Status 改造 BDD/TDD 需求固化

## 1. 需求摘要

本需求用于固化 `alps-pi` bottom status 的后续改造验收标准。目标是在不引入原版复杂能力的前提下，复刻必要的 `pi-powerline-footer` 行为，并适配当前 fixed bottom editor 布局。

状态栏分三层：

1. **输入框上方状态栏**：显示模型、思考度、上下文、从当前 UI 对话/session 打开或绑定时刻开始计算的 elapsed 时间。
2. **输入框本体**：继续由 fixed bottom editor 管理，不由 bottom status 重写。
3. **输入框下方状态栏**：显示上一个用户问题。

核心显示要求：

- 模型只显示模型名，例如 `GPT-5.5`，不显示 host/provider。
- 思考度参考原版 `pi-powerline-footer`：
  - `high` / `xhigh` 对整个 `think:label` 使用 rainbow 逐字符配色。
  - rainbow 对每个非空格且非冒号字符循环 8 个 hex 色，冒号不着色。
  - `minimal` / `low` / `medium` / `off` 使用语义色。
  - `alps-pi` 只复刻必要行为，不要求完整移植原版主题系统。
- 上下文采用紧凑型进度条，例如：`ctx █████░ 69.9%/272k`，颜色随百分比变化。
- 如果找不到 `contextWindow` / context window，则上下文位置只显示已用量，例如：`ctx 37k`，不显示进度条、不显示百分比。
- 如果连已用量都拿不到，则隐藏上下文段。
- 时间从当前 UI session 打开/绑定时刻开始计算，不是历史 conversation 创建时间；最小单位秒，无小数。
- 输入框下方上一个问题参考原版：`↳ 文本`，一行，压缩空白，按宽度截断；无内容则隐藏。
- `Alt+S` 暂存/恢复必须不回归。

## 2. 非目标

本次 bottom status 改造不做以下事项：

- 不恢复 `/alps-pi enable`、`/alps-pi disable`、`/alps-pi config`、`/alps-pi config-ui`、`/alps-pi settings` 等旧子命令。
- 不引入原版 bash mode。
- 不引入原版 welcome。
- 不引入原版 jump。
- 不引入复杂 preset/config 系统。
- 不重写 fixed bottom editor 的输入框本体管理逻辑。
- 不要求完整复制原版 `pi-powerline-footer` 的所有 segment、主题、preset 或配置能力。

## 3. 原版行为证据

以下证据来自原版 `pi-powerline-footer`，后续实现与测试应以这些行为作为参考，而不是重新扩展需求范围。

### 3.1 thinking segment

文件：`D:/workspace/alps-unity-mcp/Temp/pi-powerline-footer/segments.ts`

- `thinkingSegment` 支持 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`。
- `high` / `xhigh` 使用 `rainbow(content)`。
- 其他等级使用语义色。

### 3.2 context percentage

文件：`D:/workspace/alps-unity-mcp/Temp/pi-powerline-footer/segments.ts`

- `context_pct` 文本为：`${pct.toFixed(1)}%/${formatTokens(window)}`。
- `pct > 90` 使用 error 语义色。
- `pct > 70` 使用 warning 语义色。
- 其他使用 context 语义色。

### 3.3 elapsed time

文件：`D:/workspace/alps-unity-mcp/Temp/pi-powerline-footer/segments.ts`

- `time_spent` 使用 `Date.now() - ctx.sessionStartTime`。
- `elapsed < 1000` 时隐藏。
- `formatDuration` 输出 h/m/s。

### 3.4 rainbow 实现

文件：`D:/workspace/alps-unity-mcp/Temp/pi-powerline-footer/theme.ts`

- `rainbow(text)` 对除空格和冒号之外的字符轮换以下 8 个 hex 色：
  - `#b281d6`
  - `#d787af`
  - `#febc38`
  - `#e4c00f`
  - `#89d281`
  - `#00afaf`
  - `#178fb9`
  - `#b281d6`
- 空格和冒号不着色。
- 最后输出 reset。

### 3.5 context usage 读取

文件：`D:/workspace/alps-unity-mcp/Temp/pi-powerline-footer/context-usage.ts`

- `readCoreContextUsage(ctx)` 读取 `ctx.getContextUsage()` 的：
  - `tokens`
  - `contextWindow`
  - `percent`

### 3.6 session start 与 last prompt

文件：`D:/workspace/alps-unity-mcp/Temp/pi-powerline-footer/index.ts`

- `session_start` 设置 `sessionStartTime = Date.now()`。
- `before_agent_start` 使用 `event.prompt` 更新 `lastUserPrompt`。
- `renderLastPromptLines` 使用 ` ↳ ` 前缀，一行，`truncateToWidth`。

## 4. 当前 alps-pi 关键现状

- `D:/workspace/alps-pi/src/features/bottom-status/index.ts`
  - 当前只显示 model、thinking、总 token、当前时间。
  - widget 只有 `placement: aboveEditor`。
  - `Alt+S` 暂存/恢复已在此文件实现，后续改造必须保留。
- `D:/workspace/alps-pi/index.ts`
  - 当前监听 `model_select`、`thinking_level_select`、`message_update`、`message_end`、`turn_end`。
  - 当前未监听 `before_agent_start` 保存 last prompt。
- fixed editor runtime 已接管：
  - `statusContainer`
  - `widgetContainerAbove`
  - `editorContainer`
  - `widgetContainerBelow`
- 因此 `aboveEditor` 与 `belowEditor` widget 会被固定到底部，bottom status 应分别注册上方和下方 widget，而不是自行管理输入框位置。

## 5. BDD 场景

### 5.1 上方状态栏显示模型、思考度、上下文、elapsed

**Given** bottom status runtime 已启用，fixed bottom editor 已挂载  
**And** 当前模型为 `GPT-5.5`  
**And** 当前思考度为 `medium`  
**And** context usage 可读取 tokens 与 contextWindow  
**And** 当前 UI session 已打开超过 1 秒  
**When** 渲染输入框上方状态栏  
**Then** 上方状态栏应包含模型名 `GPT-5.5`  
**And** 不应包含 host/provider 文本  
**And** 应包含思考度段  
**And** 应包含上下文段  
**And** 应包含 elapsed 时间段  
**And** widget placement 应为 `aboveEditor`。

### 5.2 模型只显示模型名

**Given** 模型信息同时包含 host/provider 与 model name  
**When** bottom status 渲染模型段  
**Then** 只显示模型名  
**And** 不显示 host/provider  
**And** 不显示类似 `host/model` 或 `provider:model` 的组合格式。

### 5.3 think high/xhigh 使用 rainbow

**Given** 当前思考度为 `high` 或 `xhigh`  
**When** 渲染 `think:label`  
**Then** `think:label` 整体使用 rainbow 规则逐字符配色  
**And** 非空格且非冒号字符应轮换使用 8 个 hex 色  
**And** 冒号 `:` 不着色  
**And** 空格不着色  
**And** 输出末尾应 reset 颜色。

### 5.4 think off/minimal/low/medium 使用语义色

**Given** 当前思考度为 `off`、`minimal`、`low` 或 `medium`  
**When** 渲染 thinking 段  
**Then** 不使用 rainbow 逐字符颜色  
**And** 使用对应语义色  
**And** 文本仍应表达当前 thinking level。

### 5.5 context 有 window 时显示紧凑进度条

**Given** context usage 可读取：

- `tokens = 190000`
- `contextWindow = 272000`

**When** 渲染上下文段  
**Then** 应显示类似 `ctx █████░ 69.9%/272k` 的紧凑格式  
**And** 应包含 `ctx` 前缀  
**And** 应包含进度条字符  
**And** 应显示一位小数百分比  
**And** 应显示格式化后的 context window，例如 `272k`  
**And** 颜色应根据百分比变化。

### 5.6 context 百分比颜色阈值

**Given** context usage 有 tokens 与 contextWindow  
**When** 百分比小于等于 70  
**Then** 上下文段使用 context 语义色。

**When** 百分比大于 70 且小于等于 90  
**Then** 上下文段使用 warning 语义色。

**When** 百分比大于 90  
**Then** 上下文段使用 error 语义色。

### 5.7 context 无 window 时 fallback 到已用量

**Given** context usage 可读取已用 tokens  
**And** 不能读取 `contextWindow` / context window  
**When** 渲染上下文段  
**Then** 只显示已用量，例如 `ctx 37k`  
**And** 不显示进度条  
**And** 不显示百分比  
**And** 不显示 `/window` 后缀。

### 5.8 context 连已用量都不可得时隐藏

**Given** context usage 不可读取 tokens  
**When** 渲染上方状态栏  
**Then** 应隐藏上下文段  
**And** 不应显示 `ctx` 占位文本  
**And** 不应显示错误或 `undefined` / `NaN`。

### 5.9 elapsed 从当前 UI session 绑定时刻开始

**Given** 当前 conversation 历史创建时间早于当前 UI 打开时间  
**And** bottom status runtime 在当前 UI session 打开/绑定时记录 session start  
**When** 渲染 elapsed 时间  
**Then** elapsed 应使用当前 UI session start 计算  
**And** 不使用历史 conversation 创建时间  
**And** 最小单位为秒  
**And** 不显示小数。

### 5.10 elapsed 小于 1 秒时可隐藏

**Given** 当前 UI session 刚打开不足 1 秒  
**When** 渲染上方状态栏  
**Then** elapsed 时间段可以隐藏  
**And** 不应显示 `0.1s`、`0.5s` 等小数秒。

### 5.11 下方 last prompt 显示上一个用户问题

**Given** 用户提交问题 `请解释一下这个错误`  
**And** runtime 收到 `before_agent_start` 事件，事件中包含 `prompt`  
**When** 渲染输入框下方状态栏  
**Then** 下方状态栏显示 `↳ 请解释一下这个错误`  
**And** widget placement 应为 `belowEditor`。

### 5.12 last prompt 压缩空白并单行显示

**Given** 上一个用户问题包含换行、多空格或制表符  
**When** 渲染 last prompt  
**Then** 应将连续空白压缩为单个空格  
**And** 只显示一行  
**And** 不破坏下方 widget 布局。

### 5.13 last prompt 按宽度截断

**Given** 上一个用户问题很长  
**And** 可用宽度不足以完整显示  
**When** 渲染 last prompt  
**Then** 应按可用宽度截断  
**And** 保留 `↳ ` 前缀  
**And** 不换行  
**And** 不溢出 fixed bottom editor 可用宽度。

### 5.14 last prompt 无内容时隐藏

**Given** 尚无用户问题  
**Or** `before_agent_start` 事件没有有效 prompt  
**When** 渲染输入框下方状态栏  
**Then** 下方 last prompt widget 应隐藏或渲染为空  
**And** 不显示 `↳` 空占位  
**And** 不显示 `undefined` / `null`。

### 5.15 宽度不足时上方状态栏优雅降级

**Given** terminal 宽度较窄  
**When** 渲染上方状态栏  
**Then** 状态栏不应换行  
**And** 不应抛错  
**And** 应优先保持模型与关键状态可读  
**And** 可按实现策略截断、缩短或隐藏低优先级段。

### 5.16 数据缺失时不显示脏值

**Given** 模型、思考度、context usage 或 elapsed 的某些数据缺失  
**When** 渲染状态栏  
**Then** 缺失段应隐藏或使用合理默认  
**And** 不显示 `undefined`、`null`、`NaN`、`[object Object]`  
**And** 不影响其他可用段显示。

### 5.17 fixed editor 集成

**Given** fixed bottom editor runtime 已接管 bottom layout  
**When** bottom status 注册 widgets  
**Then** 上方状态栏通过 `aboveEditor` widget 注册  
**And** 下方 last prompt 通过 `belowEditor` widget 注册  
**And** 输入框本体仍由 fixed bottom editor 的 editor container 管理  
**And** bottom status 不应直接移动、重建或覆盖输入框本体。

### 5.18 Alt+S 暂存/恢复不回归

**Given** bottom status runtime 已启用  
**And** 用户在输入框中有草稿内容  
**When** 用户按下 `Alt+S` 暂存  
**Then** 草稿应被暂存  
**And** 输入框状态符合当前已有行为。

**When** 用户再次按下 `Alt+S` 恢复  
**Then** 草稿应恢复  
**And** bottom status 上下 widget 改造不应破坏该快捷键处理。

### 5.19 不恢复旧命令与复杂原版功能

**Given** 用户使用 `/alps-pi` 命令或查看文档  
**When** 本次 bottom status 改造完成  
**Then** 不应新增或恢复 `/alps-pi enable/disable/config/config-ui/settings` 旧子命令  
**And** 不应新增 bash mode、welcome、jump、复杂 preset/config。

## 6. TDD 测试计划

后续实现应优先补测试，再修改源码。测试文件可按现有结构调整，以下为建议新增/修改点与断言要点。

### 6.1 `test/bottom-status.test.ts`

建议覆盖 `BottomStatusRuntime` 的核心格式化与状态更新行为。

断言要点：

- 模型段：
  - 只输出模型名。
  - 不输出 host/provider。
- thinking 段：
  - `high` / `xhigh` 使用 rainbow 输出。
  - rainbow 跳过空格与冒号。
  - rainbow 使用指定 8 个 hex 色循环。
  - rainbow 末尾 reset。
  - `off` / `minimal` / `low` / `medium` 不使用 rainbow，使用语义色。
- context 段：
  - 有 tokens 与 contextWindow 时输出紧凑进度条。
  - 百分比保留一位小数。
  - window 使用 token 格式化，例如 `272k`。
  - `pct > 90` 使用 error。
  - `pct > 70` 使用 warning。
  - 其他使用 context。
  - 无 contextWindow 但有 tokens 时输出 `ctx 37k` 类 fallback。
  - 无 tokens 时隐藏 context 段。
  - 不输出 `undefined`、`NaN`。
- elapsed 段：
  - 可通过 fake timers 或注入 clock 验证从 runtime session start 计算。
  - 小于 1000ms 隐藏。
  - 秒级显示无小数。
  - 分钟/小时格式符合实现约定，并保留 h/m/s 语义。
- last prompt：
  - `setLastPrompt` 或等价 API 后，下方内容显示 `↳ 文本`。
  - 压缩换行、多空格、tab。
  - 宽度不足时截断且不换行。
  - 无 prompt 时隐藏。
- widget 注册：
  - 上方 widget placement 为 `aboveEditor`。
  - 下方 widget placement 为 `belowEditor`。
- `Alt+S`：
  - 保留现有暂存/恢复相关测试。
  - 如原测试只覆盖单 widget，需补充双 widget 后快捷键仍可用。

### 6.2 `test/extension-entry.test.ts`

建议覆盖 extension entry 对事件的监听与 runtime API 调用。

断言要点：

- `index.ts` 继续监听：
  - `model_select`
  - `thinking_level_select`
  - `message_update`
  - `message_end`
  - `turn_end`
- 新增监听：
  - `before_agent_start`
- `before_agent_start` 收到 `event.prompt` 时调用 `BottomStatusRuntime.setLastPrompt(prompt)` 或等价方法。
- UI session 打开/绑定时调用 `resetSessionStartTime()` / `bindSession()` 或等价方法。
- 不因新增 last prompt 监听影响已有 model/thinking/token 更新链路。
- 不恢复 `/alps-pi enable/disable/config/config-ui/settings` 子命令注册。

### 6.3 `test/settings-ui.test.ts`

本需求不引入旧 config/settings UI，但应防止回归。

断言要点：

- 不新增 `/alps-pi settings`。
- 不新增 `/alps-pi config` 或 `/alps-pi config-ui`。
- 若当前测试已有 settings UI 快照或命令列表，应确认 bottom status 改造未改变非目标命令行为。
- 不出现复杂 preset/config 入口。

### 6.4 `test/readme-regression.test.ts`

建议用于防止文档或 README 回归为旧命令说明。

断言要点：

- README 或相关用户文档不重新宣传 `/alps-pi enable`、`/alps-pi disable`、`/alps-pi config`、`/alps-pi config-ui`、`/alps-pi settings`。
- 文档不宣称引入 bash mode、welcome、jump、复杂 preset/config。
- 如 README 描述 bottom status，应与三层布局、模型名-only、context fallback、last prompt 一致。

### 6.5 `test/fixed-bottom-editor-runtime.test.ts`

建议覆盖 fixed bottom editor 与 bottom status widget placement 的协作。

断言要点：

- fixed editor runtime 仍接管：
  - `statusContainer`
  - `widgetContainerAbove`
  - `editorContainer`
  - `widgetContainerBelow`
- `aboveEditor` widget 被渲染到输入框上方容器。
- `belowEditor` widget 被渲染到输入框下方容器。
- 输入框本体仍位于 editor container。
- 下方 last prompt 不覆盖输入框，不导致输入框位置跳动。
- 上下 widget 内容变化时 fixed editor layout 仍稳定。

### 6.6 其他可选测试

如果项目中已有 renderer/format helper 单测，可将纯格式化逻辑拆到 helper 后新增更细粒度测试：

- `formatTokens(999) => 999`，`formatTokens(37000) => 37k`，`formatTokens(272000) => 272k` 等约定。
- progress bar 宽度、填充字符、空字符在不同百分比下稳定。
- truncate helper 对 ANSI 色码宽度处理正确，避免颜色码干扰可视宽度。

## 7. 实现落点建议

### 7.1 `BottomStatusRuntime` API

建议在 `src/features/bottom-status/index.ts` 的 `BottomStatusRuntime` 中新增或明确以下语义：

- `setLastPrompt(prompt: string | undefined | null)`
  - 保存最近一次有效用户 prompt。
  - 内部负责空白压缩或在 render 时处理。
- `resetSessionStartTime(now?: number)` 或 `bindSession(sessionLike?: unknown)`
  - 在 UI session 打开/绑定时记录当前时间。
  - 不使用历史 conversation 创建时间。
  - 测试可通过注入 clock 或传入 now 控制。
- `setContextUsage(usage)` 或在 render 时读取 context provider
  - usage 至少兼容 tokens、contextWindow、percent。
  - 若 percent 不可信但 tokens/window 可用，可用 `tokens / contextWindow * 100` 计算。
- 上方 render 与下方 render 分离：
  - 上方：model、thinking、context、elapsed。
  - 下方：last prompt。

保留现有 `Alt+S` 暂存/恢复处理，不因拆分 widget 或新增 API 删除现有逻辑。

### 7.2 extension entry 事件监听

建议在 `D:/workspace/alps-pi/index.ts`：

- 继续保留现有监听：
  - `model_select`
  - `thinking_level_select`
  - `message_update`
  - `message_end`
  - `turn_end`
- 新增监听 `before_agent_start`：
  - 从 `event.prompt` 读取用户问题。
  - 调用 `bottomStatusRuntime.setLastPrompt(event.prompt)` 或等价 API。
- 在当前 UI session 打开/绑定时调用：
  - `bottomStatusRuntime.resetSessionStartTime()` 或 `bottomStatusRuntime.bindSession(...)`。
- 不增加旧 `/alps-pi` 子命令。

### 7.3 widget 注册

建议 bottom status 注册两个 widget：

- `aboveEditor`：模型、思考度、context、elapsed。
- `belowEditor`：last prompt。

实现时应依赖 fixed bottom editor runtime 已有容器，不要自行 fixed 定位输入框，不要重排 editor container。

### 7.4 context usage 读取策略

建议读取顺序：

1. 优先使用宿主 ctx 的 `getContextUsage()`，兼容原版字段：
   - `tokens`
   - `contextWindow`
   - `percent`
2. 若已有事件或 message/token 统计只提供 used tokens：
   - 可作为 fallback tokens。
3. 若 tokens 与 contextWindow 都有：
   - 显示 `ctx <bar> <pct.toFixed(1)>%/<formatTokens(contextWindow)>`。
   - 若 `percent` 缺失，用 `tokens / contextWindow * 100` 计算。
4. 若只有 tokens：
   - 显示 `ctx <formatTokens(tokens)>`。
5. 若 tokens 不可得：
   - 隐藏 context 段。

注意：无 window fallback 不显示进度条、不显示百分比、不显示 `/window`。

### 7.5 格式化与 ANSI 宽度

- last prompt 与上方状态栏都应考虑 ANSI 色码不计入可视宽度。
- 截断应按 terminal 可视宽度处理，避免半截 ANSI reset 或颜色泄漏。
- rainbow 输出必须在末尾 reset。
- 冒号与空格不着色，但仍占可视宽度。

## 8. 风险

- **session start 语义混淆**：容易误用历史 conversation 创建时间，必须以当前 UI session 打开/绑定时刻为准。
- **context 数据来源不稳定**：不同宿主环境可能没有 `contextWindow`，必须实现 tokens-only fallback 与完全隐藏策略。
- **ANSI 宽度处理**：rainbow、语义色、截断混用时可能导致可视宽度计算错误或颜色泄漏。
- **fixed editor 布局冲突**：bottom status 不应重写 editor container，否则可能造成输入框跳动或覆盖。
- **Alt+S 回归**：拆分上下 widget 时容易误删或改变快捷键注册位置，必须用测试保护。
- **旧命令回归**：实现时不应借机恢复旧 `/alps-pi` config/settings 子命令或原版复杂功能。

## 9. 验收标准

实现完成后应满足：

- 输入框上方显示模型、思考度、context、elapsed。
- 输入框本体仍由 fixed bottom editor 管理。
- 输入框下方显示上一个用户问题。
- 模型只显示模型名，不显示 host/provider。
- `high` / `xhigh` thinking 使用必要 rainbow 行为。
- context 有 window 时显示紧凑进度条与百分比/window。
- context 无 window 但有 tokens 时只显示已用量。
- context 无 tokens 时隐藏。
- elapsed 从当前 UI session 打开/绑定时刻开始，秒级无小数。
- last prompt 使用 `↳ 文本`，单行、压缩空白、按宽度截断，无内容隐藏。
- fixed editor 上下 widget placement 正确。
- `Alt+S` 暂存/恢复不回归。
- 不恢复旧 `/alps-pi enable/disable/config/config-ui/settings` 子命令。
- 不引入 bash mode、welcome、jump、复杂 preset/config。

## 10. 验收命令

```bat
cd /d/workspace/alps-pi && C:/Users/Administrator/AppData/Local/nvm/v22.22.3/npm.cmd test
```
