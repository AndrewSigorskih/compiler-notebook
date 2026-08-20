/**
 * "Save binary": copy the last binary a project produced out of its temp dir.
 *
 * The affordance is a cell status bar item on the buildspec cell — the same
 * place the project's other state is surfaced, and one of the only two places
 * custom UI is allowed at all (CLAUDE.md §3). It appears once that project has
 * been built, and the build it refers to is the one whose output is sitting in
 * the cell right above it.
 *
 * Which build dir belongs to which cell is tracked by `ArtifactStore`; this file
 * is the vscode half — keys, the status bar item, the dialog, and what to say
 * when the build turns out to be gone.
 */

import * as fs from 'fs/promises';
import * as vscode from 'vscode';

import { ArtifactStore, StoredArtifact } from './artifacts';
import { NOTEBOOK_TYPE } from './model';

export const SAVE_BINARY_COMMAND = 'compilerNotebook.saveBinary';

interface CellTarget {
	readonly notebookUri: string;
	readonly index: number;
}

/**
 * Identity of a buildspec cell across rebuilds.
 *
 * A cell's document URI is stable while the notebook is open, and survives the
 * cell being moved — unlike its index, which every insertion above it changes.
 */
export function artifactKey(cell: vscode.NotebookCell): string {
	return `${cell.notebook.uri.toString()}::${cell.document.uri.toString()}`;
}

function notebookPrefix(notebook: vscode.NotebookDocument): string {
	return `${notebook.uri.toString()}::`;
}

export function saveBinaryItem(
	cell: vscode.NotebookCell,
	artifact: StoredArtifact
): vscode.NotebookCellStatusBarItem {
	const item = new vscode.NotebookCellStatusBarItem(
		`$(save) Save ${artifact.name}`,
		vscode.NotebookCellStatusBarAlignment.Right
	);
	item.command = {
		title: 'Save the built binary',
		command: SAVE_BINARY_COMMAND,
		arguments: [{ notebookUri: cell.notebook.uri.toString(), index: cell.index }]
	};
	item.tooltip = [
		`Copy the binary from the last build of this project`,
		`built ${new Date(artifact.at).toLocaleTimeString()} in ${artifact.dir}`,
		'That directory is temporary — it does not survive a reboot.'
	].join('\n');
	return item;
}

/**
 * Retained build dirs belong to an open notebook: closing it, or deleting the
 * buildspec cell that owns one, releases the dir there and then rather than
 * leaving it for the process to exit.
 */
export function registerArtifactLifecycle(store: ArtifactStore): vscode.Disposable {
	return vscode.Disposable.from(
		vscode.workspace.onDidCloseNotebookDocument((notebook) => {
			if (notebook.notebookType !== NOTEBOOK_TYPE) {
				return;
			}
			const prefix = notebookPrefix(notebook);
			store.forgetWhere((key) => key.startsWith(prefix));
		}),
		vscode.workspace.onDidChangeNotebookDocument((event) => {
			if (event.notebook.notebookType !== NOTEBOOK_TYPE) {
				return;
			}
			for (const change of event.contentChanges) {
				for (const cell of change.removedCells) {
					store.forget(artifactKey(cell));
				}
			}
		})
	);
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

/** Where the dialog should open: beside the notebook, under the binary's name. */
function defaultDestination(
	cell: vscode.NotebookCell,
	artifact: StoredArtifact
): vscode.Uri | undefined {
	const notebookUri = cell.notebook.uri;
	if (notebookUri.scheme !== 'file') {
		// An untitled notebook has no directory to be beside.
		return undefined;
	}
	return vscode.Uri.joinPath(notebookUri, '..', artifact.name);
}

async function copyBinary(binary: string, target: vscode.Uri): Promise<boolean> {
	if (target.scheme === 'file') {
		await fs.copyFile(binary, target.fsPath);
		// An executable that arrives without its executable bit is not much of a
		// deliverable; copyFile is not specified to carry the mode everywhere.
		const stat = await fs.stat(binary);
		await fs.chmod(target.fsPath, stat.mode & 0o777);
		return true;
	}

	// A remote or virtual filesystem: go through vscode, which has no notion of
	// a mode, so the caller is told the bit did not come along.
	await vscode.workspace.fs.writeFile(target, await fs.readFile(binary));
	return false;
}

export async function saveBinary(store: ArtifactStore, target?: CellTarget): Promise<void> {
	const cell = resolveTarget(target);
	if (!cell) {
		void vscode.window.showWarningMessage('Select a buildspec cell in a compiler notebook first.');
		return;
	}

	const artifact = await store.verify(artifactKey(cell));
	if (!artifact) {
		// `verify` has already dropped the entry, so the status bar item goes away
		// with this message rather than staying to fail again.
		void vscode.window.showWarningMessage(
			'No saved binary for this project. Its build directory is temporary and is gone — run the project again, then save.'
		);
		return;
	}

	const destination = await vscode.window.showSaveDialog({
		title: 'Save built binary',
		defaultUri: defaultDestination(cell, artifact),
		saveLabel: 'Save binary'
	});
	if (!destination) {
		return;
	}

	try {
		const executable = await copyBinary(artifact.binary, destination);
		const note = executable ? '' : ' (without its executable bit — this filesystem has no modes)';
		const reveal = 'Reveal';
		const choice = await vscode.window.showInformationMessage(
			`Saved ${artifact.name}${note}.`,
			...(destination.scheme === 'file' ? [reveal] : [])
		);
		if (choice === reveal) {
			await vscode.commands.executeCommand('revealFileInOS', destination);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		void vscode.window.showErrorMessage(`Could not save the binary: ${message}`);
	}
}
