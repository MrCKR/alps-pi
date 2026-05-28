/** 功能：兼容旧 fixed-bottom-editor/runtime 路径，实际使用统一 bottom-input runtime 实现者：alps 实现日期：2026-05-28 */

export { createBottomInputRuntime as createFixedBottomEditorRuntime } from "../bottom-input/runtime.ts";
export type { BottomInputRuntime as FixedBottomEditorRuntime, FixedBottomEditorStatus } from "../bottom-input/runtime.ts";
