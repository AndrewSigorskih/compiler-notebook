/**
 * JSON notebook serializer (CLAUDE.md §7).
 *
 * The format itself lives in `cnb.ts`; this file is only the mapping to and from
 * VS Code's notebook types. Cell outputs are not persisted.
 */

import * as vscode from 'vscode';

import { CnbCell, parseCnb, stringifyCnb } from './cnb';

export class CompilerNotebookSerializer implements vscode.NotebookSerializer {
	deserializeNotebook(content: Uint8Array): vscode.NotebookData {
		const text = new TextDecoder().decode(content);
		const { cells, error } = parseCnb(text);

		if (error !== undefined) {
			// Never lose the user's bytes: surface them as a markdown cell.
			return new vscode.NotebookData([
				new vscode.NotebookCellData(
					vscode.NotebookCellKind.Markup,
					`**Could not parse this notebook** (${error}). Raw contents:\n\n\`\`\`\n${text.trim()}\n\`\`\``,
					'markdown'
				)
			]);
		}

		return new vscode.NotebookData(
			cells.map((cell) => {
				const data = new vscode.NotebookCellData(
					cell.kind === 'markup' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
					cell.value,
					cell.language
				);
				if (cell.metadata) {
					data.metadata = cell.metadata;
				}
				return data;
			})
		);
	}

	serializeNotebook(data: vscode.NotebookData): Uint8Array {
		const cells: CnbCell[] = data.cells.map((cell) => ({
			kind: cell.kind === vscode.NotebookCellKind.Markup ? 'markup' : 'code',
			language: cell.languageId,
			value: cell.value,
			...(cell.metadata && Object.keys(cell.metadata).length > 0
				? { metadata: cell.metadata }
				: {})
		}));

		return new TextEncoder().encode(stringifyCnb(cells));
	}
}
