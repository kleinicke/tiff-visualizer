/**
 * A tile pyramid for a vector layer. Each level is a power-of-two raster
 * scale; tiles are painted on demand within a time budget and cached, so a
 * frame costs a handful of drawImage calls however many polygons the slide
 * has. Tiles that are not ready yet are covered by what the cache holds at
 * neighbouring levels (blurry for a moment, never blank).
 *
 * CPU only: tiles are ordinary 2D canvases.
 */

export const TILE_SIZE = 256;

export interface TilePainter {
	/** Paint everything inside the tile. The context maps scene pixels to tile pixels. */
	paint(context: CanvasRenderingContext2D, level: number, sceneRect: [number, number, number, number]): void;
}

interface Tile { canvas: HTMLCanvasElement | OffscreenCanvas; version: number }

export interface TileDrawStats { drawn: number; painted: number; pending: number; fallback: number }

const key = (level: number, x: number, y: number): string => `${level}/${x}/${y}`;

export class TileCache {
	private readonly tiles = new Map<string, Tile>();
	private version = 0;

	constructor(private readonly painter: TilePainter, private readonly maxTiles = 640, private readonly createCanvas: () => Tile['canvas'] = defaultCanvas) {}

	/** Everything painted so far is out of date (new colours, new mode). */
	invalidate(): void { this.version++; }

	clear(): void { this.tiles.clear(); }

	size(): number { return this.tiles.size; }

	/** Pyramid level for a screen scale: the smallest power of two that is at least as sharp as the screen. */
	static levelFor(scale: number): number { return Math.ceil(Math.log2(Math.max(scale, 1e-9)) - 1e-9); }

	/**
	 * Draw the tiles covering `visible` (scene pixels). `context` maps scene
	 * pixels to the screen. Paints stale or missing tiles until `budgetMs` is
	 * spent (at least one), and returns how many are still waiting.
	 */
	draw(context: CanvasRenderingContext2D, scale: number, visible: [number, number, number, number], budgetMs: number): TileDrawStats {
		const level = TileCache.levelFor(scale);
		const levelScale = 2 ** level;
		const span = TILE_SIZE / levelScale;
		const x0 = Math.max(0, Math.floor(visible[0] / span)), x1 = Math.floor(visible[2] / span);
		const y0 = Math.max(0, Math.floor(visible[1] / span)), y1 = Math.floor(visible[3] / span);
		const started = performance.now();
		const stats: TileDrawStats = { drawn: 0, painted: 0, pending: 0, fallback: 0 };
		context.save();
		context.imageSmoothingEnabled = true;
		for (let ty = y0; ty <= y1; ty++) {
			for (let tx = x0; tx <= x1; tx++) {
				const id = key(level, tx, ty);
				let tile = this.tiles.get(id);
				const current = tile !== undefined && tile.version === this.version;
				if (!current && (stats.painted === 0 || performance.now() - started < budgetMs)) {
					tile = this.paintTile(level, tx, ty, span, id, tile);
					stats.painted++;
				} else if (!current) {
					stats.pending++;
				}
				if (tile) {
					this.tiles.delete(id);
					this.tiles.set(id, tile);
					context.drawImage(tile.canvas as CanvasImageSource, tx * span, ty * span, span, span);
					stats.drawn++;
					if (tile.version !== this.version) { stats.fallback++; }
				} else if (this.drawFallback(context, level, tx, ty, span)) {
					stats.fallback++;
				}
			}
		}
		context.restore();
		this.evict();
		return stats;
	}

	private paintTile(level: number, tx: number, ty: number, span: number, id: string, previous: Tile | undefined): Tile {
		const tile = previous ?? { canvas: this.createCanvas(), version: -1 };
		const context = tile.canvas.getContext('2d') as CanvasRenderingContext2D;
		const levelScale = 2 ** level;
		context.setTransform(1, 0, 0, 1, 0, 0);
		context.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
		context.setTransform(levelScale, 0, 0, levelScale, -tx * span * levelScale, -ty * span * levelScale);
		this.painter.paint(context, level, [tx * span, ty * span, (tx + 1) * span, (ty + 1) * span]);
		tile.version = this.version;
		this.tiles.set(id, tile);
		return tile;
	}

	/** Cover a missing tile with a cached neighbour: finer tiles first, then coarser ones. */
	private drawFallback(context: CanvasRenderingContext2D, level: number, tx: number, ty: number, span: number): boolean {
		let drew = false;
		context.save();
		context.beginPath();
		context.rect(tx * span, ty * span, span, span);
		context.clip();
		for (let up = 1; up <= 3 && !drew; up++) {
			const factor = 2 ** up;
			const parent = this.tiles.get(key(level - up, Math.floor(tx / factor), Math.floor(ty / factor)));
			if (parent) {
				const parentSpan = span * factor;
				context.drawImage(parent.canvas as CanvasImageSource, Math.floor(tx / factor) * parentSpan, Math.floor(ty / factor) * parentSpan, parentSpan, parentSpan);
				drew = true;
			}
		}
		if (!drew) {
			const half = span / 2;
			for (let dy = 0; dy < 2; dy++) {
				for (let dx = 0; dx < 2; dx++) {
					const child = this.tiles.get(key(level + 1, tx * 2 + dx, ty * 2 + dy));
					if (child) { context.drawImage(child.canvas as CanvasImageSource, tx * span + dx * half, ty * span + dy * half, half, half); drew = true; }
				}
			}
		}
		context.restore();
		return drew;
	}

	private evict(): void {
		while (this.tiles.size > this.maxTiles) {
			const oldest = this.tiles.keys().next().value as string | undefined;
			if (oldest === undefined) { break; }
			this.tiles.delete(oldest);
		}
	}
}

function defaultCanvas(): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = TILE_SIZE;
	return canvas;
}
