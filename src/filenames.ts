/**
 * The "named cell" UX (CLAUDE.md §4): a cell status bar item showing the name a
 * file cell will be written under, and a command to change it.
 *
 * The status bar is the only place a file name can be surfaced — there is no
 * custom UI inside a cell input — so an auto-generated name is labelled as such
 * rather than left to look like something the user typed (§6).
 */

import * as vscode from 'vscode';

import { ArtifactStore } from './artifacts';
import { BUILDSPEC_LANGUAGE_ID, NOTEBOOK_TYPE } from './model';
import { isEmptyCodeCell, newProjectItem } from './newproject';
import { CellAdapter, resolveNotebook } from './notebook';
import { sanitizeFilename, statedFilename } from './project';
import { artifactKey, saveBinaryItem } from './savebinary';

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

	constructor(private readonly artifacts: ArtifactStore) {
		// A name can change without its own cell being touched — inserting a
		// buildspec above re-scopes every cell below it — so repaint them all.
		this.disposables.push(
			// A finished build is what makes "Save binary" appear, and it changes no
			// cell text, so the store says when to repaint.
			this.artifacts.onDidChange(() => this.scheduleRepaint()),
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

		const items: vscode.NotebookCellStatusBarItem[] = [];

		// Offered on any empty code cell, including one already inside a project:
		// starting a *second* project in a notebook has to stay reachable. It is
		// only ever offered where there is no content to destroy.
		if (isEmptyCodeCell(cell)) {
			items.push(newProjectItem(cell));
		}

		const resolution = resolveNotebook(cell.notebook);
		const project = resolution.ownerOf.get(cell);

		if (cell.document.languageId === BUILDSPEC_LANGUAGE_ID) {
			if (!project) {
				return items;
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
			items.push(item);

			const artifact = this.artifacts.get(artifactKey(cell));
			if (artifact) {
				items.push(saveBinaryItem(cell, artifact));
			}
			return items;
		}

		const filename = resolution.filenameOf.get(cell);
		if (filename === undefined) {
			return items;
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
		items.push(item);
		return items;
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
	await vscode.workspace.applyEdit(edit);
}
