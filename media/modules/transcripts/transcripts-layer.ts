/** The scene overlay that draws transcript points as dots. */

import { lowerBoundX, type GenePoints } from './transcript-data.js';

export interface DrawnGene { points: GenePoints; color: string }

/** Opacity of a dot at full strength; the panel's Dot opacity sets it. */
export const DEFAULT_OPACITY = 0.9;
/** The panel's Dot size starts here (1 is the dot's true size, about 0.8 µm). */
export const DEFAULT_SIZE = 3;
/** Past the default, opacity is already nearly 1, so the rest of the slider boosts the ink: up to this many times at 100%. */
const MAX_BOOST = 3;
/** From this drawn dot width (device pixels) up, dots are circles; below it they are squares, which are cheaper and look the same. */
const CIRCLE_PX = 0.0;
const TAU = Math.PI * 2;

/** Draws each transcript as a square or circle whose size follows the zoom, clamped between a minimum and maximum width. */
export class TranscriptsLayer {
	private genes: DrawnGene[] = [];
	private minQv = 20;
	private size = DEFAULT_SIZE;
	private opacity = DEFAULT_OPACITY;

	/** `dotPx` is the size of a dot in scene pixels at 100% zoom (about 0.8 µm). */
	constructor(private readonly invalidate: () => void, private readonly dotPx: number) {}

	setGenes(genes: DrawnGene[]): void { this.genes = genes; this.invalidate(); }
	setMinQv(value: number): void { this.minQv = value; this.invalidate(); }
	setSize(value: number): void { this.size = value; this.invalidate(); }
	setOpacity(value: number): void { this.opacity = value; this.invalidate(); }

	/** More ink per dot above the default opacity, so the top of the slider is clearly brighter. */
	private boost(): number { return this.opacity <= DEFAULT_OPACITY ? 1 : 1 + (this.opacity - DEFAULT_OPACITY) / (1 - DEFAULT_OPACITY) * (MAX_BOOST - 1); }

	private visibleRect(context: CanvasRenderingContext2D): [number, number, number, number] {
		const inverse = context.getTransform().inverse();
		const a = inverse.transformPoint(new DOMPoint(0, 0)), b = inverse.transformPoint(new DOMPoint(context.canvas.width, context.canvas.height));
		return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
	}

	draw(context: CanvasRenderingContext2D, _camera: unknown, scale: number): void {
		if (this.genes.length === 0) { return; }
		const [left, top, right, bottom] = this.visibleRect(context);
		const ranges: { gene: DrawnGene; from: number; to: number }[] = [];
		for (const gene of this.genes) {
			const { x } = gene.points;
			const from = lowerBoundX(x, 0, x.length, left), to = lowerBoundX(x, from, x.length, right);
			if (to > from) { ranges.push({ gene, from, to }); }
		}
		if (ranges.length === 0) { return; }
		// A dot is under a micron wide: floor of 2 px zoomed out, cap of 7 px zoomed in, then scaled by the Dot size setting.
		const drawnPx = Math.min(100, Math.max(0.5, this.dotPx * scale)) * this.size;
		const side = drawnPx / scale;
		const half = side / 2;
		const round = drawnPx >= CIRCLE_PX;
		context.save();
		context.globalAlpha = Math.min(this.opacity, this.opacity * this.boost());
		for (const { gene, from, to } of ranges) {
			const { x, y, qv } = gene.points;
			context.fillStyle = gene.color;
			context.beginPath();
			for (let at = from; at < to; at++) {
				const py = y[at];
				if (py < top || py > bottom || qv[at] < this.minQv) { continue; }
				if (round) { context.moveTo(x[at] + half, py); context.arc(x[at], py, half, 0, TAU); } else { context.rect(x[at] - half, py - half, side, side); }
			}
			context.fill();
		}
		context.restore();
	}
}
