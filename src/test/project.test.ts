import * as assert from 'assert';
import { test, describe } from 'node:test';

import { CellLike } from '../model';
import { autoFilename, classifyCell, filenameDirective, resolveProjects } from '../project';

function code(languageId: string, value: string, metadata?: Record<string, unknown>): CellLike {
	return { kind: 'code', languageId, value, metadata };
}

function markup(value: string): CellLike {
	return { kind: 'markup', languageId: 'markdown', value };
}

describe('classifyCell', () => {
	test('markup cells are markup', () => {
		assert.strictEqual(classifyCell(markup('# hi')), 'markup');
	});

	test('toml code cells are buildspecs', () => {
		assert.strictEqual(classifyCell(code('toml', 'compiler = "g++"')), 'buildspec');
	});

	test('source code cells are file cells', () => {
		assert.strictEqual(classifyCell(code('cpp', 'int main() {}')), 'file');
		assert.strictEqual(classifyCell(code('rust', 'fn main() {}')), 'file');
	});

	test('unknown languages are neither', () => {
		assert.strictEqual(classifyCell(code('python', 'print(1)')), 'other');
	});
});

describe('filenameDirective', () => {
	test('reads a leading @file comment', () => {
		assert.strictEqual(filenameDirective('// @file matrix.hpp\n#pragma once\n'), 'matrix.hpp');
	});

	test('ignores directives that are not on the first line', () => {
		assert.strictEqual(filenameDirective('#pragma once\n// @file matrix.hpp\n'), undefined);
	});
});

describe('autoFilename', () => {
	test('a cell with main() becomes main.<ext>', () => {
		assert.strictEqual(autoFilename(code('cpp', 'int main() { return 0; }'), 3), 'main.cpp');
	});

	test('a header-like cell gets the header extension', () => {
		assert.strictEqual(autoFilename(code('cpp', '#pragma once\nvoid f();'), 1), 'unit_1.hpp');
	});

	test('anything else is unit_<index>.<ext>', () => {
		assert.strictEqual(autoFilename(code('cpp', 'void f() {}'), 2), 'unit_2.cpp');
	});
});

describe('resolveProjects (phase 1: whole notebook is one project)', () => {
	test('no source cells means nothing to build', () => {
		const result = resolveProjects([markup('# hi'), code('toml', 'compiler = "g++"')]);
		assert.strictEqual(result.projects.length, 0);
	});

	test('collects source cells and ignores markup and buildspecs', () => {
		const result = resolveProjects([
			markup('# demo'),
			code('toml', 'compiler = "g++"'),
			code('cpp', '#pragma once\nvoid f();', { filename: 'f.hpp' }),
			code('cpp', 'int main() { return 0; }')
		]);

		assert.strictEqual(result.projects.length, 1);
		assert.deepStrictEqual(
			result.projects[0].files.map((f) => f.filename),
			['f.hpp', 'main.cpp']
		);
		assert.strictEqual(result.diagnostics.length, 0);
	});

	test('explicit metadata beats the @file directive', () => {
		const result = resolveProjects([
			code('cpp', '// @file directive.cpp\nint main() {}', { filename: 'explicit.cpp' })
		]);
		assert.strictEqual(result.projects[0].files[0].filename, 'explicit.cpp');
	});

	test('colliding filenames are suffixed and reported', () => {
		const result = resolveProjects([
			code('cpp', 'int main() { return 0; }'),
			code('cpp', 'int main() { return 1; }')
		]);

		assert.deepStrictEqual(
			result.projects[0].files.map((f) => f.filename),
			['main.cpp', 'main_2.cpp']
		);
		assert.strictEqual(result.diagnostics.length, 1);
		assert.match(result.diagnostics[0].message, /Duplicate filename "main\.cpp"/);
	});
});
