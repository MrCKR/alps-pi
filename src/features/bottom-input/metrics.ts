/** 功能：定义输入框边框指标的独立显示设置与归一化规则。 */

export type InputMetricsSettings = {
	/** 累计输入 Token。 */
	inputTokens: boolean;
	/** 累计输出 Token。 */
	outputTokens: boolean;
	/** 最近一次请求的缓存命中率。 */
	cacheHit: boolean;
	/** 最近一次有效响应的输出速度。 */
	tokenSpeed: boolean;
	/** 当前会话耗时。 */
	elapsedTime: boolean;
};

export const DEFAULT_INPUT_METRICS_SETTINGS: InputMetricsSettings = {
	inputTokens: true,
	outputTokens: true,
	cacheHit: true,
	tokenSpeed: true,
	elapsedTime: true,
};

export function cloneDefaultInputMetricsSettings(): InputMetricsSettings {
	return { ...DEFAULT_INPUT_METRICS_SETTINGS };
}

export function normalizeInputMetricsSettings(
	value: unknown,
	defaults: InputMetricsSettings = DEFAULT_INPUT_METRICS_SETTINGS,
): InputMetricsSettings {
	const raw = isRecord(value) ? value : {};
	return {
		inputTokens: readBoolean(raw, "inputTokens", defaults.inputTokens),
		outputTokens: readBoolean(raw, "outputTokens", defaults.outputTokens),
		cacheHit: readBoolean(raw, "cacheHit", defaults.cacheHit),
		tokenSpeed: readBoolean(raw, "tokenSpeed", defaults.tokenSpeed),
		elapsedTime: readBoolean(raw, "elapsedTime", defaults.elapsedTime),
	};
}

function readBoolean(parent: Record<string, unknown>, key: keyof InputMetricsSettings, fallback: boolean): boolean {
	return typeof parent[key] === "boolean" ? parent[key] : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
