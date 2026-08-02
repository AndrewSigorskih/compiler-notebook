import * as assert from 'assert';
import { test, describe } from 'node:test';

import { parseBuildSpec, parseToml, resolveSpec } from '../buildspec';

describe('parseToml', () => {
	test('reads strings, arrays, booleans and numbers', () => {
		const { entries, warnings } = parseToml(
			[
				'compiler = "g++"',
				'flags = ["-std=c++23", "-O2"]',
				'verbose = true',
				'jobs = 4',
				"literal = 'no \\escapes'"
			].join('\n')
		);

		assert.strictEqual(entries.get('compiler'), 'g++');
		assert.deepStrictEqual(entries.get('flags'), ['-std=c++23', '-O2']);
		assert.strictEqual(entries.get('verbose'), true);
		assert.strictEqual(entries.get('jobs'), 4);
		assert.strictEqual(entries.get('literal'), 'no \\escapes');
		assert.deepStrictEqual(warnings, []);
	});

	test('ignores comments, blank lines and trailing commas', () => {
		const { entries } = parseToml(
			['# a comment', '', 'flags = [', '  "-Wall", # inline comment', '  "-Wextra",', ']'].join(
				'\n'
			)
		);
		assert.deepStrictEqual(entries.get('flags'), ['-Wall', '-Wextra']);
	});

	test('a section header is skipped with a warning', () => {
		const { entries, warnings } = parseToml('[build]\ncompiler = "clang++"');
		assert.strictEqual(entries.get('compiler'), 'clang++');
		assert.strictEqual(warnings.length, 1);
	});

	test('a key with no value warns instead of throwing', () => {
		const { entries, warnings } = parseToml('compiler =\nmode = "build"');
		assert.strictEqual(entries.has('compiler'), false);
		assert.strictEqual(entries.get('mode'), 'build');
		assert.match(warnings[0], /no value/);
	});

	test('an unterminated array does not hang', () => {
		const { entries, warnings } = parseToml('flags = ["-Wall"');
		assert.deepStrictEqual(entries.get('flags'), ['-Wall']);
		assert.match(warnings[0], /unterminated array/);
	});
});

describe('parseBuildSpec', () => {
	test('collects the four known keys', () => {
		const { partial, warnings } = parseBuildSpec(
			['compiler = "clang++"', 'flags = ["-std=c++23"]', 'mode = "build"', 'output = "app"'].join(
				'\n'
			)
		);

		assert.deepStrictEqual(partial, {
			compiler: 'clang++',
			flags: ['-std=c++23'],
			mode: 'build',
			output: 'app'
		});
		assert.deepStrictEqual(warnings, []);
	});

	test('an empty cell specifies nothing and warns about nothing', () => {
		const { partial, warnings } = parseBuildSpec('  \n# only a comment\n');
		assert.deepStrictEqual(partial, {});
		assert.deepStrictEqual(warnings, []);
	});

	test('unknown keys warn and are ignored', () => {
		const { partial, warnings } = parseBuildSpec('compiler = "g++"\nlinker = "lld"');
		assert.deepStrictEqual(partial, { compiler: 'g++' });
		assert.match(warnings[0], /unknown buildspec key "linker"/);
	});

	test('a bad mode falls back to the default', () => {
		const { partial, warnings } = parseBuildSpec('mode = "compile"');
		assert.strictEqual(partial.mode, undefined);
		assert.match(warnings[0], /"mode" must be "build" or "run"/);
	});

	test('flags given as a bare string are split and warned about', () => {
		const { partial, warnings } = parseBuildSpec('flags = "-Wall -Wextra"');
		assert.deepStrictEqual(partial.flags, ['-Wall', '-Wextra']);
		assert.match(warnings[0], /should be an array/);
	});

	test('an output path is rejected so the binary stays in the build dir', () => {
		const { partial, warnings } = parseBuildSpec('output = "../escape"');
		assert.strictEqual(partial.output, undefined);
		assert.match(warnings[0], /plain file name/);
	});
});

describe('resolveSpec', () => {
	test('missing keys come from the language table', () => {
		const spec = resolveSpec({}, 'cpp');
		assert.strictEqual(spec.compiler, 'g++');
		assert.deepStrictEqual(spec.flags, ['-std=c++20', '-O2', '-Wall', '-Wextra']);
		assert.strictEqual(spec.mode, 'run');
		assert.strictEqual(spec.output, 'app');
	});

	test('stated keys win over the defaults', () => {
		const spec = resolveSpec({ compiler: 'clang++', flags: [], mode: 'build' }, 'cpp');
		assert.strictEqual(spec.compiler, 'clang++');
		assert.deepStrictEqual(spec.flags, []);
		assert.strictEqual(spec.mode, 'build');
	});

	test('an unknown language still yields a usable spec', () => {
		const spec = resolveSpec({}, undefined);
		assert.strictEqual(spec.compiler, 'g++');
		assert.deepStrictEqual(spec.flags, []);
	});
});
