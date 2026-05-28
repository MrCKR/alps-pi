# Fixed Bottom Editor 滚动性能优化方案

> 状态：已固化，当前阶段按本文“第一阶段实现范围”推进。
> 背景：fixed bottom editor 开启后，用户反馈滚动仍明显卡手，且消息越多体感越差。

## 1. 当前结论

fixed bottom editor 使用 alternate screen 与 SGR mouse reporting 接管滚轮，避免终端原生滚动把底部输入框滚走。代价是：滚轮不再由终端原生滚动处理，而是由扩展在 JS 层重绘上方聊天 viewport。

当前滚轮热路径：

```text
SGR wheel packet
  -> FixedBottomEditorCompositor.handleInput()
  -> handleMousePacket()
  -> scrollBy(delta)
  -> repaintScrollableViewport()
  -> terminal.write(ANSI buffer)
```

Pi TUI 的 `inputListener` 返回 `{ consume: true }` 后，本次输入不会继续交给 focused editor，也不会由 Pi TUI 自动 `requestRender()`。因此当前主要卡顿不是“滚轮触发 Pi 整棵 TUI render”，而是 compositor 自己在输入回调内做高频同步 repaint。

## 2. 主要性能热点

### 2.1 每个滚轮事件同步重绘整个上方 viewport

`repaintScrollableViewport()` 会逐行清空并重写可滚动区，再写回必要的 terminal 状态。终端越高，单次输出越大；滚轮事件越密，阻塞越明显。

### 2.2 一次滚动重复计算 bottom cluster

当前滚动路径中，`updateScrollBoundsFromCache()` 和 `repaintScrollableViewport()` 都会调用 `getCluster()`。而 `getCluster()` 会进一步渲染隐藏的 editor/status/widget 与 bottom status layout。

```text
scrollBy()
  -> updateScrollBoundsFromCache()
     -> getCluster()
  -> repaintScrollableViewport()
     -> getCluster()
```

### 2.3 滚动上方聊天区时仍重绘底部 cluster

普通聊天区滚动并不会改变底部输入框内容，但当前 repaint 会附带 `buildFixedEditorClusterPaint()`，重复清空并重写底部输入框、状态行与光标。

### 2.4 bottomStatus 关闭时仍可能计算状态

`getStatusLayout()` 先调用 `renderBottomInputStatus()`，后判断缓存。`renderBottomInputStatus()` 生成 cacheKey 时会读取 context usage、thinking、extension statuses 等。底部状态栏关闭时，这些计算没有必要。

### 2.5 同步 terminal.write 大 buffer

Pi TUI 的 terminal write 最终是 `process.stdout.write(data)`，没有 await/drain/backpressure。Windows + WarpTerminal 下，大量 ANSI 输出会直接影响输入处理手感。

## 3. 第一阶段实现范围

第一阶段只做低风险、可测试的热路径优化，不改变 fixed bottom editor 的交互模型。

### 3.1 Wheel coalescing

目标：短时间内多个滚轮 delta 合并为一次 repaint。

建议实现：

```ts
const WHEEL_REPAINT_COALESCE_MS = 8;

private pendingWheelDelta = 0;
private wheelFlushTimer: ReturnType<typeof setTimeout> | null = null;
```

规则：

- 如果输入包全是 wheel packet：累加 delta，只排一次 flush。
- flush 时调用一次 `scrollBy(totalDelta)`。
- 遇到非 wheel 的鼠标事件（press/drag/release/right click）前，先 flush pending wheel，保证事件顺序正确。
- dispose 时清理 timer 与 pending delta。

预期效果：

```text
10 个 wheel packet
  优化前：最多 10 次 terminal.write
  优化后：通常 1~2 次 terminal.write
```

### 3.2 一次滚动只计算一次 cluster

目标：消除 `scrollBy()` 中重复 `getCluster()`。

建议实现：

```ts
type ScrollMetrics = {
  width: number;
  rawRows: number;
  cluster: FixedEditorCluster;
  scrollableRows: number;
};
```

`scrollBy()` 先生成 metrics，再传给滚动边界更新与 viewport repaint 复用。

### 3.3 普通滚动不重绘底部 cluster

目标：上方聊天区滚动时，不再清空并重写底部输入框区域。

建议实现：

- `repaintScrollableViewport(metrics, { paintCluster })` 支持只 repaint root viewport。
- 普通滚动使用 `paintCluster: false`。
- 只追加恢复 scroll region / cursor 的最小 ANSI 序列。
- cluster selection 或其它确实改变底部 cluster 的路径继续完整 repaint。

### 3.4 bottomStatus OFF 早返回

目标：底部状态栏关闭时，`getStatusLayout()` 不读取 context usage、thinking、extension statuses。

规则：

- `bottomStatusEnabled === false` 时直接返回空 layout。
- 缓存仍要安全，不共享后续可能被修改的数组。
- footerData branch/status 变化时应先 `resetLayoutCache()`，再 `requestRender()`。

### 3.5 补性能回归测试

测试不依赖真实 TUI 手感，使用现有 compositor harness 计数：

- wheel burst 合并后 terminal write 次数明显下降。
- wheel burst 合并后 renderCluster 次数明显下降。
- 一次滚动最多计算一次 cluster。
- 普通滚动不输出底部 cluster paint 的清行重绘序列。
- bottomStatus OFF 时不读取 footerData/context usage。
- 非 wheel 鼠标事件前会 flush pending wheel。

## 4. 第二阶段候选方向

第二阶段不预设必做，只有在第一阶段完成并经真实 TUI 复测后仍有明显卡顿、残影或状态不同步时再进入。第二阶段优先做可开关、可回退、可量化的增强。

### 4.1 滚动停止后节流同步 Pi TUI render

适用条件：第一阶段后滚动即时性改善，但出现手动 repaint 与 Pi TUI 内部 `previousLines` / viewport 状态不同步，例如滚动后被下一帧覆盖、回弹、残影。

方向：

```text
wheel/keyboard scroll -> 立即局部 repaint
滚动停止 50~100ms -> 最多触发一次 tui.requestRender()
```

约束：

- 不恢复“每个 wheel 都 requestRender”。
- requestRender 必须节流，并且滚动 burst 期间不抢占同步 repaint。
- 需要测试 requestRender 调用次数，避免重新引入 full render 风暴。

### 4.2 root cache dirty 机制

适用条件：第一阶段后发现 `rootLines` 缓存 stale，导致滚动边界错误、滚不到新消息、或消息更新后滚动窗口不准。

方向：

- 普通 TUI render 完成后 root cache 标记为 clean。
- terminal write / message update / resize / full render request 标记 root dirty。
- scrollBy 遇到 dirty 时刷新 root window，否则使用缓存。

目标是在正确性和性能之间折中，避免每次滚动都 full render，也避免永久使用旧 rootLines。

### 4.3 render pass cluster cache

适用条件：第一阶段后性能计数显示单次 TUI doRender 内仍多次渲染 bottom cluster。

方向：参考原版 `pi-powerline-footer`：

```text
renderPassActive
renderPassCluster(width, terminalRows, cluster)
```

同一 render pass 内，相同 width/rows 的 cluster 只计算一次。

约束：

- 只缓存单次 render pass，不做长期全局缓存，避免 editor 内容/states 失真。
- selection cluster、status 变化、resize 不能复用旧 cluster。

### 4.4 可选的终端原生局部 scroll 实验

适用条件：第一阶段后 terminal.write bytes 仍是主要瓶颈，且其它优化已经不足。

方向：使用 scroll region + CSI scroll up/down，只重绘新露出的几行，而不是整屏 repaint。

风险：

- 不同终端兼容性不一致，Windows/WarpTerminal 需要实测。
- 容易和 Pi TUI 的 diff buffer、cursor、scroll region 状态不同步。
- 容易产生残影。

约束：

- 必须放在内部开关或实验 flag 后面。
- 默认关闭。
- 需要保留完整 repaint fallback。
- 只有真实终端验证稳定后才考虑默认启用。

### 4.5 滚动热路径行缓存与 selection 节流

适用条件：拖选或大段 selection 时仍明显卡顿。

方向：

- 缓存 `sanitizeLine()` / `stripAnsi()` / `visibleWidth()` 结果。
- selection drag repaint 加 8~16ms 节流。
- 大选区 copy 的文本提取尽量不阻塞拖动路径。

约束：普通滚动优先，不为了拖选优化牺牲交互正确性。

### 4.6 轻量性能诊断开关

适用条件：真实手感仍与测试计数不一致，需要定位具体瓶颈。

方向：通过环境变量开启内部计数日志，例如：

```text
ALPS_PI_FIXED_SCROLL_DEBUG=1
```

记录 wheel burst、write 次数、write bytes、renderCluster 次数、requestRender 次数。

约束：

- 默认关闭。
- 不新增用户可见 profiler UI。
- 日志必须节流，不能成为新的卡顿来源。

## 5. 第一阶段不做

这些方向暂不进入第一阶段，避免一次改动过大或引入终端兼容风险。

### 5.1 不直接恢复每次滚动 `tui.requestRender()`

原版滚动后会 `requestRender()`，但在当前卡顿场景下，直接恢复可能重新引入整棵 TUI render。若后续发现手动 repaint 与 Pi TUI 内部 diff buffer 不同步，应改为“滚动停止后节流同步一次”，而不是每个 wheel 都 full render。

### 5.2 不使用终端原生局部 scroll 指令

理论上可以通过 scroll region + CSI scroll up/down 只绘制新增行，显著减少输出 bytes。但这会牵涉终端兼容、cursor 状态、Pi TUI previousLines 同步与残影问题。当前阶段先不做。

### 5.3 不重写 fixed bottom editor 架构

不拆分独立扩展，不改变统一 bottom-input runtime / 单一 footer owner 架构。本轮只优化热路径。

### 5.4 不引入完整性能 profiler UI

第一阶段只用测试计数和必要的内部结构优化。不新增用户可见 profiling 面板或长期日志。

## 6. 验收标准

第一阶段完成后：

```text
npm test 全部通过
pi install D:/workspace/alps-pi 成功
/reload 后 fixed bottom editor 仍可用
开关底部状态栏后 fixed 不失效
滚轮连续滚动时体感明显更跟手
```

量化目标：

```text
10 个 wheel packet：
  originalRenderCalls = 0
  terminal.write 次数 <= 2
  renderClusterCalls 显著少于优化前，目标 <= 2
```
