/** The scene overlay that draws transcript points as dots. */

import { lowerBoundX, type GenePoints } from './transcript-data.js';

export interface DrawnGene { points: GenePoints; color: string }

/** Points drawn per frame at most; denser views are thinned evenly. */
const MAX_POINTS = 250_000;
const ALPHA = 0.9;

export class TranscriptsLayer {
	private genes: DrawnGene[] = [];
	private minQv = 20;
	private size = 1;

	/** `dotPx` is the size of a dot in scene pixels at 100% zoom (about 0.8 µm). */
	constructor(private readonly invalidate: () => void, private readonly dotPx: number) {}

	setGenes(genes: DrawnGene[]): void { this.genes = genes; this.invalidate(); }
	setMinQv(value: number): void { this.minQv = value; this.invalidate(); }
	setSize(value: number): void { this.size = value; this.invalidate(); }

	private visibleRect(context: CanvasRenderingContext2D): [number, number, number, number] {
		const inverse = context.getTransform().inverse();
		const a = inverse.transformPoint(new DOMPoint(0, 0)), b = inverse.transformPoint(new DOMPoint(context.canvas.width, context.canvas.height));
		return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
	}

	draw(context: CanvasRenderingContext2D, _camera: unknown, scale: number): void {
		if (this.genes.length === 0) { return; }
		const [left, top, right, bottom] = this.visibleRect(context);
		const ranges: { gene: DrawnGene; from: number; to: number }[] = [];
		let total = 0;
		for (const gene of this.genes) {
			const { x } = gene.points;
			const from = lowerBoundX(x, 0, x.length, left), to = lowerBoundX(x, from, x.length, right);
			if (to > from) { ranges.push({ gene, from, to }); total += to - from; }
		}
		const stride = Math.max(1, Math.ceil(total / MAX_POINTS));
		// A dot is under a micron wide; keep it readable when zoomed out, and a speck rather than a blob when zoomed in.
		const side = Math.min(7, Math.max(2, this.dotPx * scale)) * this.size / scale;
		const half = side / 2;
		context.save();
		context.globalAlpha = ALPHA;
		for (const { gene, from, to } of ranges) {
			const { x, y, qv } = gene.points;
			context.fillStyle = gene.color;
			context.beginPath();
			for (let at = from; at < to; at += stride) {
				const py = y[at];
				if (py < top || py > bottom || qv[at] < this.minQv) { continue; }
				context.rect(x[at] - half, py - half, side, side);
			}
			context.fill();
		}
		context.restore();
	}
}
