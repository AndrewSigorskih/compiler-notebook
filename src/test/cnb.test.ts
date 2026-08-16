import * as assert from 'assert';
import { describe, test } from 'node:test';

import { CnbCell, FORMAT_VERSION, joinLines, parseCnb, splitLines, stringifyCnb } from '../cnb';

/** Values whose round-trip is easy to get subtly wrong. */
const AWKWARD_VALUES: readonly string[] = [
	'',
	'\n',
	'\n\n\n',
	'one line, no trailing newline',
	'trailing newline\n',
	'two\nlines\n',
	'blank line in the middle\n\nafter it\n',
	'trailing spaces   \n   leading spaces\n',
	'windows\r\nline\r\nendings\r\n',
	'a "quote", a \\backslash\\ and a \ttab\n',
	'unicode — em dash, emoji 🙂, ünïcödé\n',
	'```\nnested fence\n```\n'
];

describe('splitLines / joinLines', () => {
	test('a value survives the split and join unchanged', () => {
		for (const value of AWKWARD_VALUES) {
			assert.strictEqual(joinLines(splitLines(value)), value, JSON.stringify(value));
		}
	});

	test('lines keep their trailing newline, so the last line is unambiguous', () => {
		assert.deepStrictEqual(splitLines('a\nb\n'), ['a\n', 'b\n']);
		assert.deepStrictEqual(splitLines('a\nb'), ['a\n', 'b']);
		assert.deepStrictEqual(splitLines(''), []);
	});

	test('a plain string value is still accepted', () => {
		assert.strictEqual(joinLines('int main() {}\n'), 'int main() {}\n');
	});

	test('a missing or unusable value reads as empty', () => {
		assert.strictEqual(joinLines(undefined), '');
		assert.strictEqual(joinLines(null), '');
		assert.strictEqual(joinLines(42), '');
	});
});

describe('parseCnb / stringifyCnb', () => {
	const cells: CnbCell[] = [
		{ kind: 'markup', language: 'markdown', value: '# Demo\n\nProse.' },
		{ kind: 'code', language: 'toml', value: 'compiler = "g++"\nmode = "run"\n' },
		{
			kind: 'code',
			language: 'cpp',
			value: 'int main() {\n    return 0;\n}\n',
			metadata: { role: 'file', filename: 'main.cpp' }
		}
	];

	test('cells round-trip, metadata included', () => {
		assert.deepStrictEqual(parseCnb(stringifyCnb(cells)).cells, cells);
	});

	test('every awkward value round-trips through the file', () => {
		const awkward: CnbCell[] = AWKWARD_VALUES.map((value) => ({
			kind: 'code',
			language: 'cpp',
			value
		}));
		assert.deepStrictEqual(parseCnb(stringifyCnb(awkward)).cells, awkward);
	});

	test('writing is stable: a file that is opened and saved does not change', () => {
		// Without this, every notebook looks modified the moment it is opened.
		const once = stringifyCnb(cells);
		const twice = stringifyCnb([...parseCnb(once).cells]);
		assert.strictEqual(twice, once);
	});

	test('cell text is written one line per array entry', () => {
		const text = stringifyCnb([
			{ kind: 'code', language: 'cpp', value: 'int main() {\n    return 0;\n}\n' }
		]);
		assert.match(text, /"value": \[\n\s+"int main\(\) \{\\n",\n\s+"    return 0;\\n",\n\s+"\}\\n"\n/);
	});

	test('the format version is written', () => {
		assert.match(stringifyCnb([]), new RegExp(`"version": ${FORMAT_VERSION}`));
	});

	test('a file written before line arrays still reads', () => {
		const legacy = JSON.stringify({
			version: 1,
			cells: [
				{ kind: 'markup', language: 'markdown', value: '# Old\n' },
				{
					kind: 'code',
					language: 'cpp',
					value: 'int main() {}\n',
					metadata: { role: 'file', filename: 'main.cpp' }
				}
			]
		});

		assert.deepStrictEqual(parseCnb(legacy).cells, [
			{ kind: 'markup', language: 'markdown', value: '# Old\n' },
			{
				kind: 'code',
				language: 'cpp',
				value: 'int main() {}\n',
				metadata: { role: 'file', filename: 'main.cpp' }
			}
		]);
	});

	test('a mixture of both shapes in one file reads', () => {
		const mixed = JSON.stringify({
			version: 2,
			cells: [
				{ kind: 'code', language: 'cpp', value: ['a\n', 'b\n'] },
				{ kind: 'code', language: 'cpp', value: 'c\nd\n' }
			]
		});
		assert.deepStrictEqual(
			parseCnb(mixed).cells.map((cell) => cell.value),
			['a\nb\n', 'c\nd\n']
		);
	});

	test('an empty file is an empty notebook, not an error', () => {
		assert.deepStrictEqual(parseCnb('   \n'), { cells: [] });
	});

	test('malformed JSON reports an error instead of throwing', () => {
		const result = parseCnb('{ "cells": [ ');
		assert.strictEqual(result.cells.length, 0);
		assert.strictEqual(typeof result.error, 'string');
	});

	test('JSON that is not a notebook reports an error', () => {
		assert.match(parseCnb('{"hello": 1}').error ?? '', /no "cells" array/);
	});

	test('missing fields in a cell are defaulted, not fatal', () => {
		const result = parseCnb('{"cells":[{},{"kind":"markup"}]}');
		assert.deepStrictEqual(result.cells, [
			{ kind: 'code', language: 'plaintext', value: '' },
			{ kind: 'markup', language: 'plaintext', value: '' }
		]);
	});
});
