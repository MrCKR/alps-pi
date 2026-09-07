export type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens?: number;
	cost?: { total?: number };
};

export type ModelUsageTokens = {
	input: number;
	output: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isAssistantUsage(value: unknown): value is AssistantUsage {
	return isRecord(value)
		&& typeof value.input === "number"
		&& typeof value.output === "number"
		&& typeof value.cacheRead === "number"
		&& typeof value.cacheWrite === "number";
}

export function getUsageTokenTotal(usage: AssistantUsage): number {
	return typeof usage.totalTokens === "number" && usage.totalTokens > 0
		? usage.totalTokens
		: usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Split one provider-normalized model call into prompt and generated tokens. */
export function getModelUsageTokens(usage: AssistantUsage): ModelUsageTokens {
	return {
		input: usage.input + usage.cacheRead + usage.cacheWrite,
		output: usage.output,
	};
}
