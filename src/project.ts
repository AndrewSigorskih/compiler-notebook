/**
 * Project resolution — a pure function over a cell list (CLAUDE.md §5, §10).
 *
 * Positional model: a buildspec cell opens a project, following file cells join
 * it, markup cells do not close it, and the next buildspec cell starts the next
 * project.
 */

import { parseBuildSpec, resolveSpec } from './buildspec';
import { languageConfig, isHeaderFilename, isSourceLanguage } from './languages';
import {
	BUILDSPEC_LANGUAGE_ID,
	CellLike,
	CellRole,
	Diagnostic,
	Project,
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

/**
 * The language a project compiles: the first source cell that is not a header,
 * falling back to the first cell of any kind. Drives the compiler/flag defaults.
 */
function projectLanguage<T extends CellLike>(files: readonly ProjectFile<T>[]): string | undefined {
	const compiled = files.find((file) => !isHeaderFilename(file.filename));
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
				for (const message of warnings) {
					diagnostics.push({ cell, message });
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
