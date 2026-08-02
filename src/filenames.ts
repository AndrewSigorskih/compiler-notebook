/**
 * The "named cell" UX (CLAUDE.md §4): a cell status bar item showing the name a
 * file cell will be written under, and a command to change it.
 *
 * The status bar is the only place a file name can be surfaced — there is no
 * custom UI inside a cell input — so an auto-generated name is labelled as such
 * rather than left to look like something the user typed (§6).
 */

import * as vscode from 'vscode';

import { BUILDSPEC_LANGUAGE_ID, NOTEBOOK_TYPE } from './model';
import { CellAdapter, resolveNotebook } from './notebook';
import { filenameDirective, sanitizeFilename, statedFilename } from './project';

export const RENAME_COMMAND = 'compilerNotebook.renameFileCell';

/** What the status bar item hands back to the command. */
interface RenameTarget {
	readonly notebookUri: string;
	readonly index: number;
}

export class CellStatusBarProvider implements vscode.NotebookCellStatusBarItemProvider {
	private readonly changed = new vscode.EventEmitter<void>();
	private readonly disposables: vscode.Disposable[] = [this.changed];
	private timer: NodeJS.Timeout | undefined;

	readonly onDidChangeCellStatusBarItems = this.changed.event;

	constructor() {
		// A name can change without its own cell being touched — inserting a
		// buildspec above re-scopes every cell below it — so repaint them all.
		this.disposables.push(
			vscode.workspace.onDidChangeNotebookDocument((event) => {
				if (event.notebook.notebookType === NOTEBOOK_TYPE) {
					this.scheduleRepaint();
				}
			}),
			vscode.workspace.onDidChangeTextDocument((event) => {
				// Cell editors only: every other document in the window is noise.
				if (event.document.uri.scheme === 'vscode-notebook-cell') {
					this.scheduleRepaint();
				}
			})
		);
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	/** Coalesce keystrokes: a repaint per character typed is wasted work. */
	private scheduleRepaint(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.changed.fire();
		}, 150);
	}

	provideCellStatusBarItems(cell: vscode.NotebookCell): vscode.NotebookCellStatusBarItem[] {
		if (cell.kind !== vscode.NotebookCellKind.Code) {
			return [];
		}

		const resolution = resolveNotebook(cell.notebook);
		const project = resolution.ownerOf.get(cell);

		if (cell.document.languageId === BUILDSPEC_LANGUAGE_ID) {
			if (!project) {
				return [];
			}
			const item = new vscode.NotebookCellStatusBarItem(
				`$(gear) ${project.spec.compiler} · ${project.spec.mode} · ${project.files.length} file(s)`,
				vscode.NotebookCellStatusBarAlignment.Left
			);
			item.tooltip = [
				`Buildspec for a project of ${project.files.length} file(s)`,
				`compiler: ${project.spec.compiler}`,
				`flags: ${project.spec.flags.join(' ') || '(none)'}`,
				`mode: ${project.spec.mode}`,
				`output: ${project.spec.output}`
			].join('\n');
			return [item];
		}

		const filename = resolution.filenameOf.get(cell);
		if (filename === undefined) {
			return [];
		}

		const stated = statedFilename(new CellAdapter(cell));
		const auto = stated === undefined;
		const renamed = !auto && stated !== filename;

		const item = new vscode.NotebookCellStatusBarItem(
			auto ? `$(sparkle) ${filename} (auto)` : `$(file) ${filename}`,
			vscode.NotebookCellStatusBarAlignment.Left
		);
		item.command = {
			title: 'Rename file cell',
			command: RENAME_COMMAND,
			arguments: [{ notebookUri: cell.notebook.uri.toString(), index: cell.index }]
		};
		item.tooltip = auto
			? `Auto-generated name — click to name this cell.`
			: renamed
				? `You asked for "${stated}"; using "${filename}". Click to rename.`
				: 'Click to rename this cell.';
		return [item];
	}
}

function resolveTarget(target?: RenameTarget): vscode.NotebookCell | undefined {
	if (target) {
		const notebook = vscode.workspace.notebookDocuments.find(
			(candidate) => candidate.uri.toString() === target.notebookUri
		);
		return notebook?.cellAt(target.index);
	}

	// Invoked from the command palette: act on the selected cell.
	const editor = vscode.window.activeNotebookEditor;
	if (!editor || editor.notebook.notebookType !== NOTEBOOK_TYPE) {
		return undefined;
	}
	return editor.notebook.cellAt(editor.selection.start);
}

export async function renameFileCell(target?: RenameTarget): Promise<void> {
	const cell = resolveTarget(target);
	if (!cell) {
		void vscode.window.showWarningMessage('Select a file cell in a compiler notebook first.');
		return;
	}

	const resolution = resolveNotebook(cell.notebook);
	const current = resolution.filenameOf.get(cell);
	if (current === undefined) {
		void vscode.window.showWarningMessage('This cell is not a file cell, so it has no file name.');
		return;
	}

	const stated = statedFilename(new CellAdapter(cell));
	const value = await vscode.window.showInputBox({
		title: 'File name for this cell',
		prompt: 'Relative to the build directory. Leave empty to go back to an auto-generated name.',
		value: stated ?? current,
		validateInput: (input) => {
			const trimmed = input.trim();
			if (trimmed.length === 0) {
				return undefined;
			}
			const sanitized = sanitizeFilename(trimmed);
			if (!sanitized) {
				return 'Not a usable file name.';
			}
			return sanitized.problem;
		}
	});

	if (value === undefined) {
		return;
	}

	const filename = value.trim();
	const edit = new vscode.WorkspaceEdit();

	const metadata = { ...cell.metadata };
	if (filename.length === 0) {
		delete metadata['filename'];
	} else {
		metadata['role'] = 'file';
		metadata['filename'] = filename;
	}
	edit.set(cell.notebook.uri, [vscode.NotebookEdit.updateCellMetadata(cell.index, metadata)]);

	// A stale `// @file` line would contradict the status bar, since metadata
	// wins. Keep the two in step instead of leaving the user to reconcile them.
	const directive = filenameDirective(cell.document.getText());
	if (directive !== undefined && directive !== filename) {
		const firstLine = cell.document.lineAt(0);
		if (filename.length === 0) {
			edit.delete(
				cell.document.uri,
				firstLine.rangeIncludingLineBreak ?? firstLine.range
			);
		} else {
			edit.replace(
				cell.document.uri,
				firstLine.range,
				firstLine.text.replace(directive, filename)
			);
		}
	}

	await vscode.workspace.applyEdit(edit);
}

/**
 * Persist `// @file x.cpp` into `metadata.filename` (CLAUDE.md §4).
 *
 * Done on execute rather than on open: it edits the notebook, and marking a file
 * dirty just because the user looked at it would be rude. Running a cell is an
 * explicit action, and the metadata is what the serializer round-trips.
 */
export async function syncFileDirectives(notebook: vscode.NotebookDocument): Promise<void> {
	const { filenameOf } = resolveNotebook(notebook);
	const edits: vscode.NotebookEdit[] = [];

	for (const cell of notebook.getCells()) {
		if (!filenameOf.has(cell) || typeof cell.metadata?.['filename'] === 'string') {
			continue;
		}
		const directive = filenameDirective(cell.document.getText());
		if (directive === undefined) {
			continue;
		}
		const sanitized = sanitizeFilename(directive);
		if (!sanitized || sanitized.problem) {
			// Leave a bad directive alone; it is already reported as a diagnostic.
			continue;
		}
		edits.push(
			vscode.NotebookEdit.updateCellMetadata(cell.index, {
				...cell.metadata,
				role: 'file',
				filename: sanitized.filename
			})
		);
	}

	if (edits.length === 0) {
		return;
	}

	const edit = new vscode.WorkspaceEdit();
	edit.set(notebook.uri, edits);
	await vscode.workspace.applyEdit(edit);
}
