/** 功能：验证输入框指标设置归一化与终端图标选择。 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	ASCII_BOTTOM_INPUT_ICONS,
	NERD_BOTTOM_INPUT_ICONS,
	getBottomInputIcons,
} from "../src/features/bottom-input/icons.ts";
import {
	DEFAULT_INPUT_METRICS_SETTINGS,
	normalizeInputMetricsSettings,
} from "../src/features/bottom-input/metrics.ts";

test("Input Metrics 默认全部开启且只接受布尔覆盖", () => {
	assert.deepEqual(normalizeInputMetricsSettings(undefined), DEFAULT_INPUT_METRICS_SETTINGS);
	assert.deepEqual(normalizeInputMetricsSettings({
		inputTokens: false,
		outputTokens: "false",
		cacheHit: false,
		tokenSpeed: 0,
		elapsedTime: false,
	}), {
		inputTokens: false,
		outputTokens: true,
		cacheHit: false,
		tokenSpeed: true,
		elapsedTime: false,
	});
});

test("Warp 默认使用 Nerd Font 指标图标且显式覆盖优先", () => {
	assert.equal(getBottomInputIcons({ TERM_PROGRAM: "WarpTerminal" } as NodeJS.ProcessEnv), NERD_BOTTOM_INPUT_ICONS);
	assert.equal(getBottomInputIcons({ TERM: "xterm-256color", ALPS_PI_NERD_FONT: "1" } as NodeJS.ProcessEnv), NERD_BOTTOM_INPUT_ICONS);
	assert.equal(getBottomInputIcons({ TERM_PROGRAM: "WarpTerminal", ALPS_PI_NERD_FONT: "0" } as NodeJS.ProcessEnv), ASCII_BOTTOM_INPUT_ICONS);
});
