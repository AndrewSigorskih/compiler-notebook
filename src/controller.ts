/**
 * The "kernel": resolves the owning project of every executed cell, builds each
 * distinct project once, and streams compiler/program output (CLAUDE.md §5).
 */

import * as vscode from 'vscode';

import { buildAndRun, OutputSink } from './build';
import { CellLike, NOTEBOOK_TYPE, Project } from './model';
import { resolveProjects } from './project';

const CONTROLLER_ID = 'compiler-notebook-controller';

/** Adapts a vscode notebook cell to the resolver's cell shape. */
class CellAdapter implements CellLike {
	constructor(readonly cell: vscode.NotebookCell) {}

	get kind(): 'markup' | 'code' {
		return this.cell.kind === vscode.NotebookCellKind.Markup ? 'markup' : 'code';
	}

	get languageId(): string {
		return this.cell.document.languageId;
	}

	get value(): string {
		return this.cell.document.getText();
	}

	get metadata(): Record<string, unknown> {
		return this.cell.metadata ?? {};
	}
}

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

	constructor() {
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
		const adapters = notebook.getCells().map((cell) => new CellAdapter(cell));
		const { projects, diagnostics } = resolveProjects(adapters);

		// Which project owns each executed cell.
		const ownerOf = new Map<vscode.NotebookCell, Project<CellAdapter>>();
		for (const project of projects) {
			for (const file of project.files) {
				ownerOf.set(file.cell.cell, project);
			}
			if (project.specCell) {
				ownerOf.set(project.specCell.cell, project);
			}
		}

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
			this.reportSkipped(cell);
		}

		for (const [project, requested] of pending) {
			// PHASE 1: no buildspec cell exists yet, so output goes to the first
			// requested cell. Phase 2 switches this to `project.specCell`.
			const primary = project.specCell?.cell ?? requested[0];
			const secondary = requested.filter((cell) => cell !== primary);
			await this.buildProject(project, primary, secondary, diagnostics);
		}
	}

	private reportSkipped(cell: vscode.NotebookCell): void {
		const execution = this.controller.createNotebookCellExecution(cell);
		execution.executionOrder = ++this.executionOrder;
		execution.start(Date.now());
		void execution.replaceOutput(
			new vscode.NotebookCellOutput([
				vscode.NotebookCellOutputItem.stdout(
					'This cell is not part of any project — nothing to build.\n'
				)
			])
		);
		execution.end(true, Date.now());
	}

	private async buildProject(
		project: Project<CellAdapter>,
		primary: vscode.NotebookCell,
		secondary: readonly vscode.NotebookCell[],
		diagnostics: readonly { cell: CellAdapter; message: string }[]
	): Promise<void> {
		const execution = this.controller.createNotebookCellExecution(primary);
		execution.executionOrder = ++this.executionOrder;
		execution.start(Date.now());

		const output = new vscode.NotebookCellOutput([]);
		await execution.replaceOutput(output);
		const sink = new ExecutionSink(execution, output);

		// Phase 4 moves these onto a DiagnosticCollection; for now they are at
		// least visible instead of silent.
		for (const diagnostic of diagnostics) {
			sink.stderr(`warning: ${diagnostic.message}\n`);
		}

		sink.info(
			`Project: ${project.files.length} file(s) — ${project.files
				.map((f) => f.filename)
				.join(', ')}\n`
		);

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
