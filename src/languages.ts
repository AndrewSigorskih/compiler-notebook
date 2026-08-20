/**
 * Single per-language config table (CLAUDE.md §10).
 *
 * Adding a language must be a data change here, never new logic elsewhere — so
 * the things languages genuinely disagree about live in this table as data:
 * which files the compiler accepts, how many of them it takes at once, how its
 * command line is spelled, and what its entry point looks like.
 */

export type CompilerInputs =
	/** Every translation unit goes on the command line (C, C++). */
	| 'all'
	/** One root file; the rest are pulled in by the language (Rust, Zig). */
	| 'root'
	/**
	 * Every translation unit in the build-dir root, and only those (Go): the
	 * compiler refuses a file list spanning directories, since a sub-directory is
	 * a separate package it expects to resolve by import instead.
	 */
	| 'flat';

export interface CompileContext {
	readonly flags: readonly string[];
	/** Files to compile, already narrowed according to `inputs`. */
	readonly sources: readonly string[];
	/** Binary name as the buildspec asked for it. */
	readonly output: string;
	/** Binary name as it lands on disk (`.exe` on Windows). */
	readonly binary: string;
}

export interface LanguageConfig {
	/** Extension used for a translation unit. */
	readonly sourceExtension: string;
	/** Extension used for a header-like cell, if the language has such a thing. */
	readonly headerExtension?: string;
	/** Compiler assumed when a buildspec does not name one. */
	readonly defaultCompiler: string;
	/** Flags assumed when a buildspec does not list any. */
	readonly defaultFlags?: readonly string[];
	/** Extensions this compiler accepts as input. */
	readonly compileExtensions: readonly string[];
	readonly inputs: CompilerInputs;
	/** Recognises an entry-point cell: drives auto-naming and root selection. */
	readonly mainPattern: RegExp;
	buildArgs(context: CompileContext): string[];
}

/** `<compiler> <flags...> <sources...> -o <binary>` — gcc, clang, rustc. */
function dashOStyle(context: CompileContext): string[] {
	return [...context.flags, ...context.sources, '-o', context.binary];
}

export const LANGUAGES: Readonly<Record<string, LanguageConfig>> = {
	cpp: {
		sourceExtension: '.cpp',
		headerExtension: '.hpp',
		defaultCompiler: 'g++',
		defaultFlags: ['-std=c++20', '-O2', '-Wall', '-Wextra'],
		// A C++ project may legitimately include C translation units.
		compileExtensions: ['.cpp', '.c'],
		inputs: 'all',
		mainPattern: /\bint\s+main\s*\(/,
		buildArgs: dashOStyle
	},
	c: {
		sourceExtension: '.c',
		headerExtension: '.h',
		defaultCompiler: 'gcc',
		defaultFlags: ['-std=c17', '-O2', '-Wall', '-Wextra'],
		compileExtensions: ['.c'],
		inputs: 'all',
		mainPattern: /\bint\s+main\s*\(/,
		buildArgs: dashOStyle
	},
	rust: {
		sourceExtension: '.rs',
		defaultCompiler: 'rustc',
		// rustc without an edition flag is still 2015; 2021 is the newest edition
		// every currently-shipping toolchain accepts.
		defaultFlags: ['--edition=2021', '-O'],
		compileExtensions: ['.rs'],
		// rustc takes the crate root; `mod util;` pulls in util.rs beside it.
		inputs: 'root',
		mainPattern: /\bfn\s+main\s*\(/,
		buildArgs: dashOStyle
	},
	zig: {
		sourceExtension: '.zig',
		defaultCompiler: 'zig',
		defaultFlags: [],
		compileExtensions: ['.zig'],
		// zig takes the root file; `@import("util.zig")` pulls in the rest.
		inputs: 'root',
		mainPattern: /\bpub\s+fn\s+main\s*\(/,
		// `zig build-exe main.zig --name app`: a subcommand, and no `-o`.
		buildArgs: (context) => [
			'build-exe',
			...context.flags,
			...context.sources,
			'--name',
			context.output
		]
	},
	go: {
		sourceExtension: '.go',
		defaultCompiler: 'go',
		// Go has no optimisation or standard-version flags: the toolchain version
		// decides both, and `go.mod` states the language version when there is one.
		defaultFlags: [],
		compileExtensions: ['.go'],
		// `go build a.go b.go` insists every named file live in one directory, so
		// only the build-dir root goes on the command line. A sub-directory is a
		// separate package, reached by import once the project has a `go.mod` cell.
		inputs: 'flat',
		mainPattern: /\bfunc\s+main\s*\(/,
		// `go build -o app main.go`: a subcommand, and `-o` must come before the
		// file list — after it, go reads the flag as another source file.
		buildArgs: (context) => ['build', ...context.flags, '-o', context.binary, ...context.sources]
	}
};

/** languageId values that represent a source file cell. */
export const SOURCE_LANGUAGE_IDS: readonly string[] = Object.keys(LANGUAGES);

export function isSourceLanguage(languageId: string): boolean {
	return Object.prototype.hasOwnProperty.call(LANGUAGES, languageId);
}

export function languageConfig(languageId: string): LanguageConfig | undefined {
	return LANGUAGES[languageId];
}

/** Extensions any of the known compilers accept as translation units. */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(
	Object.values(LANGUAGES).map((config) => config.sourceExtension)
);

export function fileExtension(filename: string): string {
	const base = filename.slice(filename.lastIndexOf('/') + 1);
	const dot = base.lastIndexOf('.');
	return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/**
 * Which project files can be compiler inputs.
 *
 * Selected by extension rather than by excluding headers: headers, data files
 * and anything else still land in the build dir so `#include`, `@import` and
 * runtime file reads work, but only translation units are passed on the command
 * line. With a `config`, only extensions *that* compiler accepts count — a `.rs`
 * cell must not be handed to `g++`.
 */
export function isCompilableFilename(filename: string, config?: LanguageConfig): boolean {
	const extension = fileExtension(filename);
	return config
		? config.compileExtensions.includes(extension)
		: SOURCE_EXTENSIONS.has(extension);
}

/** The binary name on disk for a requested output name. */
export function binaryName(output: string): string {
	return process.platform === 'win32' ? `${output}.exe` : output;
}
