/**
 * The `.cnb` on-disk format (CLAUDE.md §7), free of `vscode` so it can be
 * round-trip tested.
 *
 * JSON, because we never persist outputs — there is no base64 image problem to
 * solve here — but cell text is stored as an **array of lines** rather than one
 * escaped string. As a single string, editing one line of a cell shows up in
 * `git diff` as the whole cell on one line, and two people editing different
 * functions in the same cell always conflict. Split per line, diffs and merges
 * work the way they do for source files.
 *
 * Lines keep their trailing `\n`, so joining them is exact: no guessing about
 * whether the last line ended with a newline (the same trick `.ipynb` uses).
 */

/** Bumped when the written shape changes. Reading stays tolerant of anything. */
export const FORMAT_VERSION = 2;

export interface CnbCell {
	readonly kind: 'markup' | 'code';
	readonly language: string;
	readonly value: string;
	readonly metadata?: Record<string, unknown>;
}

export interface CnbParse {
	readonly cells: readonly CnbCell[];
	/** Set when the file could not be read; the caller shows the raw bytes. */
	readonly error?: string;
}

/** Split into lines that each keep their trailing newline. Exact inverse of join. */
export function splitLines(value: string): string[] {
	const lines: string[] = [];
	let start = 0;
	for (let i = 0; i < value.length; i++) {
		if (value[i] === '\n') {
			lines.push(value.slice(start, i + 1));
			start = i + 1;
		}
	}
	if (start < value.length) {
		lines.push(value.slice(start));
	}
	return lines;
}

/**
 * Accepts either shape: an array of lines (current) or a single string (files
 * written before line arrays existed, and hand-edited files).
 */
export function joinLines(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((line) => (typeof line === 'string' ? line : String(line))).join('');
	}
	return '';
}

function readCell(raw: unknown): CnbCell {
	const cell = (raw ?? {}) as Record<string, unknown>;
	const result: {
		kind: 'markup' | 'code';
		language: string;
		value: string;
		metadata?: Record<string, unknown>;
	} = {
		kind: cell['kind'] === 'markup' ? 'markup' : 'code',
		language: typeof cell['language'] === 'string' ? cell['language'] : 'plaintext',
		value: joinLines(cell['value'])
	};

	const metadata = cell['metadata'];
	if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
		result.metadata = metadata as Record<string, unknown>;
	}
	return result;
}

export function parseCnb(text: string): CnbParse {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return { cells: [] };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(trimmed);
	} catch (err) {
		return { cells: [], error: err instanceof Error ? err.message : String(err) };
	}

	const cells = (raw as { cells?: unknown })?.cells;
	if (!Array.isArray(cells)) {
		return { cells: [], error: 'no "cells" array in this notebook' };
	}
	return { cells: cells.map(readCell) };
}

export function stringifyCnb(cells: readonly CnbCell[]): string {
	const raw = {
		version: FORMAT_VERSION,
		cells: cells.map((cell) => {
			const out: Record<string, unknown> = {
				kind: cell.kind,
				language: cell.language,
				value: splitLines(cell.value)
			};
			if (cell.metadata && Object.keys(cell.metadata).length > 0) {
				out['metadata'] = cell.metadata;
			}
			return out;
		})
	};

	return JSON.stringify(raw, null, 2) + '\n';
}
