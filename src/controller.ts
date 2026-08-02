/**
 * The "kernel": resolves the owning project of every executed cell, builds each
 * distinct project once, and streams compiler/program output (CLAUDE.md §5).
 */

import * as vscode from 'vscode';

import { buildAndRun, OutputSink } from './build';
import { NotebookDiagnostics } from './diagnostics';
import { syncFileDirectives } from './filenames';
import { NOTEBOOK_TYPE, Project } from './model';
import { CellAdapter, resolveNotebook } from './notebook';

const CONTROLLER_ID = 'compiler-notebook-controller';

/** Serialises appends so output chunks land in the order they were produced. */
class ExecutionSink implements OutputSink {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly execution: vscode.NotebookCellExecution,
		private readonly output: vscode.NotebookCellOutput
	) {}

	private append(item: vscode.NotebookCellOutputItem): void {
		this.queue = this.queue
			.then(() => this.execution.appendOutputItems(item, this.output))
			.then(undefined, () => undefined);
	}

	info(text: string): void {
		this.append(vscode.NotebookCellOutputItem.stdout(text));
	}

	stdout(chunk: string): void {
		this.append(vscode.NotebookCellOutputItem.stdout(chunk));
	}

	stderr(chunk: string): void {
		this.append(vscode.NotebookCellOutputItem.stderr(chunk));
	}

	flush(): Promise<unknown> {
		return this.queue;
	}
}

export class CompilerNotebookController {
	private readonly controller: vscode.NotebookController;
	private executionOrder = 0;

	constructor(private readonly diagnostics: NotebookDiagnostics) {
		this.controller = vscode.notebooks.createNotebookController(
			CONTROLLER_ID,
			NOTEBOOK_TYPE,
			'Compiler Notebook'
		);
		this.controller.supportedLanguages = ['cpp', 'c', 'rust', 'zig', 'toml'];
		this.controller.supportsExecutionOrder = true;
		this.controller.description = 'Compile and run notebook projects';
		this.controller.executeHandler = (cells, notebook) => this.execute(cells, notebook);
	}

	dispose(): void {
		this.controller.dispose();
	}

	private async execute(
		cells: vscode.NotebookCell[],
		notebook: vscode.NotebookDocument
	): Promise<void> {
		// Running is an explicit action, so it is a fair moment to persist any
		// `// @file` directive into cell metadata (CLAUDE.md §4).
		await syncFileDirectives(notebook);

		const { ownerOf, diagnosticsOf } = resolveNotebook(notebook);
		// The squiggles are refreshed on a debounce; a run should not report
		// anything the editor is not already showing.
		this.diagnostics.refresh(notebook);

		// De-duplicate: build each distinct project once, no matter how many of
		// its cells were run.
		const pending = new Map<Project<CellAdapter>, vscode.NotebookCell[]>();
		const orphans: vscode.NotebookCell[] = [];
		for (const cell of cells) {
			const project = ownerOf.get(cell);
			if (!project) {
				orphans.push(cell);
				continue;
			}
			const group = pending.get(project);
			if (group) {
				group.push(cell);
			} else {
				pending.set(project, [cell]);
			}
		}

		for (const cell of orphans) {
			this.reportSkipped(
				cell,
				(diagnosticsOf.get(cell) ?? []).map((problem) => problem.message)
			);
		}

		for (const [project, requested] of pending) {
			// Output always lands on the buildspec cell, whichever cell was run.
			const primary = project.specCell.cell;
			const secondary = requested.filter((cell) => cell !== primary);
			await this.buildProject(project, primary, secondary, diagnosticsOf);
		}
	}

	private reportSkipped(cell: vscode.NotebookCell, messages: readonly string[]): void {
		const execution = this.controller.createNotebookCellExecution(cell);
		execution.executionOrder = ++this.executionOrder;
		execution.start(Date.now());
		const text =
			messages.length > 0
				? messages.map((message) => `${message}\n`).join('')
				: 'This cell is not part of any project — nothing to build.\n';
		void execution.replaceOutput(
			new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stderr(text)])
		);
		execution.end(false, Date.now());
	}

	private async buildProject(
		project: Project<CellAdapter>,
		primary: vscode.NotebookCell,
		secondary: readonly vscode.NotebookCell[],
		diagnosticsOf: ReadonlyMap<vscode.NotebookCell, readonly { message: string }[]>
	): Promise<void> {
		const execution = this.controller.createNotebookCellExecution(primary);
		execution.executionOrder = ++this.executionOrder;
		execution.start(Date.now());

		const output = new vscode.NotebookCellOutput([]);
		await execution.replaceOutput(output);
		const sink = new ExecutionSink(execution, output);

		// Also squiggled in the editor, but repeated here so the output is a
		// complete record of what this build actually did.
		const cells = [project.specCell.cell, ...project.files.map((file) => file.cell.cell)];
		for (const cell of cells) {
			for (const problem of diagnosticsOf.get(cell) ?? []) {
				sink.stderr(`warning: ${problem.message}\n`);
			}
		}

		const summary =
			project.files.length === 0
				? 'no file cells'
				: project.files.map((f) => f.filename).join(', ');
		sink.info(`Project: ${project.spec.compiler} — ${summary}\n`);

		let success = false;
		try {
			const result = await buildAndRun(project, sink, execution.token);
			success = result.success;
		} catch (err) {
			sink.stderr(`Internal error: ${err instanceof Error ? err.stack : String(err)}\n`);
		}

		await sink.flush();
		execution.end(success, Date.now());

		for (const cell of secondary) {
			const sibling = this.controller.createNotebookCellExecution(cell);
			sibling.executionOrder = ++this.executionOrder;
			sibling.start(Date.now());
			await sibling.replaceOutput(
				new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.stdout(
						'Built as part of the same project; output is shown on the project cell.\n'
					)
				])
			);
			sibling.end(success, Date.now());
		}
	}
}
