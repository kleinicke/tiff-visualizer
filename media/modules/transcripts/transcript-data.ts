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

/** Sort a gene's points by x and convert units: `scale` turns the input units into scene pixels. */
export function buildGenePoints(xs: ArrayLike<number>, ys: ArrayLike<number>, qvs: ArrayLike<number>, scale: number): GenePoints {
	const count = xs.length;
	const order = new Uint32Array(count);
	for (let index = 0; index < count; index++) { order[index] = index; }
	order.sort((a, b) => xs[a] - xs[b]);
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
