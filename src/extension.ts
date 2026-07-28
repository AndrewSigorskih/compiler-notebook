import * as vscode from 'vscode';

import { CompilerNotebookController } from './controller';
import { NOTEBOOK_TYPE } from './model';
import { CompilerNotebookSerializer } from './serializer';

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new CompilerNotebookSerializer(), {
			transientOutputs: true
		}),
		new CompilerNotebookController()
	);
}

export function deactivate(): void {
	// Nothing to do: everything lives on context.subscriptions.
}
