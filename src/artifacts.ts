/**
 * Where a built binary lives between the build that produced it and the user
 * deciding to keep it.
 *
 * A build dir is normally deleted the moment the build ends (CLAUDE.md §5), so
 * "save the binary" needs one of them to survive. The compromise: at most **one
 * retained dir per buildspec cell**, replaced on the next build of that project
 * and deleted when the notebook closes or the extension shuts down. That keeps
 * the isolation story intact — nothing is shared, nothing accumulates per run —
 * while leaving the last thing you built where it can still be copied out.
 *
 * Retained means retained in `os.tmpdir()`, so it is not durable: a reboot or a
 * temp cleaner takes it, and the extension host may die without running its
 * cleanup. Both are handled rather than prevented — `verify` reports a build
 * that is gone, and `sweepStaleBuildDirs` collects what a previous session left
 * behind.
 *
 * Free of `vscode`: this is bookkeeping plus filesystem, and it is unit-tested
 * as such.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { BUILD_DIR_PREFIX, BuildArtifact, removeBuildDir } from './build';

export interface StoredArtifact extends BuildArtifact {
	/** Binary name the buildspec asked for, without a platform suffix. */
	readonly output: string;
	/** When the build finished, for the status bar tooltip. */
	readonly at: number;
}

export type ArtifactListener = () => void;

export class ArtifactStore {
	private readonly entries = new Map<string, StoredArtifact>();
	private readonly listeners = new Set<ArtifactListener>();

	/** Fires whenever the set of saveable binaries changes, for the status bar. */
	onDidChange(listener: ArtifactListener): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	private fire(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	get(key: string): StoredArtifact | undefined {
		return this.entries.get(key);
	}

	/**
	 * Take ownership of a build dir for `key`, dropping whatever that key held
	 * before. Recording the same dir twice is a no-op rather than a self-delete.
	 */
	record(key: string, artifact: BuildArtifact, output: string, at = Date.now()): void {
		const previous = this.entries.get(key);
		this.entries.set(key, { ...artifact, output, at });
		if (previous && previous.dir !== artifact.dir) {
			void removeBuildDir(previous.dir);
		}
		this.fire();
	}

	/** Drop an entry and delete its dir. */
	forget(key: string): void {
		const entry = this.entries.get(key);
		if (!entry) {
			return;
		}
		this.entries.delete(key);
		void removeBuildDir(entry.dir);
		this.fire();
	}

	/** Drop every entry whose key matches — used when a notebook closes. */
	forgetWhere(predicate: (key: string) => boolean): void {
		for (const key of [...this.entries.keys()]) {
			if (predicate(key)) {
				this.forget(key);
			}
		}
	}

	/**
	 * Confirm the binary is still on disk, forgetting the entry if it is not.
	 * Checked at the point of use, never while painting a status bar: a stat per
	 * repaint would be filesystem work on every keystroke.
	 */
	async verify(key: string): Promise<StoredArtifact | undefined> {
		const entry = this.entries.get(key);
		if (!entry) {
			return undefined;
		}
		try {
			const stat = await fs.stat(entry.binary);
			if (stat.isFile()) {
				return entry;
			}
		} catch {
			// Falls through: gone is gone, whatever the reason.
		}
		this.forget(key);
		return undefined;
	}

	dispose(): void {
		for (const entry of this.entries.values()) {
			void removeBuildDir(entry.dir);
		}
		this.entries.clear();
		this.listeners.clear();
	}
}

/** A day: long enough that no live window's build dir is plausibly this old. */
export const STALE_BUILD_DIR_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Delete build dirs left behind by a previous session.
 *
 * An extension host that is killed never runs its cleanup, so leftovers are a
 * fact of life rather than a bug (CLAUDE.md §10). Only dirs older than
 * `maxAgeMs` are touched, so a second window building right now is never robbed
 * of its dir; if one ever were, `verify` turns it into a "run it again" message.
 */
export async function sweepStaleBuildDirs(
	maxAgeMs = STALE_BUILD_DIR_AGE_MS,
	tmpDir = os.tmpdir(),
	now = Date.now()
): Promise<number> {
	let removed = 0;
	let names: string[];
	try {
		names = await fs.readdir(tmpDir);
	} catch {
		return 0;
	}

	for (const name of names) {
		if (!name.startsWith(BUILD_DIR_PREFIX)) {
			continue;
		}
		const dir = path.join(tmpDir, name);
		try {
			const stat = await fs.stat(dir);
			if (!stat.isDirectory() || now - stat.mtimeMs < maxAgeMs) {
				continue;
			}
		} catch {
			continue;
		}
		await removeBuildDir(dir);
		removed++;
	}
	return removed;
}
