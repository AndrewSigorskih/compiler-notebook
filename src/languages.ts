/**
 * Single per-language config table (CLAUDE.md §10).
 *
 * Adding a language must be a data change here, never new logic elsewhere.
 */

export interface LanguageConfig {
	/** Extension used for a translation unit. */
	readonly sourceExtension: string;
	/** Extension used for a header-like cell, if the language has such a thing. */
	readonly headerExtension?: string;
	/** Compiler assumed when a buildspec does not name one. */
	readonly defaultCompiler: string;
	/** Flags assumed when a buildspec does not list any. */
	readonly defaultFlags?: readonly string[];
}

export const LANGUAGES: Readonly<Record<string, LanguageConfig>> = {
	cpp: {
		sourceExtension: '.cpp',
		headerExtension: '.hpp',
		defaultCompiler: 'g++',
		defaultFlags: ['-std=c++20', '-O2', '-Wall', '-Wextra']
	},
	c: {
		sourceExtension: '.c',
		headerExtension: '.h',
		defaultCompiler: 'gcc',
		defaultFlags: ['-std=c17', '-O2', '-Wall', '-Wextra']
	},
	rust: { sourceExtension: '.rs', defaultCompiler: 'rustc' },
	zig: { sourceExtension: '.zig', defaultCompiler: 'zig' }
};

/** languageId values that represent a source file cell. */
export const SOURCE_LANGUAGE_IDS: readonly string[] = Object.keys(LANGUAGES);

export function isSourceLanguage(languageId: string): boolean {
	return Object.prototype.hasOwnProperty.call(LANGUAGES, languageId);
}

export function languageConfig(languageId: string): LanguageConfig | undefined {
	return LANGUAGES[languageId];
}

/** Extensions the compiler accepts as translation units. */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(
	Object.values(LANGUAGES).map((config) => config.sourceExtension)
);

export function fileExtension(filename: string): string {
	const base = filename.slice(filename.lastIndexOf('/') + 1);
	const dot = base.lastIndexOf('.');
	return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/**
 * Which project files become compiler inputs.
 *
 * Selected by extension rather than by excluding headers: headers, data files
 * and anything else still land in the build dir so `#include` and runtime file
 * reads work, but only translation units are passed on the command line.
 */
export function isCompilableFilename(filename: string): boolean {
	return SOURCE_EXTENSIONS.has(fileExtension(filename));
}
