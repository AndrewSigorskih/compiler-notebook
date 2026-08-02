/**
 * Core data model shared by the resolver, the builder and the controller.
 *
 * Nothing here may import `vscode` — the resolver must stay unit-testable
 * outside the extension host (CLAUDE.md §10).
 */

export const NOTEBOOK_TYPE = 'compiler-notebook';

/** languageId that marks a Code cell as a buildspec cell (CLAUDE.md §4). */
export const BUILDSPEC_LANGUAGE_ID = 'toml';

export type CellRole = 'markup' | 'buildspec' | 'file' | 'other';

export type BuildMode = 'build' | 'run';

export interface BuildSpec {
	readonly compiler: string;
	readonly flags: readonly string[];
	readonly mode: BuildMode;
	/** Binary name, without platform suffix. */
	readonly output: string;
}

/** What a buildspec cell actually stated; everything else is defaulted. */
export interface PartialBuildSpec {
	readonly compiler?: string;
	readonly flags?: readonly string[];
	readonly mode?: BuildMode;
	readonly output?: string;
}

/** Minimal shape of a notebook cell the resolver needs. */
export interface CellLike {
	readonly kind: 'markup' | 'code';
	readonly languageId: string;
	readonly value: string;
	readonly metadata?: Record<string, unknown>;
}

/** A file cell paired with the name it will be written under. */
export interface ProjectFile<T extends CellLike = CellLike> {
	readonly cell: T;
	readonly filename: string;
}

export interface Project<T extends CellLike = CellLike> {
	readonly spec: BuildSpec;
	/**
	 * The buildspec cell that opened this project. It owns the execution output
	 * no matter which of the project's cells was run (CLAUDE.md §5).
	 */
	readonly specCell: T;
	readonly files: readonly ProjectFile<T>[];
}

/** A non-fatal problem to surface on a cell (CLAUDE.md §6). */
export interface Diagnostic<T extends CellLike = CellLike> {
	readonly cell: T;
	readonly message: string;
	/** Zero-based line within the cell. Defaults to the first line. */
	readonly line?: number;
}

export interface ResolveResult<T extends CellLike = CellLike> {
	readonly projects: readonly Project<T>[];
	readonly diagnostics: readonly Diagnostic<T>[];
}
