/**
 * Buildspec cells: a small TOML config that opens a project (CLAUDE.md §4).
 *
 * Parsing is deliberately tolerant — unknown keys warn, bad values warn and fall
 * back to a default, nothing throws. A malformed buildspec must still produce a
 * usable project, because the alternative is a notebook that refuses to build.
 *
 * This is a subset parser, not a TOML implementation: top-level `key = value`
 * with strings, booleans, numbers and (possibly multi-line) arrays. That is the
 * whole schema in §4, and it keeps the extension dependency-free.
 */

import { languageConfig } from './languages';
import { BuildMode, BuildSpec, PartialBuildSpec } from './model';

export type TomlValue = string | number | boolean | TomlValue[];

export interface TomlParse {
	readonly entries: ReadonlyMap<string, TomlValue>;
	readonly warnings: readonly string[];
}

export interface SpecParse {
	readonly partial: PartialBuildSpec;
	readonly warnings: readonly string[];
}

const BARE_KEY = /[A-Za-z0-9_-]/;

class Scanner {
	private pos = 0;

	constructor(private readonly text: string) {}

	get done(): boolean {
		return this.pos >= this.text.length;
	}

	peek(): string {
		return this.text[this.pos] ?? '';
	}

	next(): string {
		return this.text[this.pos++] ?? '';
	}

	/** Skip whitespace, newlines and `#` comments. */
	skipTrivia(): void {
		for (;;) {
			const ch = this.peek();
			if (ch === '#') {
				while (!this.done && this.peek() !== '\n') {
					this.pos++;
				}
			} else if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
				this.pos++;
			} else {
				return;
			}
		}
	}

	/** Skip inline whitespace and comments, but stop at a newline. */
	skipInlineTrivia(): void {
		for (;;) {
			const ch = this.peek();
			if (ch === '#') {
				while (!this.done && this.peek() !== '\n') {
					this.pos++;
				}
			} else if (ch === ' ' || ch === '\t' || ch === '\r') {
				this.pos++;
			} else {
				return;
			}
		}
	}

	skipLine(): void {
		while (!this.done && this.next() !== '\n') {
			/* discard */
		}
	}

	readBareKey(): string {
		const start = this.pos;
		while (!this.done && BARE_KEY.test(this.peek())) {
			this.pos++;
		}
		return this.text.slice(start, this.pos);
	}

	/** Reads a token up to the next whitespace, comma, bracket or newline. */
	readBareToken(): string {
		const start = this.pos;
		while (!this.done && !/[\s,\]#]/.test(this.peek())) {
			this.pos++;
		}
		return this.text.slice(start, this.pos);
	}
}

const ESCAPES: Readonly<Record<string, string>> = {
	n: '\n',
	t: '\t',
	r: '\r',
	'"': '"',
	"'": "'",
	'\\': '\\'
};

/** Reads a quoted string; literal (`'`) strings do not process escapes. */
function readString(scanner: Scanner, quote: string): string {
	let out = '';
	while (!scanner.done) {
		const ch = scanner.next();
		if (ch === quote) {
			return out;
		}
		if (ch === '\n') {
			// Unterminated: treat the newline as the end rather than eating the
			// rest of the document.
			return out;
		}
		if (ch === '\\' && quote === '"') {
			const escaped = scanner.next();
			out += ESCAPES[escaped] ?? escaped;
			continue;
		}
		out += ch;
	}
	return out;
}

function readValue(scanner: Scanner, warnings: string[]): TomlValue | undefined {
	scanner.skipInlineTrivia();
	const ch = scanner.peek();

	if (ch === '"' || ch === "'") {
		scanner.next();
		return readString(scanner, ch);
	}

	if (ch === '[') {
		scanner.next();
		const items: TomlValue[] = [];
		for (;;) {
			scanner.skipTrivia();
			if (scanner.done) {
				warnings.push('unterminated array in buildspec');
				return items;
			}
			if (scanner.peek() === ']') {
				scanner.next();
				return items;
			}
			if (scanner.peek() === ',') {
				scanner.next();
				continue;
			}
			const item = readValue(scanner, warnings);
			if (item === undefined) {
				// Nothing consumable here; drop a char so we cannot spin.
				scanner.next();
				continue;
			}
			items.push(item);
		}
	}

	if (ch === '' || ch === '\n') {
		return undefined;
	}

	const token = scanner.readBareToken();
	if (token.length === 0) {
		return undefined;
	}
	if (token === 'true') {
		return true;
	}
	if (token === 'false') {
		return false;
	}
	const num = Number(token);
	return Number.isNaN(num) ? token : num;
}

export function parseToml(text: string): TomlParse {
	const scanner = new Scanner(text);
	const entries = new Map<string, TomlValue>();
	const warnings: string[] = [];

	for (;;) {
		scanner.skipTrivia();
		if (scanner.done) {
			break;
		}

		if (scanner.peek() === '[') {
			warnings.push('TOML tables are not used by buildspecs; the section header was ignored');
			scanner.skipLine();
			continue;
		}

		const key = scanner.readBareKey();
		if (key.length === 0) {
			// Not a key/value line at all — skip it rather than stall.
			scanner.skipLine();
			continue;
		}

		scanner.skipInlineTrivia();
		if (scanner.peek() !== '=') {
			warnings.push(`expected "=" after key "${key}"`);
			scanner.skipLine();
			continue;
		}
		scanner.next();

		const value = readValue(scanner, warnings);
		if (value === undefined) {
			warnings.push(`key "${key}" has no value`);
			continue;
		}
		if (entries.has(key)) {
			warnings.push(`duplicate key "${key}"; the last value wins`);
		}
		entries.set(key, value);
	}

	return { entries, warnings };
}

const KNOWN_KEYS: readonly string[] = ['compiler', 'flags', 'mode', 'output'];

function asString(value: TomlValue): string | undefined {
	if (typeof value === 'string') {
		return value;
	}
	return typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}

/** Parses a buildspec cell body into the keys it actually specified. */
export function parseBuildSpec(text: string): SpecParse {
	const { entries, warnings: parseWarnings } = parseToml(text);
	const warnings = [...parseWarnings];
	const partial: {
		compiler?: string;
		flags?: string[];
		mode?: BuildMode;
		output?: string;
	} = {};

	for (const key of entries.keys()) {
		if (!KNOWN_KEYS.includes(key)) {
			warnings.push(`unknown buildspec key "${key}" (ignored)`);
		}
	}

	const compiler = entries.get('compiler');
	if (compiler !== undefined) {
		const name = asString(compiler)?.trim();
		if (name && name.length > 0) {
			partial.compiler = name;
		} else {
			warnings.push('"compiler" must be a string; using the language default');
		}
	}

	const flags = entries.get('flags');
	if (flags !== undefined) {
		if (Array.isArray(flags)) {
			const items: string[] = [];
			for (const flag of flags) {
				const text = asString(flag);
				if (text === undefined) {
					warnings.push('"flags" entries must be strings; a nested value was ignored');
				} else {
					items.push(text);
				}
			}
			partial.flags = items;
		} else {
			const single = asString(flags);
			warnings.push('"flags" should be an array of strings');
			if (single !== undefined && single.length > 0) {
				partial.flags = single.split(/\s+/);
			}
		}
	}

	const mode = entries.get('mode');
	if (mode !== undefined) {
		const text = asString(mode);
		if (text === 'build' || text === 'run') {
			partial.mode = text;
		} else {
			warnings.push(`"mode" must be "build" or "run" (got ${JSON.stringify(mode)}); using "run"`);
		}
	}

	const output = entries.get('output');
	if (output !== undefined) {
		const name = asString(output)?.trim();
		if (!name || name.length === 0) {
			warnings.push('"output" must be a non-empty string; using the default');
		} else if (/[\\/]/.test(name) || name === '.' || name === '..') {
			// The binary is written into the build dir; a path would escape it.
			warnings.push(`"output" must be a plain file name (got "${name}"); using the default`);
		} else {
			partial.output = name;
		}
	}

	return { partial, warnings };
}

export const DEFAULT_MODE: BuildMode = 'run';
export const DEFAULT_OUTPUT = 'app';
export const FALLBACK_COMPILER = 'g++';

/**
 * Fill a partial spec in. Missing `compiler`/`flags` come from the per-language
 * table (CLAUDE.md §10), keyed on the language of the project's source cells.
 */
export function resolveSpec(partial: PartialBuildSpec, languageId: string | undefined): BuildSpec {
	const config = languageId === undefined ? undefined : languageConfig(languageId);
	return {
		compiler: partial.compiler ?? config?.defaultCompiler ?? FALLBACK_COMPILER,
		flags: partial.flags ?? config?.defaultFlags ?? [],
		mode: partial.mode ?? DEFAULT_MODE,
		output: partial.output ?? DEFAULT_OUTPUT
	};
}
