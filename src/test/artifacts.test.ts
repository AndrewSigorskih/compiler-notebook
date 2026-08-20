/**
 * The retained-build-dir bookkeeping behind "Save binary".
 *
 * Every test works on real directories: the point of the store is what it does
 * to the filesystem, and a mocked one would prove nothing about it.
 */

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, test } from 'node:test';

import { ArtifactStore, sweepStaleBuildDirs } from '../artifacts';
import { BUILD_DIR_PREFIX, BuildArtifact } from '../build';

const created: string[] = [];

afterEach(async () => {
	for (const dir of created.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
});

async function buildDir(name = 'app'): Promise<BuildArtifact> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${BUILD_DIR_PREFIX}test-`));
	created.push(dir);
	const binary = path.join(dir, name);
	await fs.writeFile(binary, '#!/bin/sh\n', { mode: 0o755 });
	return { dir, binary, name };
}

async function exists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch {
		return false;
	}
}

/** Dir removal is fire-and-forget, so give the microtask queue a turn. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('ArtifactStore', () => {
	test('a recorded artifact is retrievable by key', async () => {
		const store = new ArtifactStore();
		const artifact = await buildDir();

		store.record('cell-a', artifact, 'app', 1234);
		assert.strictEqual(store.get('cell-a')?.binary, artifact.binary);
		assert.strictEqual(store.get('cell-a')?.output, 'app');
		assert.strictEqual(store.get('cell-a')?.at, 1234);
		assert.strictEqual(store.get('cell-b'), undefined);
	});

	test('rebuilding a project deletes the dir the previous build left', async () => {
		const store = new ArtifactStore();
		const first = await buildDir();
		const second = await buildDir();

		store.record('cell-a', first, 'app');
		store.record('cell-a', second, 'app');
		await settle();

		assert.strictEqual(await exists(first.dir), false);
		assert.strictEqual(await exists(second.dir), true);
		assert.strictEqual(store.get('cell-a')?.dir, second.dir);
	});

	test('re-recording the same dir does not delete it', async () => {
		const store = new ArtifactStore();
		const artifact = await buildDir();

		store.record('cell-a', artifact, 'app');
		store.record('cell-a', artifact, 'app');
		await settle();

		assert.strictEqual(await exists(artifact.binary), true);
	});

	test('one project rebuilding leaves another project alone', async () => {
		const store = new ArtifactStore();
		const a = await buildDir();
		const b = await buildDir();

		store.record('cell-a', a, 'app');
		store.record('cell-b', b, 'app');
		store.record('cell-a', await buildDir(), 'app');
		await settle();

		assert.strictEqual(await exists(a.dir), false);
		assert.strictEqual(await exists(b.dir), true);
	});

	test('forget drops the entry and its dir', async () => {
		const store = new ArtifactStore();
		const artifact = await buildDir();

		store.record('cell-a', artifact, 'app');
		store.forget('cell-a');
		await settle();

		assert.strictEqual(store.get('cell-a'), undefined);
		assert.strictEqual(await exists(artifact.dir), false);
		// Forgetting what is not there is not an error.
		store.forget('cell-a');
	});

	test('forgetWhere releases everything a closed notebook held', async () => {
		const store = new ArtifactStore();
		const mine = await buildDir();
		const other = await buildDir();

		store.record('file:///a.cnb::cell1', mine, 'app');
		store.record('file:///b.cnb::cell1', other, 'app');
		store.forgetWhere((key) => key.startsWith('file:///a.cnb::'));
		await settle();

		assert.strictEqual(store.get('file:///a.cnb::cell1'), undefined);
		assert.strictEqual(store.get('file:///b.cnb::cell1')?.dir, other.dir);
		assert.strictEqual(await exists(mine.dir), false);
	});

	test('verify reports a build whose dir is gone, and forgets it', async () => {
		const store = new ArtifactStore();
		const artifact = await buildDir();
		store.record('cell-a', artifact, 'app');

		assert.strictEqual((await store.verify('cell-a'))?.binary, artifact.binary);

		// What a reboot or a temp cleaner does to a retained build.
		await fs.rm(artifact.dir, { recursive: true, force: true });

		assert.strictEqual(await store.verify('cell-a'), undefined);
		assert.strictEqual(store.get('cell-a'), undefined, 'the stale entry must not linger');
	});

	test('listeners fire on record and forget, and stop when disposed', async () => {
		const store = new ArtifactStore();
		let calls = 0;
		const subscription = store.onDidChange(() => calls++);

		store.record('cell-a', await buildDir(), 'app');
		store.forget('cell-a');
		assert.strictEqual(calls, 2);

		subscription.dispose();
		store.record('cell-a', await buildDir(), 'app');
		assert.strictEqual(calls, 2);
	});

	test('dispose releases every retained dir', async () => {
		const store = new ArtifactStore();
		const a = await buildDir();
		const b = await buildDir();
		store.record('cell-a', a, 'app');
		store.record('cell-b', b, 'app');

		store.dispose();
		await settle();

		assert.strictEqual(await exists(a.dir), false);
		assert.strictEqual(await exists(b.dir), false);
		assert.strictEqual(store.get('cell-a'), undefined);
	});
});

describe('sweepStaleBuildDirs', () => {
	test('collects old build dirs and leaves everything else', async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'compiler-notebook-sweep-'));
		created.push(tmp);

		const stale = path.join(tmp, `${BUILD_DIR_PREFIX}old`);
		const fresh = path.join(tmp, `${BUILD_DIR_PREFIX}new`);
		const foreign = path.join(tmp, 'someone-elses-dir');
		for (const dir of [stale, fresh, foreign]) {
			await fs.mkdir(dir);
			await fs.writeFile(path.join(dir, 'app'), 'x');
		}

		const now = Date.now();
		const old = new Date(now - 48 * 60 * 60 * 1000);
		await fs.utimes(stale, old, old);
		await fs.utimes(foreign, old, old);

		const removed = await sweepStaleBuildDirs(24 * 60 * 60 * 1000, tmp, now);

		assert.strictEqual(removed, 1);
		assert.strictEqual(await exists(stale), false);
		assert.strictEqual(await exists(fresh), true, 'a dir in use must survive');
		assert.strictEqual(await exists(foreign), true, 'only our own dirs are ours to delete');
	});

	test('a missing temp dir is not an error', async () => {
		assert.strictEqual(await sweepStaleBuildDirs(1000, '/no/such/dir/anywhere'), 0);
	});
});
