import * as assert from 'assert';
import { test, describe } from 'node:test';

import { CellLike } from '../model';
import { autoFilename, classifyCell, resolveProjects, sanitizeFilename } from '../project';

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

	test('a named cell of any language is an asset file cell', () => {
		assert.strictEqual(classifyCell(code('json', '{}', { filename: 'data.json' })), 'file');
		assert.strictEqual(
			classifyCell(code('plaintext', 'notes', { filename: 'notes.txt' })),
			'file'
		);
	});

	test('an unnamed cell of an unknown language stays out of the project', () => {
		assert.strictEqual(classifyCell(code('plaintext', 'just some text')), 'other');
	});
});

describe('sanitizeFilename', () => {
	test('a plain name is left alone', () => {
		assert.deepStrictEqual(sanitizeFilename('main.cpp'), { filename: 'main.cpp' });
	});

	test('sub-directories are allowed and normalised', () => {
		assert.deepStrictEqual(sanitizeFilename('./src//util.cpp'), { filename: 'src/util.cpp' });
		assert.deepStrictEqual(sanitizeFilename('src\\util.cpp'), { filename: 'src/util.cpp' });
	});

	test('a name that escapes the build dir is reduced to its base name', () => {
		const result = sanitizeFilename('../../etc/passwd');
		assert.strictEqual(result?.filename, 'passwd');
		assert.match(result?.problem ?? '', /outside the build directory/);
	});

	test('an absolute path is reduced to its base name', () => {
		assert.strictEqual(sanitizeFilename('/etc/passwd')?.filename, 'passwd');
		assert.strictEqual(sanitizeFilename('C:\\windows\\evil.cpp')?.filename, 'evil.cpp');
	});

	test('a name with nothing usable in it is rejected', () => {
		assert.strictEqual(sanitizeFilename('  '), undefined);
		assert.strictEqual(sanitizeFilename('../..'), undefined);
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

	test('each language spells its entry point its own way', () => {
		assert.strictEqual(autoFilename(code('rust', 'fn main() {}'), 0), 'main.rs');
		assert.strictEqual(autoFilename(code('zig', 'pub fn main() void {}'), 0), 'main.zig');
		assert.strictEqual(autoFilename(code('go', 'package main\n\nfunc main() {}'), 0), 'main.go');
		assert.strictEqual(autoFilename(code('rust', 'pub fn helper() {}'), 1), 'unit_1.rs');
		assert.strictEqual(autoFilename(code('go', 'package greet'), 1), 'unit_1.go');
	});
});

describe('resolveProjects', () => {
	test('an empty notebook has no projects', () => {
		const result = resolveProjects([markup('# hi')]);
		assert.strictEqual(result.projects.length, 0);
		assert.strictEqual(result.diagnostics.length, 0);
	});

	test('a buildspec cell opens a project and following file cells join it', () => {
		const spec = code('toml', 'compiler = "clang++"');
		const result = resolveProjects([
			markup('# demo'),
			spec,
			code('cpp', '#pragma once\nvoid f();', { filename: 'f.hpp' }),
			code('cpp', 'int main() { return 0; }')
		]);

		assert.strictEqual(result.projects.length, 1);
		assert.strictEqual(result.projects[0].specCell, spec);
		assert.strictEqual(result.projects[0].spec.compiler, 'clang++');
		assert.deepStrictEqual(
			result.projects[0].files.map((f) => f.filename),
			['f.hpp', 'main.cpp']
		);
		assert.strictEqual(result.diagnostics.length, 0);
	});

	test('markup cells do not close a project', () => {
		const result = resolveProjects([
			code('toml', ''),
			code('cpp', 'void f() {}'),
			markup('narration in the middle'),
			code('cpp', 'int main() { f(); }')
		]);

		assert.strictEqual(result.projects.length, 1);
		assert.strictEqual(result.projects[0].files.length, 2);
	});

	test('a second buildspec cell starts a second project', () => {
		const first = code('toml', 'mode = "build"');
		const second = code('toml', 'output = "second"');
		const result = resolveProjects([
			first,
			code('cpp', 'int main() {}'),
			second,
			code('cpp', 'int main() {}')
		]);

		assert.strictEqual(result.projects.length, 2);
		assert.strictEqual(result.projects[0].specCell, first);
		assert.strictEqual(result.projects[0].spec.mode, 'build');
		assert.strictEqual(result.projects[1].specCell, second);
		assert.strictEqual(result.projects[1].spec.output, 'second');
		// Filenames are scoped to a project, so both may be main.cpp.
		assert.strictEqual(result.projects[0].files[0].filename, 'main.cpp');
		assert.strictEqual(result.projects[1].files[0].filename, 'main.cpp');
		assert.strictEqual(result.diagnostics.length, 0);
	});

	test('a buildspec with no file cells is still a project', () => {
		const result = resolveProjects([code('toml', 'compiler = "g++"')]);
		assert.strictEqual(result.projects.length, 1);
		assert.strictEqual(result.projects[0].files.length, 0);
	});

	test('file cells before the first buildspec are a soft diagnostic', () => {
		const orphan = code('cpp', 'int main() {}');
		const result = resolveProjects([orphan, code('toml', ''), code('cpp', 'int main() {}')]);

		assert.strictEqual(result.projects.length, 1);
		assert.strictEqual(result.projects[0].files.length, 1);
		assert.strictEqual(result.diagnostics.length, 1);
		assert.strictEqual(result.diagnostics[0].cell, orphan);
		assert.match(result.diagnostics[0].message, /no buildspec cell above it/);
	});

	test('compiler and flags default from the language of the source cells', () => {
		const result = resolveProjects([code('toml', ''), code('c', 'int main() { return 0; }')]);
		assert.strictEqual(result.projects[0].spec.compiler, 'gcc');
		assert.deepStrictEqual(result.projects[0].spec.flags, ['-std=c17', '-O2', '-Wall', '-Wextra']);
	});

	test('rust and zig projects default to their own compiler', () => {
		const rust = resolveProjects([code('toml', ''), code('rust', 'fn main() {}')]);
		assert.strictEqual(rust.projects[0].spec.compiler, 'rustc');
		assert.strictEqual(rust.projects[0].spec.language, 'rust');
		assert.deepStrictEqual(rust.projects[0].spec.flags, ['--edition=2021', '-O']);

		const zig = resolveProjects([code('toml', ''), code('zig', 'pub fn main() void {}')]);
		assert.strictEqual(zig.projects[0].spec.compiler, 'zig');
		assert.strictEqual(zig.projects[0].spec.language, 'zig');

		const go = resolveProjects([code('toml', ''), code('go', 'package main\nfunc main() {}')]);
		assert.strictEqual(go.projects[0].spec.compiler, 'go');
		assert.strictEqual(go.projects[0].spec.language, 'go');
		assert.deepStrictEqual(go.projects[0].spec.flags, []);
	});

	test('a go.mod asset cell joins the project without deciding its language', () => {
		const result = resolveProjects([
			code('toml', ''),
			code('go.mod', 'module demo\n\ngo 1.21\n', { filename: 'go.mod' }),
			code('go', 'package main\nfunc main() {}')
		]);

		assert.deepStrictEqual(
			result.projects[0].files.map((f) => f.filename),
			['go.mod', 'main.go']
		);
		assert.strictEqual(result.projects[0].spec.compiler, 'go');
	});

	test('a header-only cell does not decide the project language', () => {
		const result = resolveProjects([
			code('toml', ''),
			code('c', '#pragma once\nvoid f();'),
			code('cpp', 'int main() {}')
		]);
		assert.strictEqual(result.projects[0].spec.compiler, 'g++');
	});

	test('buildspec parse warnings become diagnostics on the offending line', () => {
		const spec = code('toml', 'compiler = "g++"\nnonsense = 1\n');
		const result = resolveProjects([spec, code('cpp', 'int main() {}')]);

		assert.strictEqual(result.diagnostics.length, 1);
		assert.strictEqual(result.diagnostics[0].cell, spec);
		assert.match(result.diagnostics[0].message, /unknown buildspec key "nonsense"/);
		assert.strictEqual(result.diagnostics[0].line, 1);
	});

	test('explicit metadata beats the auto-generated name', () => {
		const result = resolveProjects([
			code('toml', ''),
			code('cpp', 'int main() {}', { filename: 'explicit.cpp' })
		]);
		assert.strictEqual(result.projects[0].files[0].filename, 'explicit.cpp');
	});

	test('a comment that looks like a directive is just a comment', () => {
		const result = resolveProjects([
			code('toml', ''),
			code('cpp', '// @file ignored.cpp\nint main() {}')
		]);
		assert.strictEqual(result.projects[0].files[0].filename, 'main.cpp');
	});

	test('an escaping filename is neutralised and reported on its cell', () => {
		const evil = code('cpp', 'int main() {}', { filename: '../../escape.cpp' });
		const result = resolveProjects([code('toml', ''), evil]);

		assert.strictEqual(result.projects[0].files[0].filename, 'escape.cpp');
		assert.strictEqual(result.diagnostics[0].cell, evil);
		assert.match(result.diagnostics[0].message, /outside the build directory/);
	});

	test('an asset cell joins the project but does not decide its language', () => {
		const result = resolveProjects([
			code('toml', ''),
			code('json', '{}', { filename: 'fixture.json' }),
			code('cpp', 'int main() {}')
		]);

		assert.deepStrictEqual(
			result.projects[0].files.map((f) => f.filename),
			['fixture.json', 'main.cpp']
		);
		assert.strictEqual(result.projects[0].spec.compiler, 'g++');
	});

	test('colliding filenames are suffixed and reported', () => {
		const result = resolveProjects([
			code('toml', ''),
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
