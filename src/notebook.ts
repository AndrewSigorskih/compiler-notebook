/**
 * The bridge between `vscode.NotebookDocument` and the pure resolver.
 *
 * Three consumers need the same answer for the same notebook — the controller,
 * the cell status bar and the diagnostic collection — so the resolution is
 * computed once and memoised until the notebook actually changes.
 */

import * as vscode from 'vscode';

import { CellLike, Diagnostic, Project } from './model';
import { resolveProjects } from './project';

/** Adapts a vscode notebook cell to the resolver's cell shape. */
export class CellAdapter implements CellLike {
	constructor(readonly cell: vscode.NotebookCell) {}

	get kind(): 'markup' | 'code' {
		return this.cell.kind === vscode.NotebookCellKind.Markup ? 'markup' : 'code';
	}

	get languageId(): string {
		return this.cell.document.languageId;
	}

	get value(): string {
		return this.cell.document.getText();
	}

	get metadata(): Record<string, unknown> {
		return this.cell.metadata ?? {};
	}
}

export interface NotebookResolution {
	readonly projects: readonly Project<CellAdapter>[];
	/** The project a cell belongs to, buildspec cells included. */
	readonly ownerOf: ReadonlyMap<vscode.NotebookCell, Project<CellAdapter>>;
	/** The name a file cell will be written under. */
	readonly filenameOf: ReadonlyMap<vscode.NotebookCell, string>;
	readonly diagnosticsOf: ReadonlyMap<vscode.NotebookCell, readonly Diagnostic<CellAdapter>[]>;
}

/**
 * Cell edits and notebook edits bump different versions, so the cache key has to
 * cover both. Notebooks are small; building this string is cheaper than a
 * needless re-resolve on every status bar repaint.
 */
function stampOf(notebook: vscode.NotebookDocument): string {
	const cells = notebook.getCells();
	let stamp = `${notebook.version}:${cells.length}`;
	for (const cell of cells) {
		stamp += `:${cell.document.version}`;
	}
	return stamp;
}

interface CacheEntry {
	readonly stamp: string;
	readonly resolution: NotebookResolution;
}

const cache = new WeakMap<vscode.NotebookDocument, CacheEntry>();

export function resolveNotebook(notebook: vscode.NotebookDocument): NotebookResolution {
	const stamp = stampOf(notebook);
	const cached = cache.get(notebook);
	if (cached?.stamp === stamp) {
		return cached.resolution;
	}

	const { projects, diagnostics } = resolveProjects(
		notebook.getCells().map((cell) => new CellAdapter(cell))
	);

	const ownerOf = new Map<vscode.NotebookCell, Project<CellAdapter>>();
	const filenameOf = new Map<vscode.NotebookCell, string>();
	for (const project of projects) {
		ownerOf.set(project.specCell.cell, project);
		for (const file of project.files) {
			ownerOf.set(file.cell.cell, project);
			filenameOf.set(file.cell.cell, file.filename);
		}
	}

	const diagnosticsOf = new Map<vscode.NotebookCell, Diagnostic<CellAdapter>[]>();
	for (const diagnostic of diagnostics) {
		const cell = diagnostic.cell.cell;
		const existing = diagnosticsOf.get(cell);
		if (existing) {
			existing.push(diagnostic);
		} else {
			diagnosticsOf.set(cell, [diagnostic]);
		}
	}

	const resolution: NotebookResolution = { projects, ownerOf, filenameOf, diagnosticsOf };
	cache.set(notebook, { stamp, resolution });
	return resolution;
}
