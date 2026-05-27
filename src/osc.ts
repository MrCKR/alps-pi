/** 功能：处理 OSC133 边界 marker，避免宽度计算和截断破坏终端集成 实现者：alps 实现日期：2026-05-26 */

export type OscExtraction = {
	lines: string[];
	startMarkers: string[];
	endMarkers: string[];
};

const OSC133_PATTERN = /^\x1b\]133;([ABC])\x07/;

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
	return extractLeadingOsc133Codes(input, new Set(["A", "B", "C"]));
}

export function extractBoundaryOscMarkers(lines: readonly string[]): OscExtraction {
	try {
		const clean = [...lines];
		const startMarkers: string[] = [];
		const endMarkers: string[] = [];
		if (clean.length > 0) {
			const tailIndex = clean.length - 1;
			const ending = extractLeadingOsc133Codes(clean[tailIndex] ?? "", new Set(["B", "C"]));
			endMarkers.push(...ending.markers);
			clean[tailIndex] = ending.rest;
			const leading = extractLeadingOsc133Codes(clean[0] ?? "", new Set(["A"]));
			startMarkers.push(...leading.markers);
			clean[0] = leading.rest;
		}
		return { lines: clean, startMarkers, endMarkers };
	} catch {
		return { lines: [...lines], startMarkers: [], endMarkers: [] };
	}
}

export const stripBoundaryOscMarkers = extractBoundaryOscMarkers;

export function restoreBoundaryOscMarkers(lines: readonly string[], markers: OscExtraction): string[] {
	if (lines.length === 0) return [];
	const restored = [...lines];
	if (markers.startMarkers.length > 0) {
		restored[0] = markers.startMarkers.join("") + restored[0];
	}
	if (markers.endMarkers.length > 0) {
		const last = restored.length - 1;
		restored[last] = markers.endMarkers.join("") + restored[last];
	}
	return restored;
}
