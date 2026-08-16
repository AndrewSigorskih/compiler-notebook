/**
 * "New project" on an empty code cell (CLAUDE.md §4).
 *
 * A buildspec cell is just a `toml` code cell, which is invisible as an
 * affordance: on a fresh notebook the first cell defaults to C++, and the only
 * way to turn it into a project is to know that the language picker in the
 * corner is what does it. So an empty code cell offers the step directly, picks
 * the language, and fills in that language's defaults.
 */

import * as vscode from 'vscode';

import { defaultBuildspecText } from './buildspec';
import { LANGUAGES } from './languages';
import { BUILDSPEC_LANGUAGE_ID, NOTEBOOK_TYPE } from './model';

export const NEW_PROJECT_COMMAND = 'compilerNotebook.newProject';

interface CellTarget {
	readonly notebookUri: string;
	readonly index: number;
}

/** Only offered on an empty code cell: it replaces the cell's content. */
export function isEmptyCodeCell(cell: vscode.NotebookCell): boolean {
	return (
		cell.kind === vscode.NotebookCellKind.Code && cell.document.getText().trim().length === 0
	);
}

export function newProjectItem(cell: vscode.NotebookCell): vscode.NotebookCellStatusBarItem {
	const item = new vscode.NotebookCellStatusBarItem(
		'$(rocket) New project',
		vscode.NotebookCellStatusBarAlignment.Left
	);
	item.command = {
		title: 'Start a new project here',
		command: NEW_PROJECT_COMMAND,
		arguments: [{ notebookUri: cell.notebook.uri.toString(), index: cell.index }]
	};
	item.tooltip = 'Turn this cell into a buildspec cell, filled in for a language';
	return item;
}

function resolveTarget(target?: CellTarget): vscode.NotebookCell | undefined {
	if (target) {
		const notebook = vscode.workspace.notebookDocuments.find(
			(candidate) => candidate.uri.toString() === target.notebookUri
		);
		return notebook?.cellAt(target.index);
	}

	const editor = vscode.window.activeNotebookEditor;
	if (!editor || editor.notebook.notebookType !== NOTEBOOK_TYPE) {
		return undefined;
	}
	return editor.notebook.cellAt(editor.selection.start);
}

interface LanguagePick extends vscode.QuickPickItem {
	readonly languageId: string;
}

export async function newProject(target?: CellTarget): Promise<void> {
	const cell = resolveTarget(target);
	if (!cell) {
		void vscode.window.showWarningMessage('Select a cell in a compiler notebook first.');
		return;
	}

	const picks: LanguagePick[] = Object.entries(LANGUAGES).map(([languageId, config]) => ({
		languageId,
		label: languageId,
		description: config.defaultCompiler,
		detail: config.defaultFlags?.length ? config.defaultFlags.join(' ') : undefined
	}));

	const picked = await vscode.window.showQuickPick(picks, {
		title: 'New project',
		placeHolder: 'Language for this project — its compiler and flags become the defaults'
	});
	if (!picked) {
		return;
	}

	// A cell's language cannot be changed in place, so the empty cell is swapped
	// for the pair a project actually needs: the buildspec, and a source cell in
	// the project's language ready to type into. One edit, so one undo takes the
	// whole thing back.
	const replacement = [
		new vscode.NotebookCellData(
			vscode.NotebookCellKind.Code,
			defaultBuildspecText(picked.languageId),
			BUILDSPEC_LANGUAGE_ID
		),
		new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', picked.languageId)
	];

	const edit = new vscode.WorkspaceEdit();
	edit.set(cell.notebook.uri, [
		vscode.NotebookEdit.replaceCells(
			new vscode.NotebookRange(cell.index, cell.index + 1),
			replacement
		)
	]);
	await vscode.workspace.applyEdit(edit);

	// Select the source cell, not the buildspec: the buildspec is already filled
	// in, and writing code is what comes next.
	const editor = vscode.window.visibleNotebookEditors.find(
		(candidate) => candidate.notebook.uri.toString() === cell.notebook.uri.toString()
	);
	if (editor) {
		const source = new vscode.NotebookRange(cell.index + 1, cell.index + 2);
		editor.selection = source;
		editor.revealRange(source);
	}
}
