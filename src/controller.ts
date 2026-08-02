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

		// Diagnostics are reported on the cell they belong to, so they can be
		// routed to the project that owns that cell.
		const messagesFor = new Map<vscode.NotebookCell, string[]>();
		for (const diagnostic of diagnostics) {
			const cell = diagnostic.cell.cell;
			const existing = messagesFor.get(cell);
			if (existing) {
				existing.push(diagnostic.message);
			} else {
				messagesFor.set(cell, [diagnostic.message]);
			}
		}

		// Which project owns each executed cell.
		const ownerOf = new Map<vscode.NotebookCell, Project<CellAdapter>>();
		for (const project of projects) {
			ownerOf.set(project.specCell.cell, project);
			for (const file of project.files) {
				ownerOf.set(file.cell.cell, project);
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
			this.reportSkipped(cell, messagesFor.get(cell) ?? []);
		}

		for (const [project, requested] of pending) {
			// Output always lands on the buildspec cell, whichever cell was run.
			const primary = project.specCell.cell;
			const secondary = requested.filter((cell) => cell !== primary);
			await this.buildProject(project, primary, secondary, messagesFor);
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
		messagesFor: ReadonlyMap<vscode.NotebookCell, string[]>
	): Promise<void> {
		const execution = this.controller.createNotebookCellExecution(primary);
		execution.executionOrder = ++this.executionOrder;
		execution.start(Date.now());

		const output = new vscode.NotebookCellOutput([]);
		await execution.replaceOutput(output);
		const sink = new ExecutionSink(execution, output);

		// Phase 4 moves these onto a DiagnosticCollection; for now they are at
		// least visible instead of silent.
		const cells = [project.specCell.cell, ...project.files.map((file) => file.cell.cell)];
		for (const cell of cells) {
			for (const message of messagesFor.get(cell) ?? []) {
				sink.stderr(`warning: ${message}\n`);
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
