/**
 * The "kernel": resolves the owning project of every executed cell, builds each
 * distinct project once, and streams compiler/program output (CLAUDE.md §5).
 */

import * as vscode from 'vscode';

import { buildAndRun } from './build';
import { NotebookDiagnostics } from './diagnostics';
import { NOTEBOOK_TYPE, Project } from './model';
import { CellAdapter, resolveNotebook } from './notebook';
import { StreamKind, StreamTarget, TruncatingSink } from './output';

const CONTROLLER_ID = 'compiler-notebook-controller';

/**
 * Streams text into cell outputs, serialising the appends so chunks land in the
 * order they were produced.
 *
 * One `NotebookCellOutput` holds *alternative representations* of a single
 * output, so putting a stdout item and a stderr item in the same one makes the
 * renderer choose between them — and silently drop the compiler's diagnostics.
 * Each switch between the two streams therefore starts a new output, and each
 * output only ever holds one item, whose text is replaced as it grows.
 */
class CellOutputTarget implements StreamTarget {
	private queue: Promise<unknown> = Promise.resolve();
	private current: { kind: StreamKind; output: vscode.NotebookCellOutput; text: string } | undefined;

	constructor(private readonly execution: vscode.NotebookCellExecution) {}

	write(kind: StreamKind, text: string): void {
		if (text.length === 0) {
			return;
		}

		if (this.current?.kind === kind) {
			const run = this.current;
			run.text += text;
			const item = itemFor(kind, run.text);
			this.enqueue(() => this.execution.replaceOutputItems(item, run.output));
			return;
		}

		const output = new vscode.NotebookCellOutput([itemFor(kind, text)]);
		this.current = { kind, output, text };
		this.enqueue(() => this.execution.appendOutput(output));
	}

	private enqueue(work: () => Thenable<unknown>): void {
		// A failed append must not break the chain: the build still has to end.
		this.queue = this.queue.then(work).then(undefined, () => undefined);
	}

	flush(): Promise<unknown> {
		return this.queue;
	}
}

function itemFor(kind: StreamKind, text: string): vscode.NotebookCellOutputItem {
	return kind === 'stderr'
		? vscode.NotebookCellOutputItem.stderr(text)
		: vscode.NotebookCellOutputItem.stdout(text);
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
		const { ownerOf, diagnosticsOf } = resolveNotebook(notebook);
		// The squiggles are refreshed on a debounce; a run should not report
		// anything the editor is not already showing.
		this.diagnostics.refresh(notebook);

		// A file cell that belongs to no project is a notebook-wide problem: the
		// build it was meant to be part of just quietly misses a file, and the
		// compiler error that follows never mentions it. Say so on every build.
		const strays: string[] = [];
		for (const cell of notebook.getCells()) {
			if (ownerOf.has(cell)) {
				continue;
			}
			for (const problem of diagnosticsOf.get(cell) ?? []) {
				strays.push(problem.message);
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
			this.reportSkipped(
				cell,
				(diagnosticsOf.get(cell) ?? []).map((problem) => problem.message)
			);
		}

		for (const [project, requested] of pending) {
			// Output always lands on the buildspec cell, whichever cell was run.
			const primary = project.specCell.cell;
			const secondary = requested.filter((cell) => cell !== primary);
			await this.buildProject(project, primary, secondary, diagnosticsOf, strays);
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
		diagnosticsOf: ReadonlyMap<vscode.NotebookCell, readonly { message: string }[]>,
		strays: readonly string[]
	): Promise<void> {
		const execution = this.controller.createNotebookCellExecution(primary);
		execution.executionOrder = ++this.executionOrder;
		execution.start(Date.now());

		await execution.clearOutput();
		const target = new CellOutputTarget(execution);
		const sink = new TruncatingSink(target);

		// Also squiggled in the editor, but repeated here so the output is a
		// complete record of what this build actually did.
		const cells = [project.specCell.cell, ...project.files.map((file) => file.cell.cell)];
		for (const cell of cells) {
			for (const problem of diagnosticsOf.get(cell) ?? []) {
				sink.stderr(`warning: ${problem.message}\n`);
			}
		}
		for (const stray of strays) {
			sink.stderr(`warning: ${stray}\n`);
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
			sink.info(`Internal error: ${err instanceof Error ? err.stack : String(err)}\n`);
		}

		sink.finish();
		await target.flush();
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
