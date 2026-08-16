import * as assert from 'assert';
import { test, describe } from 'node:test';

import { defaultBuildspecText, parseBuildSpec, parseToml, resolveSpec } from '../buildspec';

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

		assert.strictEqual(entries.get('compiler')?.value, 'g++');
		assert.deepStrictEqual(entries.get('flags')?.value, ['-std=c++23', '-O2']);
		assert.strictEqual(entries.get('verbose')?.value, true);
		assert.strictEqual(entries.get('jobs')?.value, 4);
		assert.strictEqual(entries.get('literal')?.value, 'no \\escapes');
		assert.deepStrictEqual(warnings, []);
	});

	test('each key remembers the line it was written on', () => {
		const { entries } = parseToml('# a comment\ncompiler = "g++"\n\nmode = "build"\n');
		assert.strictEqual(entries.get('compiler')?.line, 1);
		assert.strictEqual(entries.get('mode')?.line, 3);
	});

	test('ignores comments, blank lines and trailing commas', () => {
		const { entries } = parseToml(
			['# a comment', '', 'flags = [', '  "-Wall", # inline comment', '  "-Wextra",', ']'].join(
				'\n'
			)
		);
		assert.deepStrictEqual(entries.get('flags')?.value, ['-Wall', '-Wextra']);
	});

	test('a section header is skipped with a warning', () => {
		const { entries, warnings } = parseToml('[build]\ncompiler = "clang++"');
		assert.strictEqual(entries.get('compiler')?.value, 'clang++');
		assert.deepStrictEqual(warnings.length, 1);
		assert.strictEqual(warnings[0].line, 0);
	});

	test('a key with no value warns instead of throwing', () => {
		const { entries, warnings } = parseToml('compiler =\nmode = "build"');
		assert.strictEqual(entries.has('compiler'), false);
		assert.strictEqual(entries.get('mode')?.value, 'build');
		assert.match(warnings[0].message, /no value/);
	});

	test('an unterminated array does not hang', () => {
		const { entries, warnings } = parseToml('flags = ["-Wall"');
		assert.deepStrictEqual(entries.get('flags')?.value, ['-Wall']);
		assert.match(warnings[0].message, /unterminated array/);
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
		assert.match(warnings[0].message, /unknown buildspec key "linker"/);
		assert.strictEqual(warnings[0].line, 1);
	});

	test('a bad mode falls back to the default', () => {
		const { partial, warnings } = parseBuildSpec('mode = "compile"');
		assert.strictEqual(partial.mode, undefined);
		assert.match(warnings[0].message, /"mode" must be "build" or "run"/);
	});

	test('flags given as a bare string are split and warned about', () => {
		const { partial, warnings } = parseBuildSpec('flags = "-Wall -Wextra"');
		assert.deepStrictEqual(partial.flags, ['-Wall', '-Wextra']);
		assert.match(warnings[0].message, /should be an array/);
	});

	test('an output path is rejected so the binary stays in the build dir', () => {
		const { partial, warnings } = parseBuildSpec('output = "../escape"');
		assert.strictEqual(partial.output, undefined);
		assert.match(warnings[0].message, /plain file name/);
	});
});

describe('defaultBuildspecText', () => {
	test('states the defaults a project of that language would have used', () => {
		assert.strictEqual(
			defaultBuildspecText('cpp'),
			[
				'# cpp project. Every key is optional; these are the defaults.',
				'compiler = "g++"',
				'flags    = ["-std=c++20", "-O2", "-Wall", "-Wextra"]',
				'mode     = "run"',
				'output   = "app"',
				''
			].join('\n')
		);
	});

	test('a language with no default flags still writes a usable array', () => {
		assert.match(defaultBuildspecText('zig'), /^flags {4}= \[\]$/m);
	});

	test('what it writes parses back into exactly the defaults', () => {
		// The generated cell must be a no-op: filling it in must not change how
		// the project builds.
		for (const languageId of ['cpp', 'c', 'rust', 'zig']) {
			const { partial, warnings } = parseBuildSpec(defaultBuildspecText(languageId));
			assert.deepStrictEqual(warnings, [], languageId);
			assert.deepStrictEqual(
				resolveSpec(partial, languageId),
				resolveSpec({}, languageId),
				languageId
			);
		}
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
