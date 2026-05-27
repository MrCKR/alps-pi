/** 功能：管理 fixed bottom editor 的 session 绑定、启停与资源恢复 实现者：alps 实现日期：2026-05-27 */

import * as PiAgent from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import type { FixedBottomEditorStatus } from "../../settings.ts";
import { renderFixedEditorCluster } from "./cluster.ts";
import {
	FixedBottomEditorCompositor,
	type FixedBottomEditorCompositorOptions,
	type FixedEditorRenderable,
	type FixedEditorTerminal,
} from "./compositor.ts";

export type { FixedBottomEditorStatus } from "../../settings.ts";

export type FixedBottomEditorRuntime = {
	/** 绑定当前 pi session context。 */
	bindSession(ctx: any): void;
	/** 启用或禁用 fixed bottom editor，并返回最新状态。 */
	setEnabled(enabled: boolean): FixedBottomEditorStatus;
	/** 释放所有运行时资源；重复调用安全。 */
	dispose(): void;
	/** 读取当前 fixed bottom editor 状态快照。 */
	getStatus(): FixedBottomEditorStatus;
};

type RuntimeUI = {
	setEditorComponent?: (factory: ((tui: any, theme: any, keybindings: any) => any) | undefined) => void;
	setFooter?: (factory: ((tui: any, theme: any, footerData: any) => any) | undefined) => void;
};

type CompositorLike = Pick<FixedBottomEditorCompositor, "install" | "dispose" | "hideRenderable" | "renderHidden" | "requestRepaint">;

type FixedEditorContainers = {
	/** Pi 内置 statusContainer，包含 todo 等扩展状态区域。 */
	statusContainer: FixedEditorRenderable | null;
	/** editor 上方 widget 容器，原版会跟随输入框固定。 */
	widgetContainerAbove: FixedEditorRenderable | null;
	/** custom editor 所在容器。 */
	editorContainer: FixedEditorRenderable;
	/** editor 下方 widget 容器，原版会跟随输入框固定。 */
	widgetContainerBelow: FixedEditorRenderable | null;
};

type FixedBottomEditorRuntimeOptions = {
	/** 测试注入点：生产环境使用真实 compositor。 */
	createCompositor?: (options: FixedBottomEditorCompositorOptions) => CompositorLike;
};

const FALLBACK_EDITOR_THEME = {
	borderColor: (text: string) => text,
	selectList: {},
};

/** 创建 fixed bottom editor runtime；调用方负责把 settings 状态同步给 setEnabled。 */
export function createFixedBottomEditorRuntime(options: FixedBottomEditorRuntimeOptions = {}): FixedBottomEditorRuntime {
	return new FixedBottomEditorRuntimeImpl(options);
}

/** fixed bottom editor runtime 的最小状态机。 */
class FixedBottomEditorRuntimeImpl implements FixedBottomEditorRuntime {
	private readonly createCompositor: (options: FixedBottomEditorCompositorOptions) => CompositorLike;
	private ctx: any;
	private enabled = false;
	private installed = false;
	private failure: string | undefined;
	private layoutInstalled = false;
	private creatingFooter = false;
	private compositor: CompositorLike | null = null;
	private editorInstance: any;
	private footerComponent: any;

	constructor(options: FixedBottomEditorRuntimeOptions) {
		this.createCompositor = options.createCompositor ?? ((compositorOptions) => new FixedBottomEditorCompositor(compositorOptions));
	}

	/** 保存当前 session context；若之前已有安装，先清理旧 session 资源。 */
	bindSession(ctx: any): void {
		if (this.ctx && this.ctx !== ctx && (this.installed || this.layoutInstalled)) {
			this.disable();
		}
		this.ctx = ctx;
		this.failure = undefined;
	}

	/** 根据目标开关状态执行启用或禁用。 */
	setEnabled(enabled: boolean): FixedBottomEditorStatus {
		return enabled ? this.enable() : this.disable();
	}

	/** 释放 compositor、恢复 editor/footer，并清理 session 引用。 */
	dispose(): void {
		this.disable();
		this.ctx = undefined;
		this.editorInstance = undefined;
		this.footerComponent = undefined;
	}

	/** 返回状态快照，避免调用方持有内部可变引用。 */
	getStatus(): FixedBottomEditorStatus {
		return this.toStatus();
	}

	/** 启用 fixed editor layout；footer factory 拿到 tui 后才真正安装 compositor。 */
	private enable(): FixedBottomEditorStatus {
		if (this.installed || (this.enabled && this.layoutInstalled && !this.failure)) {
			return this.toStatus();
		}

		const ui = this.getBoundUI();
		if (!ui) {
			return this.failClosed("fixed bottom editor requires a bound UI session");
		}

		try {
			this.validateUI(ui);
			this.enabled = true;
			this.installed = false;
			this.failure = undefined;
			this.editorInstance = undefined;
			this.footerComponent = undefined;

			ui.setEditorComponent!(this.createEditorFactory());
			this.layoutInstalled = true;

			this.creatingFooter = true;
			try {
				ui.setFooter!(this.createFooterFactory());
			} finally {
				this.creatingFooter = false;
			}
			return this.toStatus();
		} catch (error) {
			this.creatingFooter = false;
			return this.failClosed(formatFailure(error));
		}
	}

	/** 禁用 fixed editor，恢复 Pi 默认 editor/footer 布局。 */
	private disable(): FixedBottomEditorStatus {
		if (!this.enabled && !this.installed && !this.layoutInstalled && !this.failure) {
			return this.toStatus();
		}

		this.enabled = false;
		this.failure = undefined;
		this.teardownCompositor();
		this.restoreDefaultLayout();
		this.installed = false;
		this.layoutInstalled = false;
		this.editorInstance = undefined;
		this.footerComponent = undefined;
		return this.toStatus();
	}

	/** 读取已绑定且可交互的 UI；不可用时返回 undefined 以 fail closed。 */
	private getBoundUI(): RuntimeUI | undefined {
		if (!this.ctx || this.ctx.hasUI !== true || !this.ctx.ui) {
			return undefined;
		}
		return this.ctx.ui as RuntimeUI;
	}

	/** 校验最小 UI 能力，避免只安装半套 editor/footer。 */
	private validateUI(ui: RuntimeUI): void {
		if (typeof ui.setEditorComponent !== "function") {
			throw new Error("fixed bottom editor expected ctx.ui.setEditorComponent(factory) to exist");
		}
		if (typeof ui.setFooter !== "function") {
			throw new Error("fixed bottom editor expected ctx.ui.setFooter(factory) to exist");
		}
	}

	/** 创建 custom editor factory；优先使用 Pi 的 CustomEditor，缺失时回落到 pi-tui Editor。 */
	private createEditorFactory(): (tui: any, theme: any, keybindings: any) => any {
		return (tui: any, theme: any, keybindings: any) => {
			const editor = createEditor(tui, theme, keybindings);
			this.editorInstance = editor;
			return editor;
		};
	}

	/** 创建空 footer factory；它的主要职责是捕获 tui 并安装 compositor。 */
	private createFooterFactory(): (tui: any, theme: any, footerData: any) => any {
		return (tui: any) => {
			try {
				this.installCompositor(tui);
			} catch (error) {
				if (this.creatingFooter) {
					throw error;
				}
				this.failClosed(formatFailure(error));
			}

			const footer = {
				dispose: () => {
					if (this.footerComponent === footer) {
						this.teardownCompositor();
						this.installed = false;
					}
				},
				invalidate: () => {
					this.compositor?.requestRepaint();
				},
				render: () => [],
			};
			this.footerComponent = footer;
			return footer;
		};
	}

	/** 基于 footer 捕获的 tui 安装 terminal split compositor。 */
	private installCompositor(tui: any): void {
		if (this.installed) return;

		const terminal = this.getTerminal(tui);
		const containers = findFixedEditorContainers(tui, this.editorInstance);
		if (!containers) {
			throw new Error("fixed bottom editor could not find the editor container in TUI children");
		}

		let compositor: CompositorLike | null = null;
		try {
			compositor = this.createCompositor({
				tui,
				terminal,
				getShowHardwareCursor: () => typeof tui?.getShowHardwareCursor === "function" ? Boolean(tui.getShowHardwareCursor()) : true,
				renderCluster: (width, terminalRows) => renderFixedEditorCluster({
					statusLines: compositor ? renderHiddenLines(compositor, [containers.widgetContainerAbove, containers.statusContainer], width) : [],
					editorLines: compositor ? compositor.renderHidden(containers.editorContainer, width) : [],
					footerLines: compositor ? renderHiddenLines(compositor, [containers.widgetContainerBelow], width) : [],
					width,
					maxHeight: Math.max(1, Math.floor(terminalRows) - 1),
				}),
			});
			hideRenderableIfPresent(compositor, containers.statusContainer);
			hideRenderableIfPresent(compositor, containers.widgetContainerAbove);
			compositor.hideRenderable(containers.editorContainer);
			hideRenderableIfPresent(compositor, containers.widgetContainerBelow);
			compositor.install();
			this.compositor = compositor;
			this.installed = true;
			this.failure = undefined;
			if (typeof tui?.requestRender === "function") {
				tui.requestRender(true);
			}
		} catch (error) {
			compositor?.dispose();
			throw error;
		}
	}

	/** 读取并校验 tui.terminal.write。 */
	private getTerminal(tui: any): FixedEditorTerminal {
		const terminal = tui?.terminal as FixedEditorTerminal | undefined;
		if (!terminal || typeof terminal.write !== "function") {
			throw new Error("fixed bottom editor could not find tui.terminal.write()");
		}
		return terminal;
	}

	/** 释放 compositor 引用，保证重复调用安全。 */
	private teardownCompositor(): void {
		const compositor = this.compositor;
		this.compositor = null;
		if (compositor) {
			compositor.dispose();
		}
	}

	/** 恢复默认 editor/footer；清理路径不抛出，失败只记录原因。 */
	private restoreDefaultLayout(): void {
		if (!this.layoutInstalled) return;
		const ui = this.ctx?.ui as RuntimeUI | undefined;
		if (!ui) return;

		try {
			if (typeof ui.setEditorComponent === "function") {
				ui.setEditorComponent(undefined);
			}
		} catch (error) {
			this.failure = formatFailure(error);
		}

		try {
			if (typeof ui.setFooter === "function") {
				ui.setFooter(undefined);
			}
		} catch (error) {
			this.failure = formatFailure(error);
		}
	}

	/** 失败时回滚所有已创建资源，并把状态收敛到 disabled。 */
	private failClosed(reason: string): FixedBottomEditorStatus {
		this.enabled = false;
		this.installed = false;
		this.failure = reason;
		this.teardownCompositor();
		this.restoreDefaultLayout();
		this.layoutInstalled = false;
		this.editorInstance = undefined;
		this.footerComponent = undefined;
		return this.toStatus();
	}

	/** 统一生成对外状态对象。 */
	private toStatus(): FixedBottomEditorStatus {
		return this.failure
			? { enabled: this.enabled, installed: this.installed, failure: this.failure }
			: { enabled: this.enabled, installed: this.installed };
	}
}

/** 创建 Pi 编辑器实例，CustomEditor 不可用时使用 pi-tui Editor 作为最小回退。 */
function createEditor(tui: any, theme: any, keybindings: any): any {
	const CustomEditor = (PiAgent as { CustomEditor?: new (tui: any, theme: any, keybindings: any, options?: any) => any }).CustomEditor;
	const editorTheme = theme ?? FALLBACK_EDITOR_THEME;
	if (typeof CustomEditor === "function") {
		return new CustomEditor(tui, editorTheme, keybindings, { paddingX: 0 });
	}
	return new Editor(tui, editorTheme, { paddingX: 0 });
}

/** 在 TUI 树中查找 editor 及相邻 status/widget 容器，保持与原版 fixed editor 的接管范围一致。 */
function findFixedEditorContainers(tui: any, editor: any): FixedEditorContainers | null {
	if (!editor) return null;

	const directContainer = tui?.editorContainer;
	if (isRenderable(directContainer)) {
		return {
			statusContainer: isRenderable(tui?.statusContainer) ? tui.statusContainer : null,
			widgetContainerAbove: isRenderable(tui?.widgetContainerAbove) ? tui.widgetContainerAbove : null,
			editorContainer: directContainer,
			widgetContainerBelow: isRenderable(tui?.widgetContainerBelow) ? tui.widgetContainerBelow : null,
		};
	}

	const children = Array.isArray(tui?.children) ? tui.children : [];
	for (const [index, child] of children.entries()) {
		if (child === editor && isRenderable(child)) {
			return {
				statusContainer: asRenderable(children[index - 2]),
				widgetContainerAbove: asRenderable(children[index - 1]),
				editorContainer: child,
				widgetContainerBelow: asRenderable(children[index + 1]),
			};
		}
		const nestedChildren = Array.isArray(child?.children) ? child.children : [];
		if (nestedChildren.includes(editor) && isRenderable(child)) {
			return {
				statusContainer: asRenderable(children[index - 2]),
				widgetContainerAbove: asRenderable(children[index - 1]),
				editorContainer: child,
				widgetContainerBelow: asRenderable(children[index + 1]),
			};
		}
	}

	return null;
}

/** 渲染被隐藏的容器；空行保留给 cluster 做最终宽高处理。 */
function renderHiddenLines(compositor: CompositorLike, containers: Array<FixedEditorRenderable | null>, width: number): string[] {
	return containers.flatMap((container) => container ? compositor.renderHidden(container, width) : []);
}

/** 可选容器存在时才隐藏，避免假设所有 Pi 版本都有 widget/status 容器。 */
function hideRenderableIfPresent(compositor: CompositorLike, container: FixedEditorRenderable | null): void {
	if (container) {
		compositor.hideRenderable(container);
	}
}

/** 将未知值窄化为 compositor 可处理的 renderable。 */
function asRenderable(value: unknown): FixedEditorRenderable | null {
	return isRenderable(value) ? value : null;
}

/** 判断对象是否满足 compositor 需要的 render(width) 能力。 */
function isRenderable(value: unknown): value is FixedEditorRenderable {
	return typeof value === "object" && value !== null && typeof (value as FixedEditorRenderable).render === "function";
}

/** 统一格式化未知异常，避免把非 Error 直接暴露给调用方。 */
function formatFailure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
