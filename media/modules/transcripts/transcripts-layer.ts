/** The scene overlay that draws transcript points as dots. */

import { lowerBoundX, type GenePoints } from './transcript-data.js';

export interface DrawnGene { points: GenePoints; color: string }

/** Points drawn one by one per frame at most; denser views use the density image. */
const MAX_POINTS = 250_000;
/** Points counted per frame at most in the density style. */
const MAX_COUNTED = 6_000_000;
/** Opacity of a dot at full strength; the panel's Dot opacity sets it. */
export const DEFAULT_OPACITY = 0.9;
/** Past the default, opacity is already nearly 1, so the rest of the slider boosts the ink: up to this many times at 100%. */
const MAX_BOOST = 3;
/** Below this true dot width (device pixels), or with more points in view than MAX_POINTS, dots are accumulated into a density image instead of drawn. */
const SPECK_PX = 2;
/** From this drawn dot width (device pixels) up, dots are circles; below it they are squares, which are cheaper and look the same. */
const CIRCLE_PX = 2;
const TAU = Math.PI * 2;
/** Largest density image, in cells. */
const MAX_CELLS = 1_000_000;

function rgb(color: string): [number, number, number] {
	const value = parseInt(color.slice(1), 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * Brightness is the same at every zoom, the way the cell dots keep their ink: a dot is ~0.8 µm, so zoomed
 * out it is a fraction of a pixel, and drawing it bigger would brighten the layer.
 *  - Wide enough to see (2 px or more): dots are squares.
 *  - Small dots, or a crowded view: points are counted into a coarse grid, and each cell gets the opacity that true-size
 *    dots would cover there, 1 - exp(-share of dots x dot area / cell area): dense places saturate, sparse ones stay dim.
 */
export class TranscriptsLayer {
	private genes: DrawnGene[] = [];
	private minQv = 20;
	private size = 1;
	private opacity = DEFAULT_OPACITY;
	private speck: HTMLCanvasElement | null = null;
	private composite: HTMLCanvasElement | null = null;
	private image: ImageData | null = null;
	private counts = new Float32Array(0);

	/** `dotPx` is the size of a dot in scene pixels at 100% zoom (about 0.8 µm). */
	constructor(private readonly invalidate: () => void, private readonly dotPx: number) {}

	setGenes(genes: DrawnGene[]): void { this.genes = genes; this.invalidate(); }
	setMinQv(value: number): void { this.minQv = value; this.invalidate(); }
	setSize(value: number): void { this.size = value; this.invalidate(); }
	setOpacity(value: number): void { this.opacity = value; this.invalidate(); }

	/** More ink per dot above the default opacity, so the top of the slider is clearly brighter even where dots are specks. */
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
		let total = 0;
		for (const gene of this.genes) {
			const { x } = gene.points;
			const from = lowerBoundX(x, 0, x.length, left), to = lowerBoundX(x, from, x.length, right);
			if (to > from) { ranges.push({ gene, from, to }); total += to - from; }
		}
		if (total === 0) { return; }
		const truePx = this.dotPx * scale * this.size;
		// Thinning a crowded view would dim it, so crowded views are counted rather than drawn dot by dot.
		if (truePx < SPECK_PX || total > MAX_POINTS) { this.drawSpecks(context, ranges, total, [left, top, right, bottom], truePx); return; }
		// A dot is under a micron wide; keep it readable when zoomed out, and a speck rather than a blob when zoomed in.
		const drawnPx = Math.min(7, Math.max(2, this.dotPx * scale)) * this.size;
		const side = drawnPx / scale;
		const half = side / 2;
		const round = drawnPx >= CIRCLE_PX;
		context.save();
		context.globalAlpha = Math.min(this.opacity, this.opacity * this.boost() * truePx * truePx / (drawnPx * drawnPx));
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

	/** Dots under a pixel wide: count them into a coarse grid and shade each cell by the ink it would hold. */
	private drawSpecks(context: CanvasRenderingContext2D, ranges: { gene: DrawnGene; from: number; to: number }[], total: number, view: [number, number, number, number], truePx: number): void {
		const width = context.canvas.width, height = context.canvas.height;
		// A cell is at least as wide as a dot, so a dot's ink never exceeds what one cell can hold.
		const cell = Math.max(1, Math.ceil(Math.sqrt(width * height / MAX_CELLS)), Math.ceil(truePx));
		const columns = Math.ceil(width / cell), rows = Math.ceil(height / cell);
		if (this.counts.length < columns * rows) { this.counts = new Float32Array(columns * rows); }
		this.speck ??= document.createElement('canvas');
		this.composite ??= document.createElement('canvas');
		for (const canvas of [this.speck, this.composite]) { if (canvas.width !== columns || canvas.height !== rows) { canvas.width = columns; canvas.height = rows; } }
		const target = this.speck.getContext('2d')!;
		const out = this.composite.getContext('2d')!;
		out.clearRect(0, 0, columns, rows);
		const transform = context.getTransform();
		const stride = Math.max(1, Math.ceil(total / MAX_COUNTED));
		const [, top, , bottom] = view;
		const area = (truePx * truePx) / (cell * cell);
		const counts = this.counts;
		const boost = this.boost();
		if (!this.image || this.image.width !== columns || this.image.height !== rows) { this.image = target.createImageData(columns, rows); }
		const image = this.image;
		const pixels = image.data;
		const cut = Math.min(counts.length, columns * rows);
		// Composite the genes one by one into one image, so overlapping colours blend as they do in the dot style.
		for (const { gene, from, to } of ranges) {
			const { x, y, qv } = gene.points;
			counts.fill(0, 0, cut);
			for (let at = from; at < to; at += stride) {
				const py = y[at];
				if (py < top || py > bottom || qv[at] < this.minQv) { continue; }
				// Share the dot between the four cells it overlaps, in proportion to the overlap.
				const gx = (x[at] * transform.a + transform.e) / cell - 0.5, gy = (py * transform.d + transform.f) / cell - 0.5;
				const column = Math.floor(gx), row = Math.floor(gy);
				const fx = gx - column, fy = gy - row;
				if (column < -1 || column >= columns || row < -1 || row >= rows) { continue; }
				const here = row * columns + column;
				if (column >= 0 && row >= 0) { counts[here] += (1 - fx) * (1 - fy); }
				if (column + 1 < columns && row >= 0) { counts[here + 1] += fx * (1 - fy); }
				if (column >= 0 && row + 1 < rows) { counts[here + columns] += (1 - fx) * fy; }
				if (column + 1 < columns && row + 1 < rows) { counts[here + columns + 1] += fx * fy; }
			}
			const [red, green, blue] = rgb(gene.color);
			pixels.fill(0);
			for (let index = 0; index < cut; index++) {
				const count = counts[index];
				if (count === 0) { continue; }
				const slot = index * 4;
				pixels[slot] = red; pixels[slot + 1] = green; pixels[slot + 2] = blue;
				pixels[slot + 3] = Math.round(255 * this.opacity * (1 - Math.exp(-count * stride * area * boost)));
			}
			target.putImageData(image, 0, 0);
			out.drawImage(this.speck, 0, 0);
		}
		context.save();
		context.setTransform(1, 0, 0, 1, 0, 0);
		context.imageSmoothingEnabled = cell > 1;
		context.drawImage(this.composite, 0, 0, columns * cell, rows * cell);
		context.restore();
	}
}
