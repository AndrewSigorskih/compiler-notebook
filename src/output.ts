/**
 * Output limiting, kept free of `vscode` so it can be unit-tested.
 *
 * A failing build can produce megabytes of diagnostics — a template error, or a
 * missing header that cascades. All of it in a notebook cell is unreadable and
 * slow to render, so streams are capped. The *head* is kept, not the tail: the
 * first error is the one that caused the rest.
 */

import { OutputSink } from './build';

export type StreamKind = 'stdout' | 'stderr';

/** Where limited output ends up. */
export interface StreamTarget {
	write(kind: StreamKind, text: string): void;
}

export interface OutputLimits {
	readonly maxLines: number;
	readonly maxChars: number;
}

export const DEFAULT_LIMITS: OutputLimits = {
	maxLines: 2000,
	maxChars: 512 * 1024
};

function countLines(text: string): number {
	let lines = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\n') {
			lines++;
		}
	}
	return lines;
}

/** The longest prefix of `text` within both budgets, cut on a line boundary. */
function head(text: string, lineBudget: number, charBudget: number): string {
	let end = 0;
	let seen = 0;
	while (seen < lineBudget) {
		const next = text.indexOf('\n', end);
		if (next === -1) {
			end = text.length;
			break;
		}
		end = next + 1;
		seen++;
	}
	return text.slice(0, Math.max(0, Math.min(end, charBudget)));
}

export class TruncatingSink implements OutputSink {
	private lines = 0;
	private chars = 0;
	private suppressed = 0;
	private cut = false;

	constructor(
		private readonly target: StreamTarget,
		private readonly limits: OutputLimits = DEFAULT_LIMITS
	) {}

	get truncated(): boolean {
		return this.cut;
	}

	get suppressedLines(): number {
		return this.suppressed;
	}

	/**
	 * Extension chatter — command lines, exit codes, notices — is never cut. It
	 * is a handful of lines, and losing the exit code to a flood of warnings
	 * would defeat the point.
	 */
	info(text: string): void {
		this.target.write('stdout', text);
	}

	stdout(chunk: string): void {
		this.stream('stdout', chunk);
	}

	stderr(chunk: string): void {
		this.stream('stderr', chunk);
	}

	/** Emits the truncation notice, if there was anything to suppress. */
	finish(): void {
		if (!this.cut) {
			return;
		}
		const more =
			this.suppressed > 0 ? `, ${this.suppressed} more line(s) not shown` : ', rest not shown';
		this.info(`\n[output truncated at ${this.limits.maxLines} lines${more}]\n`);
	}

	private stream(kind: StreamKind, chunk: string): void {
		if (this.cut) {
			this.suppressed += countLines(chunk);
			return;
		}

		const lineBudget = this.limits.maxLines - this.lines;
		const charBudget = this.limits.maxChars - this.chars;

		if (countLines(chunk) < lineBudget && chunk.length <= charBudget) {
			this.lines += countLines(chunk);
			this.chars += chunk.length;
			this.target.write(kind, chunk);
			return;
		}

		const kept = head(chunk, lineBudget, charBudget);
		if (kept.length > 0) {
			this.target.write(kind, kept);
		}
		this.cut = true;
		this.suppressed += countLines(chunk) - countLines(kept);
	}
}
