/** 功能：保留固定底部输入框旧入口，兼容导出统一 bottom-input runtime 实现者：alps 实现日期：2026-05-28 */

export { createBottomInputRuntime as createFixedBottomEditorRuntime } from "../bottom-input/runtime.ts";
export type { BottomInputRuntime as FixedBottomEditorRuntime, FixedBottomEditorStatus } from "../bottom-input/runtime.ts";
