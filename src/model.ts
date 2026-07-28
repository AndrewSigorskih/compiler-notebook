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

/**
 * Phase 1 hardcodes this. Phase 2 replaces it with a parsed TOML buildspec
 * cell, falling back to these values for missing keys.
 */
export const DEFAULT_SPEC: BuildSpec = {
	compiler: 'g++',
	flags: ['-std=c++20', '-O2', '-Wall', '-Wextra'],
	mode: 'run',
	output: 'app'
};

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
	/** Cell that owns the execution output. Undefined until phase 2. */
	readonly specCell?: T;
	readonly files: readonly ProjectFile<T>[];
}

/** A non-fatal problem to surface on a cell (CLAUDE.md §6). */
export interface Diagnostic<T extends CellLike = CellLike> {
	readonly cell: T;
	readonly message: string;
}

export interface ResolveResult<T extends CellLike = CellLike> {
	readonly projects: readonly Project<T>[];
	readonly diagnostics: readonly Diagnostic<T>[];
}
