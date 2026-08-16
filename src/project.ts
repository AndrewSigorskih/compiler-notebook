/**
 * Project resolution — a pure function over a cell list (CLAUDE.md §5, §10).
 *
 * Positional model: a buildspec cell opens a project, following file cells join
 * it, markup cells do not close it, and the next buildspec cell starts the next
 * project.
 */

import { parseBuildSpec, resolveSpec } from './buildspec';
import { fileExtension, languageConfig, isCompilableFilename, isSourceLanguage } from './languages';
import {
	BUILDSPEC_LANGUAGE_ID,
	CellLike,
	CellRole,
	Diagnostic,
	Project,
	ProjectFile,
	ResolveResult
} from './model';

/**
 * The name a cell states outright, before sanitisation.
 *
 * Metadata is the only way to state one. A `// @file x.cpp` directive was
 * supported and removed: it only counted on the very first line, so a leading
 * blank line silently reverted the cell to an auto-name with nothing to explain
 * why. The status bar item names a cell visibly instead.
 */
export function statedFilename(cell: CellLike): string | undefined {
	const explicit = cell.metadata?.['filename'];
	if (typeof explicit === 'string' && explicit.trim().length > 0) {
		return explicit.trim();
	}
	return undefined;
}

export function classifyCell(cell: CellLike): CellRole {
	if (cell.kind === 'markup') {
		return 'markup';
	}
	if (cell.languageId === BUILDSPEC_LANGUAGE_ID) {
		return 'buildspec';
	}
	if (isSourceLanguage(cell.languageId)) {
		return 'file';
	}
	// An asset cell: some other language, but named, so the user clearly wants it
	// in the build dir (a data file, a linker script, a JSON fixture). It is
	// written but never compiled — see `isCompilableFilename`. Naming it is what
	// opts it in, because there is no sensible auto-name for an unknown language.
	return statedFilename(cell) === undefined ? 'other' : 'file';
}

const LOOKS_LIKE_HEADER = /^\s*#\s*pragma\s+once|^\s*#\s*ifndef\s+\w+\s*\n\s*#\s*define\s+\w+/m;

/** Deterministic auto-name for a cell with no explicit filename (CLAUDE.md §6). */
export function autoFilename(cell: CellLike, indexWithinProject: number): string {
	const config = languageConfig(cell.languageId);
	const sourceExt = config?.sourceExtension ?? '.txt';

	// Each language spells its entry point differently, so the pattern comes
	// from the table (`int main`, `fn main`, `pub fn main`).
	if (config?.mainPattern.test(cell.value)) {
		return `main${sourceExt}`;
	}
	if (config?.headerExtension && LOOKS_LIKE_HEADER.test(cell.value)) {
		return `unit_${indexWithinProject}${config.headerExtension}`;
	}
	return `unit_${indexWithinProject}${sourceExt}`;
}

export interface ResolvedName {
	readonly filename: string;
	/** Set when the stated name had to be changed; reported as a diagnostic. */
	readonly problem?: string;
}

/**
 * Constrain a stated filename to a relative path inside the build dir.
 *
 * Sub-directories are allowed (`src/util.cpp`) because multi-file projects
 * sometimes want them, but anything that would escape the build dir is refused:
 * the build dir is the isolation boundary, and writing outside it would touch
 * the user's real filesystem.
 */
export function sanitizeFilename(raw: string): ResolvedName | undefined {
	const normalized = raw.trim().replace(/\\/g, '/');
	const absolute = normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized);
	const segments: string[] = [];
	let escaped = false;

	for (const segment of normalized.split('/')) {
		const trimmed = segment.trim();
		if (trimmed === '' || trimmed === '.') {
			continue;
		}
		if (trimmed === '..') {
			escaped = true;
			continue;
		}
		segments.push(trimmed);
	}

	if (segments.length === 0) {
		return undefined;
	}

	if (absolute || escaped) {
		// Keep only the base name: the intent (this file, this name) survives,
		// the escape does not.
		const filename = segments[segments.length - 1];
		return {
			filename,
			problem: `Filename "${raw.trim()}" would write outside the build directory; using "${filename}" instead.`
		};
	}

	return { filename: segments.join('/') };
}

/** metadata.filename → auto-generated. First hit wins. */
export function resolveFilename(cell: CellLike, indexWithinProject: number): ResolvedName {
	const stated = statedFilename(cell);
	if (stated !== undefined) {
		const sanitized = sanitizeFilename(stated);
		if (sanitized) {
			return sanitized;
		}
		const filename = autoFilename(cell, indexWithinProject);
		return {
			filename,
			problem: `Filename "${stated}" is not usable as a file name; using "${filename}" instead.`
		};
	}
	return { filename: autoFilename(cell, indexWithinProject) };
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
		const { filename: wanted, problem } = resolveFilename(cell, index);
		if (problem) {
			diagnostics.push({ cell, message: problem });
		}
		let filename = wanted;
		if (taken.has(filename)) {
			// Suffix the base name, not the path: `src/main.cpp` → `src/main_2.cpp`.
			// Sliced by length so the original spelling of the extension survives.
			const extLength = fileExtension(wanted).length;
			const stem = extLength > 0 ? wanted.slice(0, -extLength) : wanted;
			const ext = extLength > 0 ? wanted.slice(-extLength) : '';
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

/**
 * The language a project compiles: the first file that is actually a compiler
 * input, falling back to the first file of any kind. Drives compiler/flag
 * defaults, so headers and data files must not get a vote.
 */
function projectLanguage<T extends CellLike>(files: readonly ProjectFile<T>[]): string | undefined {
	const compiled = files.find((file) => isCompilableFilename(file.filename));
	return (compiled ?? files[0])?.cell.languageId;
}

interface OpenProject<T extends CellLike> {
	readonly specCell: T;
	readonly partial: ReturnType<typeof parseBuildSpec>['partial'];
	readonly cells: T[];
}

export function resolveProjects<T extends CellLike>(cells: readonly T[]): ResolveResult<T> {
	const diagnostics: Diagnostic<T>[] = [];
	const projects: Project<T>[] = [];
	let open: OpenProject<T> | undefined;

	const close = (): void => {
		if (!open) {
			return;
		}
		const files = assignFilenames(open.cells, diagnostics);
		projects.push({
			spec: resolveSpec(open.partial, projectLanguage(files)),
			specCell: open.specCell,
			files
		});
		open = undefined;
	};

	for (const cell of cells) {
		switch (classifyCell(cell)) {
			case 'buildspec': {
				close();
				const { partial, warnings } = parseBuildSpec(cell.value);
				for (const warning of warnings) {
					diagnostics.push({ cell, message: warning.message, line: warning.line });
				}
				open = { specCell: cell, partial, cells: [] };
				break;
			}
			case 'file':
				if (open) {
					open.cells.push(cell);
				} else {
					diagnostics.push({
						cell,
						message:
							'This file cell has no buildspec cell above it, so it belongs to no project and will not be built.'
					});
				}
				break;
			default:
				// Markup and unrelated code cells never open or close a project.
				break;
		}
	}

	close();
	return { projects, diagnostics };
}
