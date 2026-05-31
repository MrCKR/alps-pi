/** 功能：处理 OSC133 边界 marker，避免宽度计算和截断破坏终端集成 实现者：alps 实现日期：2026-05-26 */

export type OscExtraction = {
	lines: string[];
	startMarkers: string[];
	endMarkers: string[];
};

export type OscRestoreOptions = {
	startIndex?: number;
	endIndex?: number;
};

const OSC133_PATTERN = /^\x1b\]133;([ABC])\x07/;
const OSC133_ANYWHERE_PATTERN = /\x1b\]133;([ABC])\x07/g;
const OSC133_ALL_CODES = new Set(["A", "B", "C"]);
const OSC133_START_CODES = new Set(["A"]);
const OSC133_END_CODES = new Set(["B", "C"]);

function extractLeadingOsc133Codes(input: string, allowedCodes: ReadonlySet<string>): { markers: string[]; rest: string } {
	const markers: string[] = [];
	let rest = input;
	while (true) {
		const match = OSC133_PATTERN.exec(rest);
		if (!match || !allowedCodes.has(match[1] ?? "")) break;
		markers.push(match[0]);
		rest = rest.slice(match[0].length);
	}
	return { markers, rest };
}

export function extractLeadingOsc133(input: string): { markers: string[]; rest: string } {
	return extractLeadingOsc133Codes(input, OSC133_ALL_CODES);
}

export function extractBoundaryOscMarkers(lines: readonly string[]): OscExtraction {
	try {
		const clean = [...lines];
		const startMarkers: string[] = [];
		const endMarkers: string[] = [];
		if (clean.length > 0) {
			const tailIndex = clean.length - 1;
			const ending = extractLeadingOsc133Codes(clean[tailIndex] ?? "", OSC133_END_CODES);
			endMarkers.push(...ending.markers);
			clean[tailIndex] = ending.rest;
			const leading = extractLeadingOsc133Codes(clean[0] ?? "", OSC133_START_CODES);
			startMarkers.push(...leading.markers);
			clean[0] = leading.rest;
		}
		return { lines: clean, startMarkers, endMarkers };
	} catch {
		return { lines: [...lines], startMarkers: [], endMarkers: [] };
	}
}

function stripOsc133Markers(input: string, target: string[], allowedCodes: ReadonlySet<string>): string {
	return input.replace(OSC133_ANYWHERE_PATTERN, (marker: string, code: string) => {
		if (allowedCodes.has(code)) {
			target.push(marker);
			return "";
		}
		return marker;
	});
}

/** 在边界空白/control-only 区域内提取 OSC133，避免后续裁剪把 marker 一并删掉。 */
export function collectBoundaryOscMarkersFromBlankEdges(extraction: OscExtraction, isBlankBoundaryLine: (line: string) => boolean, isProtectedLine: (line: string) => boolean): OscExtraction {
	try {
		const clean = [...extraction.lines];
		const startMarkers = [...extraction.startMarkers];
		const endMarkers = [...extraction.endMarkers];
		for (let index = 0; index < clean.length; index += 1) {
			const line = clean[index] ?? "";
			if (isProtectedLine(line)) break;
			const stripped = stripOsc133Markers(line, startMarkers, OSC133_START_CODES);
			clean[index] = stripped;
			if (!isBlankBoundaryLine(stripped)) break;
		}
		for (let index = clean.length - 1; index >= 0; index -= 1) {
			const line = clean[index] ?? "";
			if (isProtectedLine(line)) break;
			const lineEndMarkers: string[] = [];
			const stripped = stripOsc133Markers(line, lineEndMarkers, OSC133_END_CODES);
			if (lineEndMarkers.length > 0) endMarkers.unshift(...lineEndMarkers);
			clean[index] = stripped;
			if (!isBlankBoundaryLine(stripped)) break;
		}
		return { lines: clean, startMarkers, endMarkers };
	} catch {
		return extraction;
	}
}

export const stripBoundaryOscMarkers = extractBoundaryOscMarkers;

function clampLineIndex(index: number | undefined, fallback: number, length: number): number {
	if (!Number.isFinite(index)) return fallback;
	return Math.min(Math.max(0, Math.floor(index as number)), Math.max(0, length - 1));
}

export function restoreBoundaryOscMarkers(lines: readonly string[], markers: OscExtraction, options: OscRestoreOptions = {}): string[] {
	if (lines.length === 0) return [];
	const restored = [...lines];
	if (markers.startMarkers.length > 0) {
		const startIndex = clampLineIndex(options.startIndex, 0, restored.length);
		restored[startIndex] = markers.startMarkers.join("") + restored[startIndex];
	}
	if (markers.endMarkers.length > 0) {
		const endIndex = clampLineIndex(options.endIndex, restored.length - 1, restored.length);
		restored[endIndex] = markers.endMarkers.join("") + restored[endIndex];
	}
	return restored;
}
