# Fixed Bottom Editor BDD/TDD 实施计划

## 1. 目标

为 `alps-pi` 增加 **固定底部输入框（fixed bottom editor）** 能力。

约束：

- 默认关闭。
- 只能通过 `/alps-pi` 设置面板开关控制。
- 实现真正的“聊天区在上方滚动，输入框固定在终端底部”，不是普通 `belowEditor` widget。
- 第一版只做固定输入框最小可用闭环，不加入 stash、bash mode、chat jump、鼠标选择、状态条等附加功能。

## 2. 成功标准

1. 新装或 `/reload` 后，固定底部输入框默认关闭。
2. `/alps-pi` 设置面板出现 `固定输入框` 开关。
3. 打开开关后，运行时安装 fixed editor runtime，输入框固定在底部，聊天内容在上方独立滚动。
4. 关闭开关后，恢复 Pi 默认输入框布局。
5. 多次开关、`/reload`、`session_shutdown` 后不会留下脏终端状态。
6. 现有消息线框能力不回归：总开关、assistant 正文线框、preview 继续可用。
7. 自动化测试覆盖设置、命令契约、runtime 生命周期、cluster 裁剪与 compositor 恢复。

## 3. 非目标

第一版不做：

- 鼠标滚轮滚动聊天区。
- 右键菜单、拖拽选择、复制增强。
- chat jump 快捷键。
- bash transcript / sticky bash mode。
- prompt stash / prompt history。
- powerline 多段状态栏。
- working vibes / welcome overlay。
- settings.json 持久化。

## 4. 设计边界

### 4.1 模块边界

新增模块建议：

```text
src/features/fixed-bottom-editor/
  runtime.ts       运行时启停、session 绑定、资源恢复
  cluster.ts       底部固定区域组装、裁剪、光标提取
  compositor.ts    terminal split compositor，负责真正固定底部绘制
  index.ts         fixed editor feature 统一导出
```

现有文件职责：

```text
src/settings.ts                         新增 fixedBottomEditor.enabled 默认 false
src/settings-ui.ts                      新增固定输入框设置项；当前设置面板共五项，固定输入框为第五项
src/commands.ts                         把 fixed runtime ops 注入设置面板
index.ts                                session_start 绑定 runtime，session_shutdown 释放 runtime
src/features/chrome-frame/patch.ts      保持消息 chrome patch 职责，不塞 compositor 状态
```

### 4.2 状态设计

设置字段：

```ts
export type AlpsPiSettings = {
  chromeFrame: {
    enabled: boolean;
    assistantFrame: boolean;
  };
  fixedBottomEditor: {
    enabled: boolean;
  };
};

export const DEFAULT_SETTINGS: AlpsPiSettings = {
  chromeFrame: {
    enabled: false,
    assistantFrame: true,
  },
  fixedBottomEditor: {
    enabled: false,
  },
};
```

runtime 状态建议：

```ts
export type FixedBottomEditorStatus = {
  enabled: boolean;
  installed: boolean;
  failure?: string;
};
```

runtime API 建议：

```ts
export type FixedBottomEditorRuntime = {
  bindSession(ctx: any): void;
  setEnabled(enabled: boolean): FixedBottomEditorStatus;
  dispose(): void;
  getStatus(): FixedBottomEditorStatus;
};
```

## 5. BDD 场景

### Feature: 固定底部输入框默认关闭

```gherkin
Scenario: 新会话默认不启用固定输入框
  Given 用户启动 alps-pi 扩展
  When session_start 触发
  Then fixedBottomEditor 设置应为 false
  And 不应调用 ctx.ui.setEditorComponent
  And 不应安装 TerminalSplitCompositor
```

验收测试：

- `DEFAULT_SETTINGS.fixedBottomEditor.enabled === false`
- fake `session_start` 下 runtime 不安装。

---

### Feature: 设置面板展示固定输入框开关

```gherkin
Scenario: 用户打开 /alps-pi 设置面板
  Given fixedBottomEditor 默认关闭
  When 用户执行 /alps-pi
  Then 设置面板显示 总开关
  And 设置面板显示 正文线框
  And 设置面板显示 Tool 极简模式
  And 设置面板显示 极简下收起 edit
  And 设置面板显示 固定输入框
  And 固定输入框 当前状态为 OFF
```

验收测试：

- `settings-ui` 渲染包含 `固定输入框`。
- 初始状态显示 `OFF`。
- 每行 `visibleWidth(line) === width`。

---

### Feature: 用户通过设置面板启用固定输入框

```gherkin
Scenario: 用户打开固定输入框
  Given /alps-pi 设置面板已打开
  And 当前 fixedBottomEditor 为 false
  When 用户移动到 固定输入框
  And 按 Enter 或 Space
  Then fixedBottomEditor 应变为 true
  And runtime.setEnabled(true) 被调用
  And runtime 尝试安装 custom editor 与 compositor
```

验收测试：

- `settings-ui` 第五项切换调用 fixed runtime op。
- 成功时状态变为 `ON`。
- 失败时状态回滚为 `OFF` 或记录 `failure`，不能半安装。

---

### Feature: 用户通过设置面板关闭固定输入框

```gherkin
Scenario: 用户关闭固定输入框
  Given fixedBottomEditor 为 true
  And fixed editor runtime 已安装
  When 用户在设置面板关闭 固定输入框
  Then fixedBottomEditor 应变为 false
  And runtime.setEnabled(false) 被调用
  And compositor.dispose() 被调用
  And Pi 默认 editor/footer 布局恢复
```

验收测试：

- `dispose()` 后 `terminal.write`、`terminal.rows`、`tui.render`、`tui.doRender` 均恢复。
- 重复关闭不抛异常。

---

### Feature: reload/shutdown 清理终端状态

```gherkin
Scenario: 固定输入框开启时 reload
  Given fixed editor runtime 已安装
  When session_shutdown 触发
  Then runtime.dispose() 必须先执行
  And terminal scroll region 被 reset
  And terminal.write 被恢复
  And 消息 chrome patch 被回滚
```

验收测试：

- fake `session_shutdown` 调用 runtime dispose。
- dispose 是幂等的。
- 即使安装失败过，也能安全调用 dispose。

---

### Feature: overlay 打开时 compositor 不覆盖 overlay

```gherkin
Scenario: 设置面板 overlay 可见
  Given fixed editor runtime 已安装
  And TUI overlayStack 中存在可见 overlay
  When TUI 发生 render 或 terminal.write
  Then compositor 不应重绘 fixed cluster 覆盖 overlay
  And 不应消费 overlay 输入
```

验收测试：

- fake `tui.hasOverlay() === true` 时，compositor 走原始 render/write。
- 设置面板打开期间切换开关，不出现半安装状态。

---

### Feature: 底部 cluster 光标安全

```gherkin
Scenario: editor render 行包含 CURSOR_MARKER
  Given editorLines 中包含 pi TUI 光标 marker
  When renderFixedEditorCluster 处理这些行
  Then 输出 lines 中不再包含 marker
  And 返回 cursor.row / cursor.col 对应 marker 原始可见位置
```

验收测试：

- `cluster.ts` 单测覆盖 cursor 提取。
- CJK/ANSI 行宽不超过输入 width。
- 多行 editor 超出可用高度时，优先保留包含 cursor 的区域。

## 6. TDD 任务拆解

### 阶段 1：设置模型与设置面板

先写测试：

- `test/settings.test.ts`
  - `DEFAULT_SETTINGS.fixedBottomEditor.enabled` 为 `false`。
  - `cloneDefaultSettings()` 返回包含 `fixedBottomEditor` 的新对象。

- `test/settings-ui.test.ts`
  - 面板渲染五项。
  - `固定输入框` 初始为 `OFF`。
  - `Down x4 -> Space` 可切换第五项。
  - 切换第五项时调用 `setFixedBottomEditorEnabled(true)`。
  - 每行宽度仍等于 render width。

再实现：

- 修改 `src/settings.ts`。
- 修改 `src/settings-ui.ts` 的 `OPTIONS`、render rows、toggle 分支和 `SettingsPanelOps`。

验收命令：

```bash
C:/Users/Administrator/AppData/Local/nvm/v22.22.3/npm.cmd test
```

---

### 阶段 2：命令层注入 runtime ops

先写测试：

- `test/command-contract.test.ts`
  - `/alps-pi` 打开设置面板时，把 fixed runtime ops 传给 settings component。
  - 切换固定输入框不会调用 message patch enable/disable。
  - `/alps-pi` 设置界面切换 fixed editor 时调用 runtime ops。

再实现：

- 扩展 `CommandOps`。
- `registerAlpsPiCommand()` 创建 settings component 时传入 fixed editor ops。

---

### 阶段 3：cluster 纯函数

先写测试：

- `test/fixed-bottom-editor-cluster.test.ts`
  - 空 lines 返回空 cluster。
  - 行宽超过 width 时会截断。
  - ANSI/CJK 不导致可见宽度超出 width。
  - 包含 `CURSOR_MARKER` 时能提取 cursor，并从输出行删除 marker。
  - editor 行数超过可用高度时，优先保留 cursor 附近行。

再实现：

- 新增 `src/features/fixed-bottom-editor/cluster.ts`。
- 从 `@earendil-works/pi-tui` 使用 `CURSOR_MARKER`、`visibleWidth`、`truncateToWidth`。

---

### 阶段 4：最小 compositor

先写测试：

- `test/fixed-bottom-editor-compositor.test.ts`
  - `install()` 后替换 `terminal.write`。
  - `install()` 后重定义 `terminal.rows`，返回扣除 cluster 高度后的行数。
  - `install()` 后替换 `tui.render` 或 `tui.doRender`。
  - `hideRenderable()` 让原 editor container 在普通 TUI 树中不渲染。
  - `renderHidden()` 可调用原始 render。
  - `dispose()` 恢复所有被 patch 的引用。
  - `dispose()` 重复调用不抛异常。
  - `tui.hasOverlay() === true` 时不接管 render/write。

再实现：

- 新增 `src/features/fixed-bottom-editor/compositor.ts`。
- 只保留固定输入框必要逻辑：
  - synchronized output
  - scroll region reset
  - cursor move
  - hide/show cursor
  - terminal rows patch
  - terminal write wrapper
  - renderHidden/hideRenderable
  - dispose cleanup
- 第一版不启用 mouse reporting。

---

### 阶段 5：runtime manager

先写测试：

- `test/fixed-bottom-editor-runtime.test.ts`
  - 默认未绑定 session 时 `setEnabled(true)` fail closed。
  - `bindSession(ctx)` 后可保存 ctx。
  - `setEnabled(true)` 会调用 `ctx.ui.setEditorComponent` 和 `ctx.ui.setFooter`。
  - 找不到 `tui.terminal.write` 时记录 failure，状态保持未安装。
  - 重复启用不重复安装。
  - `setEnabled(false)` 调用 compositor dispose 并恢复。
  - `dispose()` 清理 session 引用和 compositor。

再实现：

- 新增 `src/features/fixed-bottom-editor/runtime.ts`。
- runtime 不依赖 `patch.ts` 内部 monkey patch 结构。

---

### 阶段 6：入口接入

先写测试：

- `test/extension-entry.test.ts`
  - extension load 后注册 `session_start` 和 `session_shutdown`。
  - `session_start` 调用 runtime.bindSession(ctx)`。
  - 默认 fixedBottomEditor false 时不安装。
  - 若设置为 true，则 session_start 尝试安装。
  - `session_shutdown` 先 dispose fixed runtime，再 disablePatch。

再实现：

- 修改 `index.ts`。
- 创建一个模块级 runtime 实例。
- 把 runtime ops 传给 `registerAlpsPiCommand()`。

---

### 阶段 7：文档更新

先写或更新 manifest/readme 测试：

- README 中不再声称完全不涉及 editor/footer。
- README 明确：固定输入框默认关闭，属于实验/高级开关。

再实现：

- 更新 `README.md`：
  - 命令仍然只有 `/alps-pi`、`preview`。
  - 设置面板包含五项：线框美化、Assistant 正文线框、Tool 极简模式、极简下收起 edit、固定输入框。
  - 风险说明：固定输入框会接管 editor/footer 和 terminal 绘制，属于实验性开关。

## 7. 风险与对应防护

| 风险 | 防护 |
| --- | --- |
| 终端 scroll region 污染 | dispose 和 emergency reset 必须 reset scroll region |
| `terminal.write` 未恢复 | compositor 保存原引用，dispose 幂等恢复 |
| overlay 被覆盖 | overlay 可见时 compositor 走原始 render/write |
| 其他 terminal/TUI patch 冲突 | 默认关闭，启用前做能力探测；失败时 fail closed |
| 光标/IME 错位 | cluster 提取 `CURSOR_MARKER`，compositor 移动硬件光标 |
| 行宽超限导致 TUI 崩溃 | cluster/compositor 所有输出行做 visibleWidth 校验与截断 |
| reload 后残留状态 | `session_shutdown` 必须调用 runtime.dispose() |
| 设置面板中切换导致半安装 | runtime 返回状态；失败则回滚设置或记录 failure |

## 8. 手工验收清单

自动化测试通过后，还必须手工验证：

1. `/reload` 后默认关闭。
2. `/alps-pi` 打开设置，第五项固定输入框显示为 OFF。
3. 打开固定输入框后，长对话输出时输入框停留在底部。
4. 关闭固定输入框后，恢复默认布局。
5. 终端 resize 后没有残影和错位。
6. 中文输入法候选窗位置正确。
7. slash command 自动补全仍可用。
8. Tab 文件补全仍可用。
9. Enter 提交、Alt+Enter 换行、Esc/Ctrl+C 行为不回归。
10. `/alps-pi preview` overlay 不被底部输入框覆盖。
11. `/reload`、退出 pi 后 shell 终端不残留鼠标/scroll region/alternate screen 异常。
12. 若存在其他 terminal/TUI patch，固定输入框启用失败时应 fail closed，并能关闭恢复。

## 9. 实施顺序建议

按以下顺序提交，避免一次性大改：

```text
1. settings + settings-ui + 测试
2. command ops + 测试
3. cluster 纯函数 + 测试
4. compositor 最小骨架 + 测试
5. runtime manager + 测试
6. index.ts 生命周期接入 + 测试
7. README 更新 + 手工验证
```

每一步都必须保持：

```bash
C:/Users/Administrator/AppData/Local/nvm/v22.22.3/npm.cmd test
```

通过。

## 10. 暂存审查产物

当前项目根目录下的 `context.md`、`meta-prompt.md` 是本计划前置审查产物，不是运行时代码。实现前建议删除或移动进 `docs/`，避免被误认为包资源。
