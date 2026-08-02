/**
 * Soft problems (CLAUDE.md §6) as real editor squiggles, keyed on cell document
 * URIs, refreshed as the user types rather than only when something is run.
 */

import * as vscode from 'vscode';

import { NOTEBOOK_TYPE } from './model';
import { resolveNotebook } from './notebook';

const SOURCE = 'compiler-notebook';

/** Coalesce bursts of keystrokes into one refresh. */
const DEBOUNCE_MS = 250;

export class NotebookDiagnostics {
	private readonly collection = vscode.languages.createDiagnosticCollection(NOTEBOOK_TYPE);
	private readonly disposables: vscode.Disposable[] = [];
	private readonly pending = new Map<string, NodeJS.Timeout>();

	constructor() {
		this.disposables.push(
			vscode.workspace.onDidOpenNotebookDocument((notebook) => this.schedule(notebook)),
			vscode.workspace.onDidChangeNotebookDocument((event) => this.schedule(event.notebook)),
			vscode.workspace.onDidCloseNotebookDocument((notebook) => this.clear(notebook)),
			// Cell text edits arrive as plain text-document changes.
			vscode.workspace.onDidChangeTextDocument((event) => {
				if (event.document.uri.scheme !== 'vscode-notebook-cell') {
					return;
				}
				const notebook = vscode.workspace.notebookDocuments.find(
					(candidate) =>
						candidate.notebookType === NOTEBOOK_TYPE &&
						candidate.getCells().some((cell) => cell.document === event.document)
				);
				if (notebook) {
					this.schedule(notebook);
				}
			})
		);

		for (const notebook of vscode.workspace.notebookDocuments) {
			this.schedule(notebook);
		}
	}

	dispose(): void {
		for (const timer of this.pending.values()) {
			clearTimeout(timer);
		}
		this.pending.clear();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.collection.dispose();
	}

	private schedule(notebook: vscode.NotebookDocument): void {
		if (notebook.notebookType !== NOTEBOOK_TYPE) {
			return;
		}
		const key = notebook.uri.toString();
		const existing = this.pending.get(key);
		if (existing) {
			clearTimeout(existing);
		}
		this.pending.set(
			key,
			setTimeout(() => {
				this.pending.delete(key);
				this.refresh(notebook);
			}, DEBOUNCE_MS)
		);
	}

	/** Recompute every cell of a notebook; stale cells must lose their squiggles. */
	refresh(notebook: vscode.NotebookDocument): void {
		if (notebook.notebookType !== NOTEBOOK_TYPE) {
			return;
		}

		const { diagnosticsOf } = resolveNotebook(notebook);
		for (const cell of notebook.getCells()) {
			const problems = diagnosticsOf.get(cell) ?? [];
			this.collection.set(
				cell.document.uri,
				problems.map((problem) => {
					const diagnostic = new vscode.Diagnostic(
						lineRange(cell.document, problem.line ?? 0),
						problem.message,
						vscode.DiagnosticSeverity.Warning
					);
					diagnostic.source = SOURCE;
					return diagnostic;
				})
			);
		}
	}

	private clear(notebook: vscode.NotebookDocument): void {
		for (const cell of notebook.getCells()) {
			this.collection.delete(cell.document.uri);
		}
	}
}

/** The whole of `line`, or the last line if the cell has since shrunk. */
function lineRange(document: vscode.TextDocument, line: number): vscode.Range {
	const clamped = Math.max(0, Math.min(line, document.lineCount - 1));
	return document.lineAt(clamped).range;
}
