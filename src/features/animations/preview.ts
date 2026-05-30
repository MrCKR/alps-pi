/** 功能：提供 Animations 设置页内的动画预览组件。 实现者：alps 实现日期：2026-05-30 */

import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { ANIMATIONS, renderAnimationFrame, resolveAnimationWidth, type AnimationDefinition, type AnimationPhase } from "./registry.ts";
import type { AnimationsSettings } from "./settings.ts";
import type { ThemeLike } from "../chrome-frame/styles.ts";

type PreviewThemeLike = Pick<ThemeLike, "fg">;

const PHASES: AnimationPhase[] = ["thinking", "working", "tool"];
const PREVIEW_FPS = 12;

export type AnimationsPreviewOptions = {
	settings: AnimationsSettings;
	theme: PreviewThemeLike;
	onClose: () => void;
	requestRender?: () => void;
};

/** 设置子页内的轻量动画预览；只读 registry，不影响真实 runtime 状态。 */
export class AnimationsPreviewComponent implements Component {
	private readonly settings: AnimationsSettings;
	private readonly theme: PreviewThemeLike;
	private readonly onClose: () => void;
	private readonly requestRender?: () => void;
	private readonly timer: ReturnType<typeof setInterval>;
	private disposed = false;
	private frame = 0;
	private selectedIndex = 0;
	private phaseIndex = 0;

	constructor(options: AnimationsPreviewOptions) {
		this.settings = options.settings;
		this.theme = options.theme;
		this.onClose = options.onClose;
		this.requestRender = options.requestRender;
		this.timer = setInterval(() => {
			if (this.disposed) return;
			this.frame += 1;
			this.requestRender?.();
		}, Math.round(1000 / PREVIEW_FPS));
		this.timer.unref?.();
	}

	/** 关闭预览时释放内部 timer，避免设置页返回后继续空转。 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.timer);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(20, Math.floor(width));
		const animation = this.currentAnimation();
		const phase = PHASES[this.phaseIndex] ?? "thinking";
		const animationWidth = Math.max(1, Math.min(resolveAnimationWidth(this.settings.width, safeWidth), safeWidth - 4));
		const frameLines = renderAnimationFrame(animation.name, this.frame, animationWidth, phase);
		return [
			this.fit(this.accent("Animation Preview"), safeWidth),
			"",
			this.fit(`${this.muted(`[${this.selectedIndex + 1}/${ANIMATIONS.length}]`)} ${this.accent(animation.name)}`, safeWidth),
			this.fit(`category: ${animation.category} · lines: ${animation.lines} · phase: ${phase}`, safeWidth),
			this.fit(this.muted(animation.description), safeWidth),
			"",
			...frameLines.map((line) => this.fit(`  ${line}`, safeWidth)),
			"",
			this.fit(this.muted("↑/↓ switch · Tab phase · Esc/q back"), safeWidth),
		];
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.close();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = (this.selectedIndex - 1 + ANIMATIONS.length) % ANIMATIONS.length;
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedIndex = (this.selectedIndex + 1) % ANIMATIONS.length;
			return;
		}
		if (data === "\t") {
			this.phaseIndex = (this.phaseIndex + 1) % PHASES.length;
		}
	}

	private close(): void {
		this.dispose();
		this.onClose();
	}

	private currentAnimation(): AnimationDefinition {
		return ANIMATIONS[this.selectedIndex] ?? ANIMATIONS[0]!;
	}

	private fit(text: string, width: number): string {
		const clipped = truncateToWidth(text, width, "", false);
		return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	}

	private accent(text: string): string {
		return this.safeFg("accent", text);
	}

	private muted(text: string): string {
		return this.safeFg("dim", text);
	}

	private safeFg(token: string, text: string): string {
		try {
			return this.theme.fg(token, text);
		} catch {
			return text;
		}
	}
}
