/** Transcript points of one gene, ready to draw: plain typed arrays, no DOM. */

export interface GenePoints {
	/** Scene pixels, sorted by x. */
	x: Float32Array;
	y: Float32Array;
	/** Quality value, rounded and clamped to 0-255. */
	qv: Uint8Array;
}

/** What the file holds, known without reading any positions. */
export interface TranscriptIndex {
	/** Gene names, sorted. */
	genes: string[];
	/** Transcripts per gene, in the order of `genes`. */
	counts: number[];
	total: number;
}

/**
 * The order that sorts `xs` ascending, as float32 values; equal values keep their order.
 * A radix sort on the float bits: millions of points sort in tens of milliseconds, where a
 * comparison sort takes seconds.
 */
export function orderByX(xs: ArrayLike<number>): Uint32Array {
	const count = xs.length;
	let keys = new Uint32Array(count), keysNext = new Uint32Array(count);
	let order = new Uint32Array(count), orderNext = new Uint32Array(count);
	const float = new Float32Array(1), bits = new Uint32Array(float.buffer);
	for (let index = 0; index < count; index++) {
		float[0] = xs[index];
		const value = bits[0];
		// Flip so unsigned order matches float order: negatives invert, positives set the top bit.
		keys[index] = (value & 0x80000000 ? ~value : value | 0x80000000) >>> 0;
		order[index] = index;
	}
	const starts = new Uint32Array(2048);
	for (let shift = 0; shift < 33; shift += 11) {
		starts.fill(0);
		for (let index = 0; index < count; index++) { starts[(keys[index] >>> shift) & 2047]++; }
		let total = 0;
		for (let digit = 0; digit < 2048; digit++) { const here = starts[digit]; starts[digit] = total; total += here; }
		for (let index = 0; index < count; index++) {
			const key = keys[index];
			const at = starts[(key >>> shift) & 2047]++;
			keysNext[at] = key; orderNext[at] = order[index];
		}
		[keys, keysNext] = [keysNext, keys];
		[order, orderNext] = [orderNext, order];
	}
	return order;
}

/** Sort a gene's points by x and convert units: `scale` turns the input units into scene pixels. */
export function buildGenePoints(xs: ArrayLike<number>, ys: ArrayLike<number>, qvs: ArrayLike<number>, scale: number): GenePoints {
	const count = xs.length;
	const order = orderByX(xs);
	const x = new Float32Array(count), y = new Float32Array(count), qv = new Uint8Array(count);
	for (let at = 0; at < count; at++) {
		const from = order[at];
		x[at] = xs[from] * scale; y[at] = ys[from] * scale;
		const quality = qvs[from];
		qv[at] = quality >= 255 ? 255 : quality > 0 ? Math.round(quality) : 0;
	}
	return { x, y, qv };
}

/** First index in [from, to) whose x is at least `value` (x is sorted ascending there). */
export function lowerBoundX(x: Float32Array, from: number, to: number, value: number): number {
	let low = from, high = to;
	while (low < high) { const middle = (low + high) >>> 1; if (x[middle] < value) { low = middle + 1; } else { high = middle; } }
	return low;
}
