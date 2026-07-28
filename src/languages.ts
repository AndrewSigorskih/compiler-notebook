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
}

export const LANGUAGES: Readonly<Record<string, LanguageConfig>> = {
	cpp: { sourceExtension: '.cpp', headerExtension: '.hpp', defaultCompiler: 'g++' },
	c: { sourceExtension: '.c', headerExtension: '.h', defaultCompiler: 'gcc' },
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

/**
 * Headers are written into the build dir so `#include` finds them, but must not
 * be handed to the compiler as translation units.
 */
const HEADER_EXTENSIONS: ReadonlySet<string> = new Set([
	'.h',
	'.hpp',
	'.hh',
	'.hxx',
	'.h++',
	'.inl',
	'.ipp',
	'.tpp'
]);

export function isHeaderFilename(filename: string): boolean {
	const dot = filename.lastIndexOf('.');
	return dot > 0 && HEADER_EXTENSIONS.has(filename.slice(dot).toLowerCase());
}
