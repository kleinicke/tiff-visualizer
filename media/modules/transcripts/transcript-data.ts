/** Transcript points grouped by gene, ready to draw: plain typed arrays, no DOM. */

export interface TranscriptData {
	/** Gene names, sorted. */
	genes: string[];
	/** Points of gene g are offsets[g] .. offsets[g + 1], sorted by x. */
	offsets: Uint32Array;
	/** Scene pixels. */
	x: Float32Array;
	y: Float32Array;
	/** Quality value, rounded and clamped to 0-255. */
	qv: Uint8Array;
}

/** Group points by gene and sort each gene's points by x. `scale` converts the input units to scene pixels. */
export function buildTranscriptData(names: ArrayLike<string>, xs: ArrayLike<number>, ys: ArrayLike<number>, qvs: ArrayLike<number>, scale: number): TranscriptData {
	const count = names.length;
	const geneOf = new Map<string, number>();
	for (let index = 0; index < count; index++) { if (!geneOf.has(names[index])) { geneOf.set(names[index], 0); } }
	const genes = [...geneOf.keys()].sort();
	genes.forEach((gene, position) => geneOf.set(gene, position));
	const code = new Uint32Array(count);
	const offsets = new Uint32Array(genes.length + 1);
	for (let index = 0; index < count; index++) { const gene = geneOf.get(names[index])!; code[index] = gene; offsets[gene + 1]++; }
	for (let gene = 0; gene < genes.length; gene++) { offsets[gene + 1] += offsets[gene]; }
	const order = new Uint32Array(count);
	const next = offsets.slice(0, genes.length);
	for (let index = 0; index < count; index++) { order[next[code[index]]++] = index; }
	const x = new Float32Array(count), y = new Float32Array(count), qv = new Uint8Array(count);
	const key = new Float64Array(count);
	for (let index = 0; index < count; index++) { key[index] = xs[index] * scale; }
	for (let gene = 0; gene < genes.length; gene++) {
		const part = order.subarray(offsets[gene], offsets[gene + 1]);
		part.sort((a, b) => key[a] - key[b]);
	}
	for (let at = 0; at < count; at++) {
		const from = order[at];
		x[at] = key[from]; y[at] = ys[from] * scale;
		const quality = qvs[from];
		qv[at] = quality >= 255 ? 255 : quality > 0 ? Math.round(quality) : 0;
	}
	return { genes, offsets, x, y, qv };
}

/** First index in [from, to) whose x is at least `value` (x is sorted ascending there). */
export function lowerBoundX(x: Float32Array, from: number, to: number, value: number): number {
	let low = from, high = to;
	while (low < high) { const middle = (low + high) >>> 1; if (x[middle] < value) { low = middle + 1; } else { high = middle; } }
	return low;
}
