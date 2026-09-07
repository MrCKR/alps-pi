import type { ContextContribution } from "./contribution.ts";
import type { ChromeKind, ChromeStatus } from "./styles.ts";

export type CollapsedTiming = {
	lastUpdatedAt: number;
	activityOrder?: number;
	active: boolean;
};

export type CollapsedGroupKind = "tools" | "thinking";

export type CollapsedFrameInput = {
	instance: object;
	identity?: string;
	kind: ChromeKind;
	visible: boolean;
	/** 内容可以作为分组边界，但只有实际包框时才进入 frame-to-frame 计时链。 */
	framed?: boolean;
	status?: ChromeStatus;
	toolName?: string;
	displayName?: string;
	detail?: string;
	contentLines?: readonly string[];
	contribution?: ContextContribution;
	signature: string;
	timing?: CollapsedTiming;
};

export type CollapsedToolItemSnapshot = {
	kind: ChromeKind;
	status?: ChromeStatus;
	name: string;
	detail?: string;
};

export type CollapsedGroupSnapshot = {
	isAnchor: boolean;
	kind: CollapsedGroupKind;
	count: number;
	failedCount: number;
	active: boolean;
	status?: ChromeStatus;
	items?: CollapsedToolItemSnapshot[];
	contentLines?: string[];
	contribution: ContextContribution;
	elapsedMs?: number;
};

export type CollapsedRegistryStats = {
	observations: number;
	appendedEntries: number;
	entryUpdates: number;
	structuralRebuilds: number;
	rebuiltEntries: number;
	snapshotReads: number;
	aggregateItemsRead: number;
	heapPushes: number;
	heapPops: number;
	renderRequests: number;
};

type CollapsedEntryRole = "boundary" | "member" | "ignored";

type CollapsedEntry = CollapsedFrameInput & {
	sequence: number;
	activitySequence: number;
	role: CollapsedEntryRole;
	generation: number;
	version: number;
	group?: CollapsedGroup;
	previousFrame?: CollapsedEntry;
	previousGroup?: CollapsedGroup;
	nextGroup?: CollapsedGroup;
};

type HeapNode = {
	entry: CollapsedEntry;
	version: number;
};

type CollapsedGroup = {
	kind: CollapsedGroupKind;
	anchor: CollapsedEntry;
	members: CollapsedEntry[];
	previous?: CollapsedEntry;
	next?: CollapsedEntry;
	count: number;
	pendingCount: number;
	successCount: number;
	failedCount: number;
	upstreamChars: number;
	downstreamChars: number;
	activeCount: number;
	cachedToolItems?: CollapsedToolItemSnapshot[];
	cachedToolItemsVersion: number;
	cachedThinkingLines?: string[];
	cachedThinkingLinesVersion: number;
	timestampHeap: HeapNode[];
	version: number;
	anchorRenderedVersion: number;
	endFrozen: boolean;
	frozenEndTimestamp?: number;
};

const BOUNDARY_KINDS = new Set<ChromeKind>(["user", "assistant"]);
const instanceEntries = new WeakMap<object, CollapsedEntry>();
const identityEntries = new Map<string, CollapsedEntry>();
const entries: CollapsedEntry[] = [];
const groups: CollapsedGroup[] = [];
const pendingGroups = new Set<CollapsedGroup>();
let nextSequence = 1;
let nextActivitySequence = 1;
let registryGeneration = 1;
let activeMode = false;
let openGroup: CollapsedGroup | undefined;
let lastFrame: CollapsedEntry | undefined;
let renderRequest: (() => void) | undefined;
let renderRequestQueued = false;
let stats = createStats();

function createStats(): CollapsedRegistryStats {
	return {
		observations: 0,
		appendedEntries: 0,
		entryUpdates: 0,
		structuralRebuilds: 0,
		rebuiltEntries: 0,
		snapshotReads: 0,
		aggregateItemsRead: 0,
		heapPushes: 0,
		heapPops: 0,
		renderRequests: 0,
	};
}

function roleFor(kind: ChromeKind, visible: boolean): CollapsedEntryRole {
	if (!visible) return "ignored";
	return BOUNDARY_KINDS.has(kind) ? "boundary" : "member";
}

function groupKindFor(kind: ChromeKind): CollapsedGroupKind {
	return kind === "thinking" ? "thinking" : "tools";
}

function resetEntries(): void {
	identityEntries.clear();
	entries.length = 0;
	groups.length = 0;
	pendingGroups.clear();
	nextSequence = 1;
	nextActivitySequence = 1;
	registryGeneration += 1;
	openGroup = undefined;
	lastFrame = undefined;
	renderRequestQueued = false;
	stats = createStats();
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

export function configureCollapsedRenderRequest(request: (() => void) | undefined): void {
	renderRequest = request;
}

export function getCollapsedRegistryStats(): CollapsedRegistryStats {
	return { ...stats };
}

function queueRenderIfNeeded(group: CollapsedGroup): void {
	if (group.anchorRenderedVersion >= group.version) {
		pendingGroups.delete(group);
		return;
	}
	pendingGroups.add(group);
	if (!renderRequest || renderRequestQueued) return;
	renderRequestQueued = true;
	const generation = registryGeneration;
	queueMicrotask(() => {
		if (generation !== registryGeneration) return;
		renderRequestQueued = false;
		for (const candidate of pendingGroups) {
			if (candidate.anchorRenderedVersion >= candidate.version) pendingGroups.delete(candidate);
		}
		if (!activeMode || pendingGroups.size === 0 || !renderRequest) return;
		stats.renderRequests += 1;
		renderRequest();
	});
}

function compareTimestamp(left: CollapsedEntry, right: CollapsedEntry): number {
	return (left.timing?.lastUpdatedAt ?? Number.NEGATIVE_INFINITY) - (right.timing?.lastUpdatedAt ?? Number.NEGATIVE_INFINITY);
}

function heapPush(heap: HeapNode[], node: HeapNode, compare: (left: CollapsedEntry, right: CollapsedEntry) => number): void {
	stats.heapPushes += 1;
	heap.push(node);
	let index = heap.length - 1;
	while (index > 0) {
		const parent = Math.floor((index - 1) / 2);
		if (compare(heap[parent]!.entry, node.entry) >= 0) break;
		heap[index] = heap[parent]!;
		index = parent;
	}
	heap[index] = node;
}

function heapPop(heap: HeapNode[], compare: (left: CollapsedEntry, right: CollapsedEntry) => number): void {
	stats.heapPops += 1;
	const tail = heap.pop();
	if (!tail || heap.length === 0) return;
	let index = 0;
	while (true) {
		const left = index * 2 + 1;
		if (left >= heap.length) break;
		const right = left + 1;
		const child = right < heap.length && compare(heap[right]!.entry, heap[left]!.entry) > 0 ? right : left;
		if (compare(heap[child]!.entry, tail.entry) <= 0) break;
		heap[index] = heap[child]!;
		index = child;
	}
	heap[index] = tail;
}

function heapEntry(
	group: CollapsedGroup,
	heap: HeapNode[],
	compare: (left: CollapsedEntry, right: CollapsedEntry) => number,
): CollapsedEntry | undefined {
	while (heap.length > 0) {
		const node = heap[0]!;
		if (node.version === node.entry.version && node.entry.group === group && node.entry.role === "member") return node.entry;
		heapPop(heap, compare);
	}
	return undefined;
}

function contributionOf(entry: CollapsedEntry): ContextContribution {
	return entry.contribution ?? { upstreamChars: 0, downstreamChars: 0 };
}

function addMember(group: CollapsedGroup, entry: CollapsedEntry): void {
	entry.group = group;
	group.members.push(entry);
	group.count += 1;
	if (entry.status === "pending") group.pendingCount += 1;
	if (entry.status === "success") group.successCount += 1;
	if (entry.status === "error") group.failedCount += 1;
	const contribution = contributionOf(entry);
	group.upstreamChars += contribution.upstreamChars;
	group.downstreamChars += contribution.downstreamChars;
	if (entry.timing?.active) group.activeCount += 1;
	const node = { entry, version: entry.version };
	heapPush(group.timestampHeap, node, compareTimestamp);
	group.version += 1;
}

function replaceMemberValues(group: CollapsedGroup, entry: CollapsedEntry, update: () => void): void {
	const previousContribution = contributionOf(entry);
	group.upstreamChars -= previousContribution.upstreamChars;
	group.downstreamChars -= previousContribution.downstreamChars;
	if (entry.status === "pending") group.pendingCount -= 1;
	if (entry.status === "success") group.successCount -= 1;
	if (entry.status === "error") group.failedCount -= 1;
	if (entry.timing?.active) group.activeCount -= 1;
	update();
	const contribution = contributionOf(entry);
	group.upstreamChars += contribution.upstreamChars;
	group.downstreamChars += contribution.downstreamChars;
	if (entry.status === "pending") group.pendingCount += 1;
	if (entry.status === "success") group.successCount += 1;
	if (entry.status === "error") group.failedCount += 1;
	if (entry.timing?.active) group.activeCount += 1;
	const node = { entry, version: entry.version };
	heapPush(group.timestampHeap, node, compareTimestamp);
	group.version += 1;
}

function createGroup(anchor: CollapsedEntry, previous?: CollapsedEntry): CollapsedGroup {
	const group: CollapsedGroup = {
		kind: groupKindFor(anchor.kind),
		anchor,
		members: [],
		previous,
		count: 0,
		pendingCount: 0,
		successCount: 0,
		failedCount: 0,
		upstreamChars: 0,
		downstreamChars: 0,
		activeCount: 0,
		cachedToolItemsVersion: -1,
		cachedThinkingLinesVersion: -1,
		timestampHeap: [],
		version: 0,
		anchorRenderedVersion: 0,
		endFrozen: false,
	};
	groups.push(group);
	if (previous) previous.nextGroup = group;
	return group;
}

function latestTimestamp(group: CollapsedGroup): number | undefined {
	return heapEntry(group, group.timestampHeap, compareTimestamp)?.timing?.lastUpdatedAt;
}

function closeGroup(group: CollapsedGroup, boundary: CollapsedEntry): CollapsedEntry {
	group.next = boundary;
	boundary.previousGroup = group;
	group.endFrozen = true;
	group.frozenEndTimestamp = latestTimestamp(group);
	group.version += 1;
	queueRenderIfNeeded(group);
	return heapEntry(group, group.timestampHeap, compareTimestamp) ?? group.anchor;
}

function appendEntry(entry: CollapsedEntry): void {
	entries.push(entry);
	stats.appendedEntries += 1;
	if (entry.role === "ignored") return;
	if (entry.role === "boundary") {
		if (openGroup) lastFrame = closeGroup(openGroup, entry);
		openGroup = undefined;
		entry.previousFrame = lastFrame;
		if (entry.framed !== false) lastFrame = entry;
		return;
	}
	if (openGroup && openGroup.kind !== groupKindFor(entry.kind)) {
		lastFrame = closeGroup(openGroup, entry);
		openGroup = undefined;
	}
	if (!openGroup) openGroup = createGroup(entry, lastFrame);
	addMember(openGroup, entry);
}

function rebuildGroups(): void {
	stats.structuralRebuilds += 1;
	groups.length = 0;
	pendingGroups.clear();
	openGroup = undefined;
	lastFrame = undefined;
	for (const entry of entries) {
		stats.rebuiltEntries += 1;
		entry.group = undefined;
		entry.previousFrame = undefined;
		entry.previousGroup = undefined;
		entry.nextGroup = undefined;
		if (entry.role === "ignored") continue;
		if (entry.role === "boundary") {
			if (openGroup) lastFrame = closeGroup(openGroup, entry);
			openGroup = undefined;
			entry.previousFrame = lastFrame;
			if (entry.framed !== false) lastFrame = entry;
			continue;
		}
		if (openGroup && openGroup.kind !== groupKindFor(entry.kind)) {
			lastFrame = closeGroup(openGroup, entry);
			openGroup = undefined;
		}
		if (!openGroup) openGroup = createGroup(entry, lastFrame);
		addMember(openGroup, entry);
	}
	for (const group of groups) queueRenderIfNeeded(group);
}

function existingEntry(input: CollapsedFrameInput): CollapsedEntry | undefined {
	const byInstance = instanceEntries.get(input.instance);
	if (byInstance?.generation === registryGeneration) return byInstance;
	if (!input.identity) return undefined;
	const byIdentity = identityEntries.get(input.identity);
	return byIdentity?.generation === registryGeneration ? byIdentity : undefined;
}

function sameContribution(left: ContextContribution | undefined, right: ContextContribution | undefined): boolean {
	return left?.upstreamChars === right?.upstreamChars && left?.downstreamChars === right?.downstreamChars;
}

function sameTiming(left: CollapsedTiming | undefined, right: CollapsedTiming | undefined): boolean {
	return left?.lastUpdatedAt === right?.lastUpdatedAt && left?.activityOrder === right?.activityOrder && left?.active === right?.active;
}

function sameLines(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
	if (left === right) return true;
	if (!left || !right || left.length !== right.length) return false;
	return left.every((line, index) => line === right[index]);
}

function entryDataChanged(entry: CollapsedEntry, input: CollapsedFrameInput): boolean {
	return entry.kind !== input.kind
		|| entry.visible !== input.visible
		|| entry.framed !== input.framed
		|| entry.status !== input.status
		|| entry.toolName !== input.toolName
		|| entry.displayName !== input.displayName
		|| entry.detail !== input.detail
		|| !sameLines(entry.contentLines, input.contentLines)
		|| entry.signature !== input.signature
		|| !sameContribution(entry.contribution, input.contribution)
		|| !sameTiming(entry.timing, input.timing);
}

function assignInput(entry: CollapsedEntry, input: CollapsedFrameInput, role: CollapsedEntryRole, changed: boolean): void {
	const previousIdentity = entry.identity;
	if (changed) {
		entry.version += 1;
		entry.activitySequence = nextActivitySequence++;
	}
	entry.identity = input.identity;
	entry.kind = input.kind;
	entry.visible = input.visible;
	entry.framed = input.framed;
	entry.status = input.status;
	entry.toolName = input.toolName;
	entry.displayName = input.displayName;
	entry.detail = input.detail;
	entry.contentLines = input.contentLines ? [...input.contentLines] : undefined;
	entry.contribution = input.contribution;
	entry.signature = input.signature;
	entry.timing = input.timing;
	entry.role = role;
	instanceEntries.set(input.instance, entry);
	if (previousIdentity && previousIdentity !== input.identity && identityEntries.get(previousIdentity) === entry) {
		identityEntries.delete(previousIdentity);
	}
	if (input.identity) identityEntries.set(input.identity, entry);
}

function updateEntry(entry: CollapsedEntry, input: CollapsedFrameInput): void {
	const nextRole = roleFor(input.kind, input.visible);
	const structuralChange = entry.role !== nextRole
		|| entry.framed !== input.framed
		|| (entry.role === "member" && nextRole === "member"
			&& groupKindFor(entry.kind) !== groupKindFor(input.kind));
	const changed = structuralChange || entryDataChanged(entry, input);
	if (!changed) {
		instanceEntries.set(input.instance, entry);
		return;
	}
	stats.entryUpdates += 1;
	if (!structuralChange && entry.role === "member" && entry.group) {
		const group = entry.group;
		replaceMemberValues(group, entry, () => assignInput(entry, input, nextRole, true));
		return;
	}
	assignInput(entry, input, nextRole, true);
	if (structuralChange) {
		rebuildGroups();
		return;
	}
	if (entry.role === "boundary" && entry.nextGroup) {
		entry.nextGroup.version += 1;
		queueRenderIfNeeded(entry.nextGroup);
	}
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
		generation: registryGeneration,
		version: 1,
	};
	instanceEntries.set(input.instance, entry);
	if (input.identity) identityEntries.set(input.identity, entry);
	appendEntry(entry);
	return entry;
}

function thinkingContentLines(group: CollapsedGroup): string[] | undefined {
	if (group.kind !== "thinking") return undefined;
	if (group.cachedThinkingLinesVersion === group.version) return group.cachedThinkingLines;
	stats.aggregateItemsRead += group.members.length;
	group.cachedThinkingLines = group.members.flatMap((member) => member.contentLines ?? []);
	group.cachedThinkingLinesVersion = group.version;
	return group.cachedThinkingLines;
}

function statusFromCounts(pendingCount: number, successCount: number, failedCount: number): ChromeStatus | undefined {
	if (pendingCount > 0) return "pending";
	if (failedCount > 0) return "error";
	return successCount > 0 ? "success" : undefined;
}

function toolItemSnapshots(group: CollapsedGroup): CollapsedToolItemSnapshot[] | undefined {
	if (group.kind !== "tools") return undefined;
	if (group.cachedToolItemsVersion === group.version) return group.cachedToolItems;
	stats.aggregateItemsRead += group.members.length;
	group.cachedToolItems = group.members.map((member) => ({
		kind: member.kind,
		status: member.status,
		name: member.displayName ?? "Tool",
		detail: member.detail,
	}));
	group.cachedToolItemsVersion = group.version;
	return group.cachedToolItems;
}

function snapshotFor(entry: CollapsedEntry, group: CollapsedGroup, now: number): CollapsedGroupSnapshot {
	stats.snapshotReads += 1;
	const isAnchor = entry === group.anchor;
	const previousTimestamp = group.previous?.timing?.lastUpdatedAt;
	const latest = latestTimestamp(group);
	const endTimestamp = group.endFrozen
		? group.frozenEndTimestamp
		: group.activeCount > 0
			? Math.max(now, latest ?? now)
			: latest;
	return {
		isAnchor,
		kind: group.kind,
		count: group.count,
		failedCount: group.failedCount,
		active: group.activeCount > 0 || group.pendingCount > 0,
		status: statusFromCounts(group.pendingCount, group.successCount, group.failedCount),
		items: isAnchor ? toolItemSnapshots(group) : undefined,
		contentLines: isAnchor ? thinkingContentLines(group) : undefined,
		contribution: {
			upstreamChars: group.upstreamChars,
			downstreamChars: group.downstreamChars,
		},
		elapsedMs: previousTimestamp === undefined || endTimestamp === undefined
			? undefined
			: Math.max(0, endTimestamp - previousTimestamp),
	};
}

export function observeCollapsedFrame(input: CollapsedFrameInput, now = Date.now()): CollapsedGroupSnapshot | undefined {
	if (!activeMode) return undefined;
	stats.observations += 1;
	const entry = registerEntry(input);
	if (entry.role !== "member" || !entry.group) return undefined;
	const group = entry.group;
	const snapshot = snapshotFor(entry, group, now);
	if (snapshot.isAnchor) {
		group.anchorRenderedVersion = group.version;
		pendingGroups.delete(group);
	} else {
		queueRenderIfNeeded(group);
	}
	return snapshot;
}

/** 可见 boundary 的耗时从前一个实际包框 frame（含聚合组）最后更新时间起算。 */
export function getCollapsedBoundaryElapsed(input: CollapsedFrameInput, now = Date.now()): number | undefined {
	if (!activeMode || input.framed === false) return undefined;
	const entry = existingEntry(input);
	if (!entry || entry.role !== "boundary") return undefined;
	const previousTimestamp = entry.previousGroup?.frozenEndTimestamp ?? entry.previousFrame?.timing?.lastUpdatedAt;
	const currentTimestamp = input.timing?.active ? now : input.timing?.lastUpdatedAt;
	return previousTimestamp === undefined || currentTimestamp === undefined
		? undefined
		: Math.max(0, currentTimestamp - previousTimestamp);
}
