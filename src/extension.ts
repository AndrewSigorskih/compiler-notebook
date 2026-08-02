import * as vscode from 'vscode';

import { CompilerNotebookController } from './controller';
import { NotebookDiagnostics } from './diagnostics';
import { CellStatusBarProvider, RENAME_COMMAND, renameFileCell } from './filenames';
import { NOTEBOOK_TYPE } from './model';
import { CompilerNotebookSerializer } from './serializer';

export function activate(context: vscode.ExtensionContext): void {
	const diagnostics = new NotebookDiagnostics();
	const statusBar = new CellStatusBarProvider();

	context.subscriptions.push(
		vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new CompilerNotebookSerializer(), {
			transientOutputs: true
		}),
		diagnostics,
		new CompilerNotebookController(diagnostics),
		statusBar,
		vscode.notebooks.registerNotebookCellStatusBarItemProvider(NOTEBOOK_TYPE, statusBar),
		vscode.commands.registerCommand(RENAME_COMMAND, renameFileCell)
	);
}

export function deactivate(): void {
	// Nothing to do: everything lives on context.subscriptions.
}
