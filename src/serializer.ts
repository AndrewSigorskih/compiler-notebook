/**
 * JSON notebook serializer (CLAUDE.md §7).
 *
 * Round-trips cell metadata losslessly; cell outputs are not persisted.
 */

import * as vscode from 'vscode';

const FORMAT_VERSION = 1;

interface RawCell {
	kind: 'markup' | 'code';
	language: string;
	value: string;
	metadata?: Record<string, unknown>;
}

interface RawNotebook {
	version: number;
	cells: RawCell[];
}

function emptyNotebook(): RawNotebook {
	return { version: FORMAT_VERSION, cells: [] };
}

export class CompilerNotebookSerializer implements vscode.NotebookSerializer {
	deserializeNotebook(content: Uint8Array): vscode.NotebookData {
		const text = new TextDecoder().decode(content).trim();

		let raw: RawNotebook;
		if (text.length === 0) {
			raw = emptyNotebook();
		} else {
			try {
				raw = JSON.parse(text) as RawNotebook;
			} catch (err) {
				// Never lose the user's bytes: surface them as a markdown cell.
				const message = err instanceof Error ? err.message : String(err);
				return new vscode.NotebookData([
					new vscode.NotebookCellData(
						vscode.NotebookCellKind.Markup,
						`**Could not parse this notebook** (${message}). Raw contents:\n\n\`\`\`\n${text}\n\`\`\``,
						'markdown'
					)
				]);
			}
		}

		const cells = (raw.cells ?? []).map((cell) => {
			const kind =
				cell.kind === 'markup' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;
			const data = new vscode.NotebookCellData(kind, cell.value ?? '', cell.language ?? 'plaintext');
			if (cell.metadata) {
				data.metadata = cell.metadata;
			}
			return data;
		});

		return new vscode.NotebookData(cells);
	}

	serializeNotebook(data: vscode.NotebookData): Uint8Array {
		const raw: RawNotebook = {
			version: FORMAT_VERSION,
			cells: data.cells.map((cell) => {
				const out: RawCell = {
					kind: cell.kind === vscode.NotebookCellKind.Markup ? 'markup' : 'code',
					language: cell.languageId,
					value: cell.value
				};
				if (cell.metadata && Object.keys(cell.metadata).length > 0) {
					out.metadata = cell.metadata;
				}
				return out;
			})
		};

		return new TextEncoder().encode(JSON.stringify(raw, null, 2) + '\n');
	}
}
