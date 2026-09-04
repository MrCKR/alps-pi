import assert from "node:assert/strict";
import test from "node:test";
import {
	addContextContributions,
	contextContributionTokens,
	contextContributionTotalTokens,
	estimateContextContribution,
} from "../src/features/chrome-frame/contribution.ts";

const imageChars = 4_800;

function textImageChars(content: Array<Record<string, unknown>>): number {
	return content.reduce((total, item) => {
		if (item.type === "text") return total + String(item.text ?? "").length;
		if (item.type === "image") return total + imageChars;
		return total;
	}, 0);
}

test("attributes user input upstream and assistant output downstream", () => {
	assert.deepEqual(estimateContextContribution("user", { text: "question" }), {
		upstreamChars: 8,
		downstreamChars: 0,
	});
	assert.deepEqual(
		estimateContextContribution("assistant", {
			lastMessage: {
				content: [
					{ type: "thinking", thinking: "plan" },
					{ type: "text", text: "answer" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "ignored here" } },
				],
			},
		}),
		{ upstreamChars: 0, downstreamChars: 10 },
	);
});

test("splits tool call metadata downstream and result content upstream", () => {
	const args = { path: "src/a.ts", line: 12 };
	const resultContent = [
		{ type: "text", text: "file contents" },
		{ type: "image", data: "rendered-only-payload" },
	];
	assert.deepEqual(
		estimateContextContribution("tool", {
			toolName: "read",
			args,
			result: { content: resultContent, details: { excluded: "metadata" }, isError: false },
		}),
		{
			upstreamChars: textImageChars(resultContent),
			downstreamChars: "read".length + JSON.stringify(args).length,
		},
	);
});

test("ordinary tool totals count retained call and result content once", () => {
	const args = { path: "src/a.ts" };
	const resultText = "retained result";
	const contribution = estimateContextContribution("tool", {
		toolName: "read",
		args,
		result: { content: [{ type: "text", text: resultText }], isError: false },
	});
	assert.ok(contribution);

	const retainedChars = "read".length + JSON.stringify(args).length + resultText.length;
	assert.equal(contextContributionTotalTokens(contribution), Math.ceil(retainedChars / 4));
});

test("ordinary totals ignore tool presentation state", () => {
	const retained = {
		toolName: "read",
		args: { path: "src/a.ts" },
		result: {
			content: [
				{ type: "text", text: "retained result" },
				{ type: "image", data: "source-payload" },
			],
			isError: false,
		},
	};
	const expected = estimateContextContribution("tool", retained);

	assert.deepEqual(
		estimateContextContribution("tool", {
			...retained,
			expanded: true,
			width: 24,
			maxVisibleLines: 1,
			truncateOutput: true,
			showImages: false,
			cachedSummary: "short UI summary",
			visibleText: "ret...",
		}),
		expected,
	);
});

test("counts custom content and reconstructed skill prefix upstream", () => {
	assert.deepEqual(
		estimateContextContribution("custom", {
			message: { content: [{ type: "text", text: "note" }, { type: "image", data: "payload" }] },
		}),
		{ upstreamChars: 4 + imageChars, downstreamChars: 0 },
	);

	const skillBlock = { name: "research", location: "skills/research/SKILL.md", content: "Use primary sources.", userMessage: "separate user frame" };
	const retained = `<skill name="${skillBlock.name}" location="${skillBlock.location}">\n${skillBlock.content}\n</skill>`;
	assert.deepEqual(estimateContextContribution("skill", { skillBlock }), {
		upstreamChars: retained.length,
		downstreamChars: 0,
	});
});

test("counts exact branch and compaction wrapper strings upstream", () => {
	const compactionSummary = "earlier work";
	const branchSummary = "alternate work";
	const compaction = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${compactionSummary}\n</summary>`;
	const branch = `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${branchSummary}</summary>`;

	assert.deepEqual(estimateContextContribution("compaction", { message: { summary: compactionSummary } }), {
		upstreamChars: compaction.length,
		downstreamChars: 0,
	});
	assert.deepEqual(estimateContextContribution("branch", { message: { summary: branchSummary } }), {
		upstreamChars: branch.length,
		downstreamChars: 0,
	});
});

test("counts retained Bash conversion and excludes explicit non-context Bash", () => {
	const retained = "Ran `npm test`\n```\nall passed\n```";
	assert.deepEqual(
		estimateContextContribution("bash", {
			command: "npm test",
			outputLines: ["all passed"],
			status: "complete",
			exitCode: 0,
		}),
		{ upstreamChars: retained.length, downstreamChars: 0 },
	);
	assert.equal(
		estimateContextContribution("bash", {
			command: "cat secret",
			outputLines: ["hidden"],
			excludeFromContext: true,
		}),
		undefined,
	);
});

test("preserves Bash cancellation, exit, and truncation context text", () => {
	const contribution = estimateContextContribution("bash", {
		command: "npm test",
		outputLines: ["failure"],
		status: "cancelled",
		exitCode: 2,
		truncationResult: { truncated: true },
		fullOutputPath: "C:/tmp/full.log",
	});
	const retained = [
		"Ran `npm test`",
		"```\nfailure\n```",
		"(command cancelled)",
		"Command exited with code 2",
		"(output truncated; full output in C:/tmp/full.log)",
	].join("\n");
	assert.deepEqual(contribution, { upstreamChars: retained.length, downstreamChars: 0 });
});

test("aggregates raw characters before directional token rounding", () => {
	const combined = addContextContributions(
		{ upstreamChars: 1, downstreamChars: 2 },
		{ upstreamChars: 2, downstreamChars: 3 },
	);
	assert.deepEqual(combined, { upstreamChars: 3, downstreamChars: 5 });
	assert.deepEqual(contextContributionTokens(combined), { upstream: 1, downstream: 2 });
	assert.equal(contextContributionTotalTokens(combined), 2);
});

test("returns no contribution for UI-only working frames", () => {
	assert.equal(estimateContextContribution("working", { text: "Working..." }), undefined);
});
