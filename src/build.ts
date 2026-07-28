/**
 * Build + run a project in a fresh, isolated temp dir (CLAUDE.md §5).
 *
 * Deliberately free of `vscode` imports: output is pushed through a sink so the
 * controller owns all notebook-output concerns.
 */

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { isHeaderFilename } from './languages';
import { CellLike, Project } from './model';

export interface OutputSink {
	/** Extension-generated chatter: command lines, exit codes, notices. */
	info(text: string): void;
	stdout(chunk: string): void;
	stderr(chunk: string): void;
}

export interface CancelToken {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface BuildResult {
	readonly success: boolean;
	readonly compileExitCode: number | null;
	readonly runExitCode?: number | null;
	readonly cancelled: boolean;
}

interface SpawnResult {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly cancelled: boolean;
	readonly spawnError?: Error;
}

function runProcess(
	command: string,
	args: readonly string[],
	cwd: string,
	sink: OutputSink,
	token: CancelToken
): Promise<SpawnResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { cwd });
		let cancelled = false;

		const subscription = token.onCancellationRequested(() => {
			cancelled = true;
			child.kill('SIGTERM');
			// Escalate if the child ignores SIGTERM.
			setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
		});

		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => sink.stdout(chunk));
		child.stderr.on('data', (chunk: string) => sink.stderr(chunk));

		child.on('error', (err) => {
			subscription.dispose();
			resolve({ exitCode: null, signal: null, cancelled, spawnError: err });
		});

		child.on('close', (code, signal) => {
			subscription.dispose();
			resolve({ exitCode: code, signal, cancelled });
		});
	});
}

function quoteArg(arg: string): string {
	return /[\s"'\\]/.test(arg) ? JSON.stringify(arg) : arg;
}

function formatCommand(command: string, args: readonly string[]): string {
	return [command, ...args].map(quoteArg).join(' ');
}

function binaryName(output: string): string {
	return process.platform === 'win32' ? `${output}.exe` : output;
}

/** Compiler args: `<compiler> <flags...> <sources...> -o <output>` (CLAUDE.md §5). */
export function compilerArgs(
	flags: readonly string[],
	sources: readonly string[],
	output: string
): string[] {
	return [...flags, ...sources, '-o', binaryName(output)];
}

export async function buildAndRun<T extends CellLike>(
	project: Project<T>,
	sink: OutputSink,
	token: CancelToken
): Promise<BuildResult> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compiler-notebook-'));
	try {
		return await buildAndRunIn(dir, project, sink, token);
	} finally {
		// Survive leftover dirs: cleanup failure must never fail the build.
		await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function buildAndRunIn<T extends CellLike>(
	dir: string,
	project: Project<T>,
	sink: OutputSink,
	token: CancelToken
): Promise<BuildResult> {
	const { spec, files } = project;

	for (const file of files) {
		await fs.writeFile(path.join(dir, file.filename), file.cell.value, 'utf8');
	}
	sink.info(`$ cd ${dir}\n`);

	// Headers live in the dir for `#include`, but are not compile inputs.
	const sources = files.map((f) => f.filename).filter((name) => !isHeaderFilename(name));
	if (sources.length === 0) {
		sink.stderr('No compilable source files in this project (headers only).\n');
		return { success: false, compileExitCode: null, cancelled: false };
	}

	const args = compilerArgs(spec.flags, sources, spec.output);
	sink.info(`$ ${formatCommand(spec.compiler, args)}\n`);

	if (token.isCancellationRequested) {
		return { success: false, compileExitCode: null, cancelled: true };
	}

	const compile = await runProcess(spec.compiler, args, dir, sink, token);
	if (compile.spawnError) {
		sink.stderr(`Failed to start "${spec.compiler}": ${compile.spawnError.message}\n`);
		return { success: false, compileExitCode: null, cancelled: compile.cancelled };
	}
	if (compile.cancelled) {
		sink.info('\nCompilation cancelled.\n');
		return { success: false, compileExitCode: compile.exitCode, cancelled: true };
	}
	if (compile.exitCode !== 0) {
		sink.info(`\nCompilation failed with exit code ${compile.exitCode ?? compile.signal}.\n`);
		return { success: false, compileExitCode: compile.exitCode, cancelled: false };
	}

	if (spec.mode === 'build') {
		sink.info('\nCompilation succeeded.\n');
		return { success: true, compileExitCode: 0, cancelled: false };
	}

	const exePath = path.join(dir, binaryName(spec.output));
	sink.info(`\n$ ./${binaryName(spec.output)}\n`);

	const run = await runProcess(exePath, [], dir, sink, token);
	if (run.spawnError) {
		sink.stderr(`Failed to start the produced binary: ${run.spawnError.message}\n`);
		return { success: false, compileExitCode: 0, runExitCode: null, cancelled: run.cancelled };
	}
	if (run.cancelled) {
		sink.info('\nRun cancelled.\n');
		return { success: false, compileExitCode: 0, runExitCode: run.exitCode, cancelled: true };
	}

	sink.info(`\n[exit code ${run.exitCode ?? `signal ${run.signal}`}]\n`);
	return {
		success: run.exitCode === 0,
		compileExitCode: 0,
		runExitCode: run.exitCode,
		cancelled: false
	};
}
