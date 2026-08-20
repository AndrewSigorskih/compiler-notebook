import * as vscode from 'vscode';

import { ArtifactStore, sweepStaleBuildDirs } from './artifacts';
import { CompilerNotebookController } from './controller';
import { NotebookDiagnostics } from './diagnostics';
import { CellStatusBarProvider, RENAME_COMMAND, renameFileCell } from './filenames';
import { NOTEBOOK_TYPE } from './model';
import { NEW_PROJECT_COMMAND, newProject } from './newproject';
import { registerArtifactLifecycle, SAVE_BINARY_COMMAND, saveBinary } from './savebinary';
import { CompilerNotebookSerializer } from './serializer';

export function activate(context: vscode.ExtensionContext): void {
	const diagnostics = new NotebookDiagnostics();
	const artifacts = new ArtifactStore();
	const statusBar = new CellStatusBarProvider(artifacts);

	context.subscriptions.push(
		vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new CompilerNotebookSerializer(), {
			transientOutputs: true
		}),
		diagnostics,
		artifacts,
		new CompilerNotebookController(diagnostics, artifacts),
		statusBar,
		registerArtifactLifecycle(artifacts),
		vscode.notebooks.registerNotebookCellStatusBarItemProvider(NOTEBOOK_TYPE, statusBar),
		vscode.commands.registerCommand(RENAME_COMMAND, renameFileCell),
		vscode.commands.registerCommand(NEW_PROJECT_COMMAND, newProject),
		vscode.commands.registerCommand(SAVE_BINARY_COMMAND, (target) => saveBinary(artifacts, target))
	);

	// An extension host that was killed never cleaned up after itself; collect
	// what it left in the temp dir. Best effort, and never blocks activation.
	void sweepStaleBuildDirs().catch(() => undefined);
}

export function deactivate(): void {
	// Nothing to do: everything lives on context.subscriptions.
}
