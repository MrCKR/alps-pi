import type { ChromeKind } from "./styles.js";

export interface ContextContribution {
	upstreamChars: number;
	downstreamChars: number;
}

export interface ContextContributionTokens {
	upstream: number;
	downstream: number;
}

const ESTIMATED_IMAGE_CHARS = 4_800;
const CHARS_PER_TOKEN = 4;

const COMPACTION_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
const BRANCH_SUMMARY_PREFIX = "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
const BRANCH_SUMMARY_SUFFIX = "</summary>";

function safeJsonLength(value: unknown): number {
	try {
		const serialized = JSON.stringify(value);
		return serialized ? serialized.length : 0;
	} catch {
		return 0;
	}
}

function estimateTextAndImageContentChars(content: unknown): number {
	if (!Array.isArray(content)) return typeof content === "string" ? content.length : 0;
	let total = 0;
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		if ((item as any).type === "text" && typeof (item as any).text === "string") total += (item as any).text.length;
		else if ((item as any).type === "image") total += ESTIMATED_IMAGE_CHARS;
	}
	return total;
}

function assistantContent(instance: any): unknown {
	return instance?.lastMessage?.content ?? instance?.message?.content ?? instance?.content;
}

function estimateAssistantChars(instance: any): number {
	const content = assistantContent(instance);
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		if ((item as any).type === "text" && typeof (item as any).text === "string") total += (item as any).text.length;
		else if ((item as any).type === "thinking" && typeof (item as any).thinking === "string") total += (item as any).thinking.length;
	}
	return total;
}

function estimateThinkingChars(instance: any): number {
	const content = assistantContent(instance);
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const item of content) {
		if (!item || typeof item !== "object" || (item as any).type !== "thinking") continue;
		const text = typeof (item as any).thinking === "string"
			? (item as any).thinking
			: typeof (item as any).text === "string" ? (item as any).text : "";
		total += text.length;
	}
	return total;
}

function estimateUserChars(instance: any): number {
	if (typeof instance?.text === "string") return instance.text.length;
	const candidates: string[] = [];
	const seen = new Set<unknown>();
	const visit = (value: unknown, depth: number) => {
		if (depth > 6 || value === null || value === undefined || seen.has(value)) return;
		if (typeof value === "object" || typeof value === "function") seen.add(value);
		if (typeof value === "object" && (value as any)?.constructor?.name === "Markdown" && typeof (value as any).text === "string") {
			candidates.push((value as any).text);
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item, depth + 1);
			return;
		}
		if (typeof value === "object") {
			for (const key of ["children", "child", "content"]) visit((value as any)[key], depth + 1);
		}
	};
	visit(instance?.children, 0);
	return candidates.reduce((sum, text) => sum + text.length, 0);
}

function estimateToolContribution(instance: any): ContextContribution {
	const downstreamChars = String(instance?.toolName ?? "").length + safeJsonLength(instance?.args);
	const upstreamChars = estimateTextAndImageContentChars(instance?.result?.content);
	return { upstreamChars, downstreamChars };
}

function estimateCustomChars(instance: any): number {
	const content = instance?.message?.content ?? instance?.content;
	return estimateTextAndImageContentChars(content);
}

function estimateSkillChars(instance: any): number {
	const skill = instance?.skillBlock;
	if (!skill) return 0;
	const name = String(skill.name ?? "");
	const location = String(skill.location ?? "");
	const content = String(skill.content ?? "");
	return `<skill name="${name}" location="${location}">\n${content}\n</skill>`.length;
}

function estimateSummaryChars(instance: any, prefix: string, suffix: string): number {
	const summary = instance?.message?.summary ?? instance?.summary;
	return typeof summary === "string" ? prefix.length + summary.length + suffix.length : 0;
}

function bashExecutionToText(instance: any): string {
	const message = instance?.message ?? instance;
	const command = String(message?.command ?? instance?.command ?? "");
	const output = typeof message?.output === "string"
		? message.output
		: Array.isArray(instance?.outputLines)
			? instance.outputLines.join("\n")
			: typeof instance?.getOutput === "function"
				? String(instance.getOutput() ?? "")
				: "";
	let text = `Ran \`${command}\`\n`;
	text += output ? `\`\`\`\n${output}\n\`\`\`` : "(no output)";
	if (message?.cancelled === true || instance?.status === "cancelled") text += "\n(command cancelled)";
	const exitCode = message?.exitCode ?? instance?.exitCode;
	if (typeof exitCode === "number" && exitCode !== 0) text += `\nCommand exited with code ${exitCode}`;
	const truncated = message?.truncated === true || Boolean(instance?.truncationResult);
	const fullOutputPath = message?.fullOutputPath ?? instance?.fullOutputPath;
	if (truncated && fullOutputPath) text += `\n(output truncated; full output in ${String(fullOutputPath)})`;
	return text;
}

function isExcludedBash(instance: any): boolean {
	return instance?.excludeFromContext === true || instance?.message?.excludeFromContext === true;
}

function upstream(upstreamChars: number): ContextContribution {
	return { upstreamChars, downstreamChars: 0 };
}

function downstream(downstreamChars: number): ContextContribution {
	return { upstreamChars: 0, downstreamChars };
}

export function addContextContributions(...values: Array<ContextContribution | undefined>): ContextContribution {
	let upstreamChars = 0;
	let downstreamChars = 0;
	for (const value of values) {
		if (!value) continue;
		upstreamChars += value.upstreamChars;
		downstreamChars += value.downstreamChars;
	}
	return { upstreamChars, downstreamChars };
}

export function contextContributionTokens(value: ContextContribution): ContextContributionTokens {
	return {
		upstream: Math.ceil(value.upstreamChars / CHARS_PER_TOKEN),
		downstream: Math.ceil(value.downstreamChars / CHARS_PER_TOKEN),
	};
}

export function contextContributionTotalTokens(value: ContextContribution): number {
	return Math.ceil((value.upstreamChars + value.downstreamChars) / CHARS_PER_TOKEN);
}

export function estimateContextContribution(kind: ChromeKind, instance: any): ContextContribution | undefined {
	switch (kind) {
		case "user":
			return upstream(estimateUserChars(instance));
		case "assistant":
			return downstream(estimateAssistantChars(instance));
		case "thinking":
			return downstream(estimateThinkingChars(instance));
		case "tool":
		case "toolPending":
		case "toolSuccess":
		case "toolError":
			return estimateToolContribution(instance);
		case "custom":
			return upstream(estimateCustomChars(instance));
		case "skill":
			return upstream(estimateSkillChars(instance));
		case "compaction":
			return upstream(estimateSummaryChars(instance, COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX));
		case "branch":
			return upstream(estimateSummaryChars(instance, BRANCH_SUMMARY_PREFIX, BRANCH_SUMMARY_SUFFIX));
		case "bash":
			return isExcludedBash(instance) ? undefined : upstream(bashExecutionToText(instance).length);
		case "working":
		default:
			return undefined;
	}
}
