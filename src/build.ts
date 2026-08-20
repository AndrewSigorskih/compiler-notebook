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

import {
	binaryName,
	isCompilableFilename,
	languageConfig,
	LanguageConfig
} from './languages';
import { BuildSpec, CellLike, Project, ProjectFile } from './model';

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

/** Prefix of every build dir, so leftovers are recognisable (CLAUDE.md §10). */
export const BUILD_DIR_PREFIX = 'compiler-notebook-';

/** A binary that outlived its build, because the caller asked to keep it. */
export interface BuildArtifact {
	/** The build dir, now owned by the caller — including deleting it. */
	readonly dir: string;
	/** Absolute path of the produced binary. */
	readonly binary: string;
	/** Its name on disk: `app`, or `app.exe` on Windows. */
	readonly name: string;
}

export interface BuildOptions {
	/**
	 * Keep the build dir when a binary came out of it, and report it as
	 * `result.artifact`. Off by default: a build cleans up after itself unless
	 * someone takes responsibility for the dir.
	 */
	readonly keepBuildDir?: boolean;
}

export interface BuildResult {
	readonly success: boolean;
	readonly compileExitCode: number | null;
	readonly runExitCode?: number | null;
	readonly cancelled: boolean;
	/** Only set when `keepBuildDir` was asked for and a binary exists. */
	readonly artifact?: BuildArtifact;
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

/**
 * The file a `root`-input compiler is pointed at: rustc and zig take one file
 * and follow `mod`/`@import` from there.
 *
 * The entry point wins, by content and then by name, so a project whose cells
 * happen to be ordered helper-first still builds.
 */
export function selectRoot<T extends CellLike>(
	config: LanguageConfig,
	files: readonly ProjectFile<T>[]
): ProjectFile<T> | undefined {
	return (
		files.find((file) => config.mainPattern.test(file.cell.value)) ??
		files.find((file) => file.filename === `main${config.sourceExtension}`) ??
		files[0]
	);
}

export interface BuildCommand {
	readonly args: readonly string[];
	/** Files actually handed to the compiler. */
	readonly sources: readonly string[];
}

/**
 * Assemble the compiler command line for a project (CLAUDE.md §5).
 *
 * Everything language-specific comes out of the table: which files are inputs,
 * whether the compiler takes all of them or just a root, and how its arguments
 * are spelled.
 */
export function buildCommand<T extends CellLike>(
	spec: BuildSpec,
	files: readonly ProjectFile<T>[]
): BuildCommand {
	const config = spec.language === undefined ? undefined : languageConfig(spec.language);
	const compilable = files.filter((file) => isCompilableFilename(file.filename, config));

	let sources = compilable;
	if (config?.inputs === 'root') {
		const root = selectRoot(config, compilable);
		sources = root ? [root] : [];
	} else if (config?.inputs === 'flat') {
		sources = compilable.filter((file) => !file.filename.includes('/'));
	}

	const names = sources.map((file) => file.filename);
	const context = {
		flags: spec.flags,
		sources: names,
		output: spec.output,
		binary: binaryName(spec.output)
	};

	return {
		args: config ? config.buildArgs(context) : dashOStyleFallback(context),
		sources: names
	};
}

/** Used when a project's language is not in the table at all. */
function dashOStyleFallback(context: {
	flags: readonly string[];
	sources: readonly string[];
	binary: string;
}): string[] {
	return [...context.flags, ...context.sources, '-o', context.binary];
}

/** Cleanup must never fail a build, so every removal is best-effort. */
export async function removeBuildDir(dir: string): Promise<void> {
	await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

async function describeArtifact(dir: string, spec: BuildSpec): Promise<BuildArtifact | undefined> {
	// The compiler exiting 0 is not proof that the file we expect exists — a
	// buildspec can pass flags that change or suppress the output.
	const name = binaryName(spec.output);
	const binary = path.join(dir, name);
	try {
		const stat = await fs.stat(binary);
		return stat.isFile() ? { dir, binary, name } : undefined;
	} catch {
		return undefined;
	}
}

export async function buildAndRun<T extends CellLike>(
	project: Project<T>,
	sink: OutputSink,
	token: CancelToken,
	options: BuildOptions = {}
): Promise<BuildResult> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), BUILD_DIR_PREFIX));
	let result: BuildResult;
	try {
		result = await buildAndRunIn(dir, project, sink, token, options);
	} catch (err) {
		await removeBuildDir(dir);
		throw err;
	}

	// The dir survives only when someone is taking it: an artifact handed back is
	// a transfer of ownership, anything else is cleaned up here as always.
	if (!result.artifact) {
		await removeBuildDir(dir);
	}
	return result;
}

async function buildAndRunIn<T extends CellLike>(
	dir: string,
	project: Project<T>,
	sink: OutputSink,
	token: CancelToken,
	options: BuildOptions
): Promise<BuildResult> {
	const { spec, files } = project;

	for (const file of files) {
		// Filenames are sanitised to a relative path by the resolver, but a
		// sub-directory still has to exist before the write.
		const target = path.join(dir, ...file.filename.split('/'));
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, file.cell.value, 'utf8');
	}
	sink.info(`$ cd ${dir}\n`);

	// Headers, imported modules and data files live in the dir so `#include`,
	// `@import` and runtime reads work; only what the compiler is meant to be
	// pointed at goes on the command line.
	const { args, sources } = buildCommand(spec, files);
	if (sources.length === 0) {
		sink.stderr(
			files.length === 0
				? 'This project has no file cells; add a source cell below the buildspec.\n'
				: `None of this project's ${files.length} file(s) are compilable source files.\n`
		);
		return { success: false, compileExitCode: null, cancelled: false };
	}

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

	// Worked out once, here: from this point on every exit path has a binary to
	// hand back, including a run that fails or is cancelled — a program that
	// crashes is exactly one someone may want to keep and debug.
	const artifact = options.keepBuildDir ? await describeArtifact(dir, spec) : undefined;

	if (spec.mode === 'build') {
		sink.info('\nCompilation succeeded.\n');
		return { success: true, compileExitCode: 0, cancelled: false, artifact };
	}

	const exePath = path.join(dir, binaryName(spec.output));
	sink.info(`\n$ ./${binaryName(spec.output)}\n`);

	const run = await runProcess(exePath, [], dir, sink, token);
	if (run.spawnError) {
		sink.stderr(`Failed to start the produced binary: ${run.spawnError.message}\n`);
		return {
			success: false,
			compileExitCode: 0,
			runExitCode: null,
			cancelled: run.cancelled,
			artifact
		};
	}
	if (run.cancelled) {
		sink.info('\nRun cancelled.\n');
		return {
			success: false,
			compileExitCode: 0,
			runExitCode: run.exitCode,
			cancelled: true,
			artifact
		};
	}

	sink.info(`\n[exit code ${run.exitCode ?? `signal ${run.signal}`}]\n`);
	return {
		success: run.exitCode === 0,
		compileExitCode: 0,
		runExitCode: run.exitCode,
		cancelled: false,
		artifact
	};
}
