"use strict";

// Code-only diagnostic flag. Keep disabled for normal builds so users see the
// concise [Perf] load summaries without the full per-phase trace. Temporarily
// enable this while profiling image loading, rendering, or collection switches.
const DETAILED_PERF_TRACING = false;

/**
 * Lightweight phase timer for diagnosing where an image switch spends time.
 *
 * One trace is active at a time (image loads are serialized via _loadGeneration
 * in imagePreview.js — superseded loads abort). mark() and end() are no-ops
 * when no trace is active, so instrumented code paths need no guards and cost
 * nothing outside a traced load.
 *
 * mark(name) labels the time elapsed since the previous mark (or begin), so
 * un-instrumented work between two marks is attributed to the later mark —
 * nothing is hidden from the total.
 *
 * detail(name, durationMs) appends a measured sub-phase without advancing the
 * main timeline. Use it for timings collected inside workers or libraries
 * after the parent wall-clock phase has already been marked.
 *
 * Output is a single line per traced load, e.g.:
 *   [PerfTrace] switch img_004.tif: paint-yield 18ms | fetch 12ms |
 *   decode-worker 85ms | raster-copy 41ms | stats 33ms | interleave 58ms |
 *   render 122ms | canvas-upload 9ms | finalize 6ms | total 384ms
 */
interface ActiveTrace {
	label: string;
	start: number;
	last: number;
	phases: string[];
	detailed: boolean;
	conciseLabel: string;
	/**
	 * Per-phase totals, recorded even when DETAILED_PERF_TRACING is off, so the
	 * concise [Perf] line can report fetch/decode without the full trace.
	 */
	totals: Map<string, number>;
}

export class PerfTrace {
	static _active: ActiveTrace | null = null;

	/** Totals of the most recently finished trace, for post-end() summaries. */
	static _lastTotals: Map<string, number> = new Map();

	static _log: (message: string) => void = (message: string) => console.log(message);

	/**
	 * Route summary lines somewhere in addition to / instead of the console
	 * (e.g. the extension's Output channel via logToOutput).
	 */
	static setLogger(fn: (message: string) => void) {
		if (fn) { PerfTrace._log = fn; }
	}

	static begin(label: string, options: { conciseLabel?: string } = {}) {
		const conciseLabel = String(options.conciseLabel || '');
		// The trace is always created: even without detailed tracing or a concise
		// label, the per-phase totals feed the [Perf] load summary line.
		const now = performance.now();
		PerfTrace._active = {
			label,
			start: now,
			last: now,
			phases: [],
			detailed: DETAILED_PERF_TRACING,
			conciseLabel,
			totals: new Map(),
		};
	}

	/** Record the phase that just finished. No-op when no trace is active. */
	static mark(name: string) {
		const trace = PerfTrace._active;
		if (!trace) { return; }
		const now = performance.now();
		const elapsed = now - trace.last;
		trace.totals.set(name, (trace.totals.get(name) || 0) + elapsed);
		if (trace.detailed) { trace.phases.push(`${name} ${elapsed.toFixed(0)}ms`); }
		trace.last = now;
	}

	/**
	 * Record a phase whose final portion was already measured by an overlapping
	 * bootstrap task. The elapsed wall time is partitioned, never double-counted:
	 * up to `tailDurationMs` is assigned to the tail phase and the remainder to
	 * the preceding phase.
	 */
	static markWithTail(precedingName: string, tailName: string, tailDurationMs: number) {
		const trace = PerfTrace._active;
		if (!trace) { return; }
		const now = performance.now();
		const elapsed = Math.max(0, now - trace.last);
		const tail = Math.min(elapsed, Math.max(0, Number(tailDurationMs) || 0));
		const preceding = elapsed - tail;
		trace.totals.set(precedingName, (trace.totals.get(precedingName) || 0) + preceding);
		trace.totals.set(tailName, (trace.totals.get(tailName) || 0) + tail);
		if (trace.detailed) {
			trace.phases.push(`${precedingName} ${preceding.toFixed(0)}ms`);
			trace.phases.push(`${tailName} ${tail.toFixed(0)}ms`);
		}
		trace.last = now;
	}

	/**
	 * Append an externally measured detail without changing the active timer.
	 * No-op when no trace is active.
	 */
	static detail(name: string, durationMs: number) {
		const trace = PerfTrace._active;
		if (!trace || !Number.isFinite(durationMs)) { return; }
		trace.totals.set(name, (trace.totals.get(name) || 0) + Math.max(0, durationMs));
		if (trace.detailed) { trace.phases.push(`${name} ${Math.max(0, durationMs).toFixed(0)}ms`); }
	}

	/**
	 * Append a non-duration measurement such as bytes or throughput.
	 * No-op when no trace is active.
	 */
	static note(name: string, value: string | number) {
		const trace = PerfTrace._active;
		if (!trace?.detailed) { return; }
		trace.phases.push(`${name} ${value}`);
	}

	/** Log the summary line and deactivate. No-op when no trace is active. */
	static end() {
		const trace = PerfTrace._active;
		if (!trace) { return; }
		PerfTrace._active = null;
		PerfTrace._lastTotals = trace.totals;
		const total = (performance.now() - trace.start).toFixed(0);
		if (trace.detailed) {
			PerfTrace._log(`[PerfTrace] ${trace.label}: ${trace.phases.join(' | ')} | total ${total}ms`);
		} else if (trace.conciseLabel) {
			PerfTrace._log(`[Perf] ${trace.conciseLabel} in ${total}ms`);
		}
	}

	/**
	 * Total milliseconds recorded for every phase whose name matches `pattern`.
	 * Returns 0 when no trace is active or nothing matched.
	 */
	static totalMatching(pattern: RegExp): number {
		const totals = PerfTrace._active?.totals || PerfTrace._lastTotals;
		let sum = 0;
		for (const [name, value] of totals) {
			if (pattern.test(name)) { sum += value; }
		}
		return sum;
	}

	/** Name of the first recorded phase matching `pattern`, or ''. */
	static firstMatching(pattern: RegExp): string {
		const totals = PerfTrace._active?.totals || PerfTrace._lastTotals;
		for (const name of totals.keys()) {
			if (pattern.test(name)) { return name; }
		}
		return '';
	}

	/** Drop the active trace without logging (e.g. load failed or superseded). */
	static cancel() {
		PerfTrace._active = null;
	}
}
