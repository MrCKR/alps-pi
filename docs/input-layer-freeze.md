# 输入框分层冻结方案

## 背景

用户实测证明，当前 `美化输入框` 与 `固定输入框` 没有真正独立：

- `fixed OFF + beautified ON` 时美化基本无效。
- `fixed ON + beautified ON` 时外层 Alps 线框包住了 Pi 原生 editor 上下线，形成双线框。
- `/alps-pi` non-overlay 设置页会和 fixed compositor 抢 `editorContainer`，导致设置页不出现、输入被清空、Enter/focus 异常。

因此本轮不再继续在 `renderCluster()` 上打补丁，而是冻结为输入框分层方案。

## 冻结目标

两个开关必须完整独立：

| 固定输入框 | 美化输入框 | 预期行为 |
| --- | --- | --- |
| OFF | OFF | 完全原生输入区；不安装 fixed compositor；不显示 Alps 线框。 |
| OFF | ON | 普通位置输入区；输入框显示 Alps 美化线框；不固定底部。 |
| ON | OFF | 输入区固定底部；保留原生输入框视觉；不显示边框状态。 |
| ON | ON | 输入区固定底部；显示 Alps 美化线框；无 Pi 原生上下线残留。 |

`固定输入框` 只控制位置与 terminal split/fixed compositor。  
`美化输入框` 只控制 editor 视觉与边框状态。  
二者不得互相隐式开启或关闭。

## 架构边界

### 1. Beautified editor layer

新增或拆出独立 editor 视觉层，职责：

- 通过 `ctx.ui.setEditorComponent()` 安装自定义 editor。
- 优先继承 Pi 官方 `CustomEditor`。
- 只 override `render()`；不要从零实现 `EditorComponent`。
- 不重写输入语义。若必须处理输入，只处理 Alps 自己的快捷键，其余必须 `super.handleInput(data)`。
- 调用 `super.render(innerWidth)` 获取 Pi 原生 editor 输出。
- 剥离 Pi 原生 top/bottom rule，只把 editor body 包入 Alps frame。
- autocomplete/popup lines 必须追加在线框外，不得吞掉。
- fixed ON/OFF 都可生效。

### 2. Fixed compositor layer

fixed layer 只负责：

- terminal split。
- 固定底部布局。
- 鼠标滚动、选区、复制、message jump、stash/copy/cut 等 fixed bottom 行为。
- 捕获当前 editor/footer 容器并渲染到底部 cluster。

fixed layer 不负责判断是否美化，不拥有线框视觉语义。

### 3. Bottom-input runtime

保持一个 bottom-input runtime：

```text
fixed editor / beautified editor / status / extension statuses / last prompt
-> one bottom-input runtime
-> one ctx.ui.setFooter owner
```

禁止恢复独立 `bottomStatus` widget。  
禁止重新通过 `ctx.ui.setWidget(aboveEditor/belowEditor)` 渲染底部状态。

runtime 推荐拆为：

```text
syncEditorLayer()
syncFooterBridge()
syncFixedLayer()
```

语义：

- `beautifiedInput.enabled = true`：安装 beautified editor layer。
- `fixedBottomEditor.enabled = true`：安装 fixed compositor layer。
- `beautified OFF + fixed OFF`：恢复原生 editor/footer。
- `fixed ON + beautified OFF`：fixed layer 仍可接管输入区，但 editor render 保持原生视觉。

## 美化线框冻结规格

美化 ON 时：

```text
╭ GPT-5.5 · xhigh ───────────── ━━━━━╸──── 59.5%/272k ╮
│ > 输入内容                                           │
│   多行输入内容                                       │
╰────────────────────────────────────── ◷ 6m17s ──────╯
```

要求：

- 不显示 Pi 原生 editor top/bottom rule。
- 不显示双线框。
- 顶部左侧：`model · thinking`。
- 顶部右侧：context，形如 `━━━━━╸──── 59.5%/272k`。
- 底部右侧：elapsed，形如 `◷ 6m17s`。
- 不显示 `ctx`、`上下文`、`[]`、`think:`。
- model 不带 Nerd Font 图标。
- context bar 宽度为 10。
- `extension statuses` 与 `last prompt` 保持在线框下方。
- 继续保留现有 ANSI、emoji grapheme、cursor marker、SGR reset 安全逻辑。

## 设置页冻结规格

`/alps-pi` 无参设置页改为居中完整框 overlay：

```ts
await ctx.ui.custom(factory, {
  overlay: true,
  overlayOptions: {
    anchor: "center",
    width: "90%",
    minWidth: 56,
    maxHeight: "80%",
    margin: 1,
  },
});
```

要求：

- 不再使用 non-overlay `ctx.ui.custom(factory)` 替换 `editorContainer`。
- fixed compositor 检测到 overlay 时必须让路，不消费 overlay 输入。
- 切换设置后 overlay 焦点不得丢；必要时保存 handle 并 refocus。
- `/alps-pi preview` 继续保持 overlay。
- 不恢复旧入口：
  - `/alps-pi enable`
  - `/alps-pi disable`
  - `/alps-pi config`
  - `/alps-pi config-ui`
  - `/alps-pi settings`

## 配置冻结规格

保留：

```ts
fixedBottomEditor: { enabled: boolean }
beautifiedInput: { enabled: boolean }
```

删除公开配置：

```ts
bottomStatus
```

持久化要求：

- 命名空间继续是 `"alps-pi"`。
- 默认写入 `~/.pi/agent/settings.json["alps-pi"]`。
- 写入时保留 Pi settings 其它字段。
- legacy fallback 只读取/迁移，不删除旧文件。
- `ALPS_PI_SETTINGS_PATH` 存在时完全走独立 path。
- JSON parse 失败时不覆盖用户原生 settings。

## 测试门禁

实现前先补测试，至少覆盖：

1. 四组合矩阵：
   - `fixed OFF + beautified OFF`：完全原生。
   - `fixed OFF + beautified ON`：不固定但有美化线框。
   - `fixed ON + beautified OFF`：固定但无 Alps 线框。
   - `fixed ON + beautified ON`：固定且有 Alps 线框。
2. 美化 ON 时剥离 Pi 原生 editor 上下线，不能双线框。
3. autocomplete/popup lines 追加在线框外。
4. Enter 提交链路不丢。
5. slash command、history、paste、app action、extension shortcuts 不回归；能用现有 harness 覆盖多少就覆盖多少，无法覆盖则在复审报告中列为人工验收项。
6. `/alps-pi` 设置页使用 overlay，不替换 `editorContainer`。
7. fixed compositor 在 overlay 可见时让路。
8. 切换设置后 overlay focus 不丢。
9. 美化 OFF 时不显示 model/thinking/context/elapsed 边框状态，但 extension statuses 与 last prompt 仍保留。
10. 普通滚动不触发 full render、不重绘 bottom cluster 的既有性能测试不能退化。
11. `git diff --check` 通过。
12. 全量测试通过：

```bash
cd /d/workspace/alps-pi && C:/Users/Administrator/AppData/Local/nvm/v22.22.3/npm.cmd test
```

## 非目标

本轮不做：

- 新 preset/theme/icon 系统。
- 完整 command palette。
- bash mode。
- 自定义完整 autocomplete 逻辑。
- 重写 Pi editor 输入状态机。
- patch Pi 内部源码。
- 将 `/alps-pi` 合并进原生 `/settings`。
- 恢复旧 bottom status widget。
- 顺手重构 chrome frame、settings store、无关测试结构。

## 实施顺序

1. 写/调整测试，先暴露当前问题。
2. 新增 beautified editor layer。
3. runtime 拆分 editor layer 与 fixed compositor layer。
4. `/alps-pi` 改 overlay 设置页。
5. 跑 `git diff --check` 与全量测试。
6. 启动门下复审，重点审查：独立开关、无双线框、overlay/focus、Enter/slash/autocomplete/history/paste、滚动性能。
7. 复审 PASS 后安装并提示用户 `/reload`。

## 人工验收清单

安装后用户最小复测：

1. 四种开关组合都切一次。
2. `fixed OFF + beautified ON` 输入框在普通位置有线框。
3. `fixed ON + beautified OFF` 固定底部但没有 Alps 线框。
4. `fixed ON + beautified ON` 只有一层线框。
5. `/alps-pi` 能居中打开，切设置不卡、不吞输入。
6. 普通消息 Enter 能发送。
7. `/reload`、`/alps-pi`、普通 slash command 不被清空吞掉。
8. autocomplete、history、paste、emoji、多行输入正常。
9. 长对话滚动仍然丝滑。
