/**
 * Project resolution — a pure function over a cell list (CLAUDE.md §5, §10).
 *
 * PHASE 1: the whole notebook is a single project built with DEFAULT_SPEC.
 * Buildspec cells are recognised but do not yet open projects; phase 2 replaces
 * the body of `resolveProjects` with the positional model without changing this
 * module's signatures.
 */

import { languageConfig, isSourceLanguage } from './languages';
import {
	BUILDSPEC_LANGUAGE_ID,
	CellLike,
	CellRole,
	DEFAULT_SPEC,
	Diagnostic,
	ProjectFile,
	ResolveResult
} from './model';

export function classifyCell(cell: CellLike): CellRole {
	if (cell.kind === 'markup') {
		return 'markup';
	}
	if (cell.languageId === BUILDSPEC_LANGUAGE_ID) {
		return 'buildspec';
	}
	return isSourceLanguage(cell.languageId) ? 'file' : 'other';
}

/** `// @file matrix.hpp` on the first line (CLAUDE.md §4). */
const FILE_DIRECTIVE = /^\s*(?:\/\/|#|;)\s*@file\s+(\S+)\s*$/;

export function filenameDirective(value: string): string | undefined {
	const firstLine = value.split('\n', 1)[0] ?? '';
	return FILE_DIRECTIVE.exec(firstLine)?.[1];
}

const HAS_MAIN = /\bint\s+main\s*\(/;
const LOOKS_LIKE_HEADER = /^\s*#\s*pragma\s+once|^\s*#\s*ifndef\s+\w+\s*\n\s*#\s*define\s+\w+/m;

/** Deterministic auto-name for a cell with no explicit filename (CLAUDE.md §6). */
export function autoFilename(cell: CellLike, indexWithinProject: number): string {
	const config = languageConfig(cell.languageId);
	const sourceExt = config?.sourceExtension ?? '.txt';

	if (HAS_MAIN.test(cell.value)) {
		return `main${sourceExt}`;
	}
	if (config?.headerExtension && LOOKS_LIKE_HEADER.test(cell.value)) {
		return `unit_${indexWithinProject}${config.headerExtension}`;
	}
	return `unit_${indexWithinProject}${sourceExt}`;
}

/** metadata.filename → `@file` directive → auto-generated. First hit wins. */
export function resolveFilename(cell: CellLike, indexWithinProject: number): string {
	const explicit = cell.metadata?.['filename'];
	if (typeof explicit === 'string' && explicit.trim().length > 0) {
		return explicit.trim();
	}
	return filenameDirective(cell.value) ?? autoFilename(cell, indexWithinProject);
}

/**
 * Assign unique filenames, auto-suffixing collisions so the build still
 * proceeds, and reporting each collision as a diagnostic (CLAUDE.md §6).
 */
function assignFilenames<T extends CellLike>(
	cells: readonly T[],
	diagnostics: Diagnostic<T>[]
): ProjectFile<T>[] {
	const taken = new Set<string>();
	const files: ProjectFile<T>[] = [];

	cells.forEach((cell, index) => {
		const wanted = resolveFilename(cell, index);
		let filename = wanted;
		if (taken.has(filename)) {
			const dot = wanted.lastIndexOf('.');
			const stem = dot > 0 ? wanted.slice(0, dot) : wanted;
			const ext = dot > 0 ? wanted.slice(dot) : '';
			let n = 2;
			while (taken.has(`${stem}_${n}${ext}`)) {
				n++;
			}
			filename = `${stem}_${n}${ext}`;
			diagnostics.push({
				cell,
				message: `Duplicate filename "${wanted}" in this project; using "${filename}" instead.`
			});
		}
		taken.add(filename);
		files.push({ cell, filename });
	});

	return files;
}

export function resolveProjects<T extends CellLike>(cells: readonly T[]): ResolveResult<T> {
	const diagnostics: Diagnostic<T>[] = [];
	const fileCells = cells.filter((cell) => classifyCell(cell) === 'file');

	if (fileCells.length === 0) {
		return { projects: [], diagnostics };
	}

	const files = assignFilenames(fileCells, diagnostics);
	return {
		projects: [{ spec: DEFAULT_SPEC, files }],
		diagnostics
	};
}
