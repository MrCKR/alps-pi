import { addContextContributions, type ContextContribution } from "./contribution.ts";
import type { ChromeKind, ChromeStatus } from "./styles.ts";

export type CollapsedTiming = {
	lastUpdatedAt: number;
	activityOrder?: number;
	active: boolean;
};

export type CollapsedFrameInput = {
	instance: object;
	identity?: string;
	kind: ChromeKind;
	visible: boolean;
	status?: ChromeStatus;
	toolName?: string;
	detail?: string;
	contribution?: ContextContribution;
	signature: string;
	timing?: CollapsedTiming;
};

export type CollapsedCurrentItem = {
	kind: ChromeKind;
	status?: ChromeStatus;
	toolName?: string;
	detail?: string;
};

export type CollapsedGroupSnapshot = {
	isAnchor: boolean;
	count: number;
	failedCount: number;
	current?: CollapsedCurrentItem;
	contribution: ContextContribution;
	elapsedMs?: number;
};

type CollapsedEntryRole = "boundary" | "member" | "ignored";

type CollapsedEntry = CollapsedFrameInput & {
	sequence: number;
	activitySequence: number;
	role: CollapsedEntryRole;
};

const DIALOGUE_KINDS = new Set<ChromeKind>(["user", "assistant", "thinking"]);
const instanceEntries = new WeakMap<object, CollapsedEntry>();
const identityEntries = new Map<string, CollapsedEntry>();
const entries: CollapsedEntry[] = [];
let closedGroupEndTimestamps = new WeakMap<CollapsedEntry, number | null>();
let nextSequence = 1;
let nextActivitySequence = 1;
let activeMode = false;

function roleFor(kind: ChromeKind, visible: boolean): CollapsedEntryRole {
	if (!visible) return "ignored";
	return DIALOGUE_KINDS.has(kind) ? "boundary" : "member";
}

function resetEntries(): void {
	identityEntries.clear();
	entries.length = 0;
	closedGroupEndTimestamps = new WeakMap<CollapsedEntry, number | null>();
	nextSequence = 1;
	nextActivitySequence = 1;
}

export function resetCollapsedRegistry(): void {
	resetEntries();
	activeMode = false;
}

export function synchronizeCollapsedMode(enabled: boolean): void {
	if (enabled === activeMode) return;
	resetEntries();
	activeMode = enabled;
}

function existingEntry(input: CollapsedFrameInput): CollapsedEntry | undefined {
	const byInstance = instanceEntries.get(input.instance);
	if (byInstance && entries.includes(byInstance)) return byInstance;
	if (!input.identity) return undefined;
	return identityEntries.get(input.identity);
}

function updateEntry(entry: CollapsedEntry, input: CollapsedFrameInput): void {
	const changed = entry.signature !== input.signature || entry.role !== roleFor(input.kind, input.visible);
	entry.identity = input.identity;
	entry.kind = input.kind;
	entry.visible = input.visible;
	entry.status = input.status;
	entry.toolName = input.toolName;
	entry.detail = input.detail;
	entry.contribution = input.contribution;
	entry.signature = input.signature;
	entry.timing = input.timing;
	entry.role = roleFor(input.kind, input.visible);
	if (changed) entry.activitySequence = nextActivitySequence++;
	instanceEntries.set(input.instance, entry);
	if (input.identity) identityEntries.set(input.identity, entry);
}

function registerEntry(input: CollapsedFrameInput): CollapsedEntry {
	const existing = existingEntry(input);
	if (existing) {
		updateEntry(existing, input);
		return existing;
	}
	const entry: CollapsedEntry = {
		...input,
		sequence: nextSequence++,
		activitySequence: nextActivitySequence++,
		role: roleFor(input.kind, input.visible),
	};
	entries.push(entry);
	instanceEntries.set(input.instance, entry);
	if (input.identity) identityEntries.set(input.identity, entry);
	return entry;
}

function groupFor(entry: CollapsedEntry): { members: CollapsedEntry[]; previous?: CollapsedEntry; next?: CollapsedEntry } {
	let start = entry.sequence - 1;
	while (start > 0 && entries[start - 1]?.role !== "boundary") start -= 1;
	let end = entry.sequence - 1;
	while (end + 1 < entries.length && entries[end + 1]?.role !== "boundary") end += 1;
	const members = entries.slice(start, end + 1).filter((candidate) => candidate.role === "member");
	const previous = start > 0 ? entries[start - 1] : undefined;
	const next = end + 1 < entries.length ? entries[end + 1] : undefined;
	return { members, previous, next };
}

function effectiveTimestamp(entry: CollapsedEntry, now: number, groupClosed: boolean): number | undefined {
	if (!entry.timing) return undefined;
	return entry.timing.active && !groupClosed ? now : entry.timing.lastUpdatedAt;
}

function freezePrecedingGroup(boundary: CollapsedEntry, now: number): void {
	const previous = entries[entries.indexOf(boundary) - 1];
	if (!previous || previous.role !== "member") return;
	const group = groupFor(previous);
	const anchor = group.members[0];
	if (closedGroupEndTimestamps.has(anchor)) return;
	const timestamps = group.members
		.map((candidate) => effectiveTimestamp(candidate, now, true))
		.filter((timestamp): timestamp is number => timestamp !== undefined);
	closedGroupEndTimestamps.set(anchor, timestamps.length > 0 ? Math.max(...timestamps) : null);
}

export function observeCollapsedFrame(input: CollapsedFrameInput, now = Date.now()): CollapsedGroupSnapshot | undefined {
	if (!activeMode) return undefined;
	const entry = registerEntry(input);
	if (entry.role === "boundary") freezePrecedingGroup(entry, now);
	if (entry.role !== "member") return undefined;
	const group = groupFor(entry);
	const anchor = group.members[0];
	const current = group.members.reduce<CollapsedEntry | undefined>((latest, candidate) => {
		if (!latest) return candidate;
		const candidateUpdatedAt = candidate.timing?.lastUpdatedAt;
		const latestUpdatedAt = latest.timing?.lastUpdatedAt;
		if (candidateUpdatedAt !== undefined || latestUpdatedAt !== undefined) {
			if (candidateUpdatedAt === undefined) return latest;
			if (latestUpdatedAt === undefined) return candidate;
			if (candidateUpdatedAt !== latestUpdatedAt) return candidateUpdatedAt > latestUpdatedAt ? candidate : latest;
			const candidateOrder = candidate.timing?.activityOrder;
			const latestOrder = latest.timing?.activityOrder;
			if (candidateOrder !== undefined || latestOrder !== undefined) {
				if (candidateOrder === undefined) return latest;
				if (latestOrder === undefined) return candidate;
				if (candidateOrder !== latestOrder) return candidateOrder > latestOrder ? candidate : latest;
			}
			return candidate.sequence > latest.sequence ? candidate : latest;
		}
		if (candidate.activitySequence !== latest.activitySequence) {
			return candidate.activitySequence > latest.activitySequence ? candidate : latest;
		}
		return candidate.sequence > latest.sequence ? candidate : latest;
	}, undefined);
	const previousTimestamp = group.previous?.timing?.lastUpdatedAt;
	const groupClosed = group.next?.role === "boundary";
	const endTimestamps = group.members
		.map((candidate) => effectiveTimestamp(candidate, now, groupClosed))
		.filter((timestamp): timestamp is number => timestamp !== undefined);
	const frozenEndTimestamp = closedGroupEndTimestamps.get(anchor);
	const endTimestamp = closedGroupEndTimestamps.has(anchor)
		? frozenEndTimestamp ?? undefined
		: endTimestamps.length > 0 ? Math.max(...endTimestamps) : undefined;
	const contribution = addContextContributions(...group.members.map((candidate) => candidate.contribution));
	return {
		isAnchor: entry === anchor,
		count: group.members.length,
		failedCount: group.members.filter((candidate) => candidate.status === "error").length,
		current: current ? {
			kind: current.kind,
			status: current.status,
			toolName: current.toolName,
			detail: current.detail,
		} : undefined,
		contribution,
		elapsedMs: previousTimestamp === undefined || endTimestamp === undefined ? undefined : Math.max(0, endTimestamp - previousTimestamp),
	};
}
