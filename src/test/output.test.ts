import * as assert from 'assert';
import { describe, test } from 'node:test';

import { StreamKind, StreamTarget, TruncatingSink } from '../output';

class Capture implements StreamTarget {
	readonly writes: { kind: StreamKind; text: string }[] = [];

	write(kind: StreamKind, text: string): void {
		this.writes.push({ kind, text });
	}

	text(kind?: StreamKind): string {
		return this.writes
			.filter((write) => kind === undefined || write.kind === kind)
			.map((write) => write.text)
			.join('');
	}
}

const limits = { maxLines: 5, maxChars: 1000 };

function lines(count: number, prefix = 'line'): string {
	return (
		Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n'
	);
}

describe('TruncatingSink', () => {
	test('passes streams through untouched when under the limits', () => {
		const capture = new Capture();
		const sink = new TruncatingSink(capture, limits);

		sink.stdout('one\n');
		sink.stderr('bad\n');
		sink.finish();

		assert.strictEqual(sink.truncated, false);
		assert.strictEqual(capture.text('stdout'), 'one\n');
		assert.strictEqual(capture.text('stderr'), 'bad\n');
	});

	test('keeps the streams separate so each can be rendered as itself', () => {
		const capture = new Capture();
		const sink = new TruncatingSink(capture, limits);

		sink.info('$ g++ main.cpp\n');
		sink.stderr('error: no\n');

		assert.deepStrictEqual(
			capture.writes.map((write) => write.kind),
			['stdout', 'stderr']
		);
	});

	test('keeps the head of an over-long stream and counts the rest', () => {
		const capture = new Capture();
		const sink = new TruncatingSink(capture, limits);

		sink.stderr(lines(12));
		sink.finish();

		assert.strictEqual(sink.truncated, true);
		assert.strictEqual(capture.text('stderr'), lines(5));
		assert.strictEqual(sink.suppressedLines, 7);
		assert.match(capture.text('stdout'), /output truncated at 5 lines, 7 more line\(s\) not shown/);
	});

	test('the limit spans chunks, not each chunk on its own', () => {
		const capture = new Capture();
		const sink = new TruncatingSink(capture, limits);

		sink.stdout('a\nb\nc\n');
		sink.stdout('d\ne\nf\ng\n');
		sink.finish();

		assert.strictEqual(capture.text('stdout').startsWith('a\nb\nc\nd\ne\n'), true);
		assert.strictEqual(sink.truncated, true);
		assert.strictEqual(sink.suppressedLines, 2);
	});

	test('everything after the cut is dropped, including a later stream', () => {
		const capture = new Capture();
		const sink = new TruncatingSink(capture, limits);

		sink.stderr(lines(12));
		sink.stdout('program output\n');

		assert.doesNotMatch(capture.text(), /program output/);
		assert.strictEqual(sink.suppressedLines, 8);
	});

	test('info is never truncated: the exit code has to survive a flood', () => {
		const capture = new Capture();
		const sink = new TruncatingSink(capture, limits);

		sink.stderr(lines(50));
		sink.info('\n[exit code 1]\n');
		sink.finish();

		assert.match(capture.text('stdout'), /\[exit code 1\]/);
	});

	test('a single enormous line is cut by the character budget', () => {
		const capture = new Capture();
		const sink = new TruncatingSink(capture, { maxLines: 100, maxChars: 20 });

		sink.stdout('x'.repeat(500));
		sink.finish();

		assert.strictEqual(capture.text('stdout').startsWith('x'.repeat(20)), true);
		assert.strictEqual(sink.truncated, true);
		assert.match(capture.text('stdout'), /rest not shown/);
	});

	test('nothing is said when nothing was truncated', () => {
		const capture = new Capture();
		const sink = new TruncatingSink(capture, limits);

		sink.stdout('fine\n');
		sink.finish();

		assert.doesNotMatch(capture.text(), /truncated/);
	});
});
