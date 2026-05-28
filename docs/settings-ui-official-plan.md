# /alps-pi 设置界面官方实现方案

## 目标

`/alps-pi` 不并入 Pi 原生 `/settings`，而是按官方扩展模式实现自己的设置界面：

```text
/alps-pi
  -> ctx.ui.custom(factory)
  -> non-overlay
  -> SettingsList
```

同时把 Alps Pi 设置保存到 Pi 原生全局 settings 文件的独立命名空间：

```json
{
  "alps-pi": {
    "chromeFrame": {},
    "fixedBottomEditor": {},
    "bottomStatus": {},
    "shortcuts": {}
  }
}
```

## 边界

- 不注册进原生 `/settings`。
- 不 patch `SettingsSelectorComponent` 或 `InteractiveMode.showSettingsSelector()`。
- 不继续使用 settings overlay。
- `/alps-pi preview` 保持 overlay，因为它是展示预览，不是设置页。
- `ALPS_PI_SETTINGS_PATH` 仍作为测试隔离路径；存在时不读写 Pi 原生 settings。
- 旧路径 `~/.pi/agent/alps-pi/settings.json` 只做 fallback 读取和一次迁移，不主动删除。

## 存储策略

默认读写：

```text
~/.pi/agent/settings.json["alps-pi"]
```

读取顺序：

1. 如果 `ALPS_PI_SETTINGS_PATH` 存在，读取该文件。
2. 否则读取 `~/.pi/agent/settings.json` 的 `"alps-pi"` 字段。
3. 如果字段不存在，再读取旧 `~/.pi/agent/alps-pi/settings.json`。
4. 如果旧设置有效，则写入 `~/.pi/agent/settings.json` 的 `"alps-pi"` 字段。

写入要求：

- 只替换 `"alps-pi"` 字段。
- 保留 Pi 原生 settings 里的其它字段。
- JSON parse 失败时不覆盖用户原生 settings。

## UI 策略

主设置页使用 `SettingsList`：

- 线框美化
- Assistant 正文线框
- Tool 极简模式
- 极简下收起 edit
- 固定输入框
- 底部状态栏
- 快捷键设置

快捷键设置使用 `SettingsList` submenu：

- Enter：进入捕获。
- Esc：捕获中取消；列表中返回上级。
- Backspace：恢复默认。
- 冲突/保留键拒绝，不静默覆盖。

## 验收

- `/alps-pi` 调用 `ctx.ui.custom(factory)`，不传 `overlay: true`。
- 主设置项可切换并触发原有 runtime callbacks。
- 快捷键页保留捕获、取消、恢复默认、冲突拒绝语义。
- 设置写入 `~/.pi/agent/settings.json` 的 `"alps-pi"` 字段。
- 写入不破坏 Pi 原生其它字段。
- 旧独立 settings 可自动迁移。
- 全量测试通过。
