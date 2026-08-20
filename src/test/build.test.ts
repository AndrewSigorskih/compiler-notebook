/**
 * Build tests observe the temp dir the way a real compiler would: a stub
 * compiler script prints its arguments and the files it can see, so assembly is
 * verified without depending on a toolchain being installed.
 */

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { after, before, describe, test } from 'node:test';

import { buildAndRun, buildCommand, OutputSink } from '../build';
import { BuildSpec, CellLike, Project, ProjectFile } from '../model';

const POSIX = process.platform !== 'win32';

/** Prints `ARGS:` and `FILE:` lines, then writes a runnable stub binary. */
const STUB_COMPILER = `#!/bin/sh
echo "ARGS: $*"
for f in $(find . -type f | sed 's|^\\./||' | sort); do
  echo "FILE: $f"
  while IFS= read -r line; do echo "BODY $f: $line"; done < "$f"
done
out=a.out
prev=
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
printf '#!/bin/sh\\necho program ran\\nexit 0\\n' > "$out"
chmod +x "$out"
exit 0
`;

const FAILING_COMPILER = `#!/bin/sh
echo "error: something went wrong" >&2
exit 3
`;

let scriptDir: string;
let stubPath: string;
let failingPath: string;

before(async () => {
	scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compiler-notebook-test-'));
	stubPath = path.join(scriptDir, 'stub-cc');
	failingPath = path.join(scriptDir, 'failing-cc');
	await fs.writeFile(stubPath, STUB_COMPILER, { mode: 0o755 });
	await fs.writeFile(failingPath, FAILING_COMPILER, { mode: 0o755 });
});

after(async () => {
	await fs.rm(scriptDir, { recursive: true, force: true }).catch(() => undefined);
});

const token = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose(): void {} })
};

class Recorder implements OutputSink {
	readonly all: string[] = [];
	readonly err: string[] = [];

	info(text: string): void {
		this.all.push(text);
	}
	stdout(chunk: string): void {
		this.all.push(chunk);
	}
	stderr(chunk: string): void {
		this.all.push(chunk);
		this.err.push(chunk);
	}

	get text(): string {
		return this.all.join('');
	}
	get errText(): string {
		return this.err.join('');
	}
}

function cell(languageId: string, value = ''): CellLike {
	return { kind: 'code', languageId, value };
}

function project(
	files: readonly { filename: string; languageId?: string; value?: string }[],
	spec: Partial<BuildSpec> = {}
): Project {
	const specCell = cell('toml');
	return {
		spec: {
			compiler: stubPath,
			flags: ['-std=c++20'],
			mode: 'build',
			output: 'app',
			...spec
		},
		specCell,
		files: files.map((file) => ({
			cell: cell(file.languageId ?? 'cpp', file.value ?? ''),
			filename: file.filename
		}))
	};
}

/** The `ARGS:` / `FILE:` lines the stub compiler reported. */
function reported(text: string, prefix: 'ARGS' | 'FILE'): string[] {
	return text
		.split('\n')
		.filter((line) => line.startsWith(`${prefix}: `))
		.map((line) => line.slice(prefix.length + 2));
}

describe('buildCommand', () => {
	const binary = process.platform === 'win32' ? 'app.exe' : 'app';

	function files(
		entries: readonly { filename: string; value?: string }[]
	): ProjectFile<CellLike>[] {
		return entries.map((entry) => ({
			cell: cell('plaintext', entry.value ?? ''),
			filename: entry.filename
		}));
	}

	function spec(language: string | undefined, flags: readonly string[] = []): BuildSpec {
		return { compiler: 'cc', flags, mode: 'build', output: 'app', language };
	}

	test('C++ takes every translation unit, flags first and output last', () => {
		const command = buildCommand(
			spec('cpp', ['-O2']),
			files([{ filename: 'util.hpp' }, { filename: 'a.cpp' }, { filename: 'b.cpp' }])
		);
		assert.deepStrictEqual(command.args, ['-O2', 'a.cpp', 'b.cpp', '-o', binary]);
	});

	test('a C++ project may include C translation units', () => {
		const command = buildCommand(spec('cpp'), files([{ filename: 'a.cpp' }, { filename: 'b.c' }]));
		assert.deepStrictEqual(command.sources, ['a.cpp', 'b.c']);
	});

	test('a source file of another language is never handed to the compiler', () => {
		const command = buildCommand(spec('cpp'), files([{ filename: 'a.cpp' }, { filename: 'b.rs' }]));
		assert.deepStrictEqual(command.sources, ['a.cpp']);
	});

	test('rustc gets the crate root only; the rest are pulled in by `mod`', () => {
		const command = buildCommand(
			spec('rust', ['--edition=2021']),
			files([
				{ filename: 'util.rs', value: 'pub fn util() {}' },
				{ filename: 'main.rs', value: 'mod util;\nfn main() {}' }
			])
		);
		assert.deepStrictEqual(command.args, ['--edition=2021', 'main.rs', '-o', binary]);
	});

	test('zig uses a subcommand and --name, not -o', () => {
		const command = buildCommand(
			spec('zig'),
			files([
				{ filename: 'util.zig', value: 'pub fn greeting() void {}' },
				{ filename: 'main.zig', value: 'pub fn main() void {}' }
			])
		);
		assert.deepStrictEqual(command.args, ['build-exe', 'main.zig', '--name', 'app']);
	});

	test('the root is the entry point, whatever the cell order or file name', () => {
		const command = buildCommand(
			spec('rust'),
			files([
				{ filename: 'helper.rs', value: 'pub fn helper() {}' },
				{ filename: 'app.rs', value: 'fn main() {}' }
			])
		);
		assert.deepStrictEqual(command.sources, ['app.rs']);
	});

	test('with no entry point at all, the first file is the root', () => {
		const command = buildCommand(
			spec('zig'),
			files([{ filename: 'a.zig' }, { filename: 'b.zig' }])
		);
		assert.deepStrictEqual(command.sources, ['a.zig']);
	});

	test('go uses a subcommand and puts -o before the file list', () => {
		const command = buildCommand(
			spec('go'),
			files([
				{ filename: 'greet.go', value: 'package main' },
				{ filename: 'main.go', value: 'package main\nfunc main() {}' }
			])
		);
		assert.deepStrictEqual(command.args, ['build', '-o', binary, 'greet.go', 'main.go']);
	});

	test('go is handed the build-dir root only: a sub-dir is a separate package', () => {
		const command = buildCommand(
			spec('go'),
			files([
				{ filename: 'main.go', value: 'package main\nfunc main() {}' },
				{ filename: 'greet/greet.go', value: 'package greet' }
			])
		);
		assert.deepStrictEqual(command.sources, ['main.go']);
	});

	test('an unknown language falls back to a -o command line', () => {
		const command = buildCommand(spec(undefined), files([{ filename: 'a.cpp' }]));
		assert.deepStrictEqual(command.args, ['a.cpp', '-o', binary]);
	});
});

describe('buildAndRun', { skip: POSIX ? false : 'needs a POSIX shell' }, () => {
	test('writes every file and compiles only the translation units', async () => {
		const sink = new Recorder();
		const result = await buildAndRun(
			project([
				{ filename: 'greeting.hpp', value: '#pragma once' },
				{ filename: 'main.cpp', value: 'int main() {}' },
				{ filename: 'util.cpp', value: 'void u() {}' },
				{ filename: 'data.json', languageId: 'json', value: '{}' }
			]),
			sink,
			token
		);

		assert.strictEqual(result.success, true);
		assert.deepStrictEqual(reported(sink.text, 'FILE').sort(), [
			'data.json',
			'greeting.hpp',
			'main.cpp',
			'util.cpp'
		]);
		assert.deepStrictEqual(reported(sink.text, 'ARGS'), [
			'-std=c++20 main.cpp util.cpp -o app'
		]);
	});

	test('cell contents reach the build dir intact', async () => {
		const sink = new Recorder();
		await buildAndRun(
			project([
				{ filename: 'main.cpp', value: 'int main() {}\n' },
				{ filename: 'notes.txt', languageId: 'plaintext', value: 'line one\nline two\n' }
			]),
			sink,
			token
		);

		assert.match(sink.text, /^BODY main\.cpp: int main\(\) \{\}$/m);
		assert.match(sink.text, /^BODY notes\.txt: line one$/m);
		assert.match(sink.text, /^BODY notes\.txt: line two$/m);
	});

	test('mode = "run" executes the produced binary and reports its exit code', async () => {
		const sink = new Recorder();
		const result = await buildAndRun(
			project([{ filename: 'main.cpp' }], { mode: 'run' }),
			sink,
			token
		);

		assert.strictEqual(result.success, true);
		assert.match(sink.text, /program ran/);
		assert.match(sink.text, /\[exit code 0\]/);
	});

	test('sub-directories in a filename are created', async () => {
		const sink = new Recorder();
		const result = await buildAndRun(
			project([
				{ filename: 'src/main.cpp', value: 'int main() {}' },
				{ filename: 'include/util.hpp', value: '#pragma once' }
			]),
			sink,
			token
		);

		assert.strictEqual(result.success, true);
		assert.deepStrictEqual(reported(sink.text, 'FILE').sort(), [
			'include/util.hpp',
			'src/main.cpp'
		]);
		assert.deepStrictEqual(reported(sink.text, 'ARGS'), ['-std=c++20 src/main.cpp -o app']);
	});

	test('each build gets its own temp dir, and it is cleaned up', async () => {
		const dirOf = async (): Promise<string> => {
			const sink = new Recorder();
			await buildAndRun(project([{ filename: 'main.cpp' }]), sink, token);
			return /\$ cd (\S+)/.exec(sink.text)![1];
		};

		const first = await dirOf();
		const second = await dirOf();

		assert.notStrictEqual(first, second);
		await assert.rejects(() => fs.stat(first));
		await assert.rejects(() => fs.stat(second));
	});

	test('a project with no compilable files fails with an explanation', async () => {
		const sink = new Recorder();
		const result = await buildAndRun(
			project([{ filename: 'greeting.hpp', value: '#pragma once' }]),
			sink,
			token
		);

		assert.strictEqual(result.success, false);
		assert.match(sink.errText, /are compilable source files/);
	});

	test('an empty project says what is missing', async () => {
		const sink = new Recorder();
		const result = await buildAndRun(project([]), sink, token);

		assert.strictEqual(result.success, false);
		assert.match(sink.errText, /no file cells/);
	});

	test('mode = "build" does not run the binary', async () => {
		const sink = new Recorder();
		const result = await buildAndRun(
			project([{ filename: 'main.cpp' }], { mode: 'build' }),
			sink,
			token
		);

		assert.strictEqual(result.success, true);
		assert.doesNotMatch(sink.text, /program ran/);
		assert.match(sink.text, /Compilation succeeded/);
	});

	test('a compiler failure is reported and the binary never runs', async () => {
		const sink = new Recorder();
		const result = await buildAndRun(
			project([{ filename: 'main.cpp' }], { compiler: failingPath, mode: 'run' }),
			sink,
			token
		);

		assert.deepStrictEqual(
			{ success: result.success, code: result.compileExitCode },
			{ success: false, code: 3 }
		);
		assert.match(sink.errText, /something went wrong/);
		assert.doesNotMatch(sink.text, /program ran/);
	});

	test('a missing compiler is reported instead of throwing', async () => {
		const sink = new Recorder();
		const result = await buildAndRun(
			project([{ filename: 'main.cpp' }], { compiler: path.join(scriptDir, 'no-such-cc') }),
			sink,
			token
		);

		assert.strictEqual(result.success, false);
		assert.match(sink.errText, /Failed to start/);
	});

	test('cancellation before compiling starts skips the build', async () => {
		const sink = new Recorder();
		const result = await buildAndRun(project([{ filename: 'main.cpp' }]), sink, {
			isCancellationRequested: true,
			onCancellationRequested: () => ({ dispose(): void {} })
		});

		assert.strictEqual(result.cancelled, true);
		assert.strictEqual(result.success, false);
	});
});
