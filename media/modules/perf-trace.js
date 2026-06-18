// @ts-check
"use strict";

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
export class PerfTrace {
	/** @type {{label: string, start: number, last: number, phases: string[]}|null} */
	static _active = null;

	/** @type {(message: string) => void} */
	static _log = (message) => console.log(message);

	/**
	 * Route summary lines somewhere in addition to / instead of the console
	 * (e.g. the extension's Output channel via logToOutput).
	 * @param {(message: string) => void} fn
	 */
	static setLogger(fn) {
		if (fn) { PerfTrace._log = fn; }
	}

	/** @param {string} label */
	static begin(label) {
		const now = performance.now();
		PerfTrace._active = { label, start: now, last: now, phases: [] };
	}

	/**
	 * Record the phase that just finished. No-op when no trace is active.
	 * @param {string} name
	 */
	static mark(name) {
		const trace = PerfTrace._active;
		if (!trace) { return; }
		const now = performance.now();
		trace.phases.push(`${name} ${(now - trace.last).toFixed(0)}ms`);
		trace.last = now;
	}

	/**
	 * Append an externally measured detail without changing the active timer.
	 * No-op when no trace is active.
	 * @param {string} name
	 * @param {number} durationMs
	 */
	static detail(name, durationMs) {
		const trace = PerfTrace._active;
		if (!trace || !Number.isFinite(durationMs)) { return; }
		trace.phases.push(`${name} ${Math.max(0, durationMs).toFixed(0)}ms`);
	}

	/** Log the summary line and deactivate. No-op when no trace is active. */
	static end() {
		const trace = PerfTrace._active;
		if (!trace) { return; }
		PerfTrace._active = null;
		const total = (performance.now() - trace.start).toFixed(0);
		PerfTrace._log(`[PerfTrace] ${trace.label}: ${trace.phases.join(' | ')} | total ${total}ms`);
	}

	/** Drop the active trace without logging (e.g. load failed or superseded). */
	static cancel() {
		PerfTrace._active = null;
	}
}
