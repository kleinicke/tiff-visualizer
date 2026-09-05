"use strict";

import type { Rect } from './viewport-tiles.js';
import type { TiffPageEntry } from './tiff-pages.js';

export interface PyramidTileAddress {
	column: number;
	row: number;
}

interface CachedTile extends PyramidTileAddress {
	key: string;
	level: number;
	reduction: number;
	pixels: number;
	lastUsed: number;
	element: HTMLCanvasElement;
}

/**
 * A stable, full-resolution coordinate system for a pyramidal image.
 *
 * The element represents the SCENE, not whichever overview happens to be the
 * cheapest background. Every child is positioned in full-resolution scene
 * coordinates, so one zoom transform moves the overview and all retained
 * detail together. This is the property the former detached patch lacked.
 */
export class PyramidScene {
	readonly element: HTMLDivElement;
	readonly fullWidth: number;
	readonly fullHeight: number;
	private readonly _tiles = new Map<string, CachedTile>();
	private readonly _baseCanvas: HTMLCanvasElement;
	private readonly _baseBlocks = new Set<string>();
	private _clock = 0;
	private _tilePixels = 0;
	private readonly _maxTilePixels: number;

	constructor(
		baseCanvas: HTMLCanvasElement,
		fullWidth: number,
		fullHeight: number,
		maxTilePixels = 32_000_000,
	) {
		this.fullWidth = Math.max(1, fullWidth);
		this.fullHeight = Math.max(1, fullHeight);
		this._maxTilePixels = Math.max(1, maxTilePixels);
		this._baseCanvas = baseCanvas;
		this.element = document.createElement('div');
		this.element.className = 'pyramid-scene scale-to-fit';
		this.element.dataset.sceneWidth = String(this.fullWidth);
		this.element.dataset.sceneHeight = String(this.fullHeight);
		this.element.style.aspectRatio = `${this.fullWidth} / ${this.fullHeight}`;

		baseCanvas.classList.remove('scale-to-fit', 'pixelated');
		baseCanvas.classList.add('pyramid-base');
		baseCanvas.style.width = '100%';
		baseCanvas.style.height = '100%';
		this.element.appendChild(baseCanvas);
	}

	private _baseKey(column: number, row: number): string {
		return `${column}:${row}`;
	}

	/** Missing blocks of the overview canvas itself, centre-first. */
	missingBaseRects(level: TiffPageEntry, wanted: Rect): Rect[] {
		const centreX = wanted.x + wanted.width / 2;
		const centreY = wanted.y + wanted.height / 2;
		return this._addresses(level, wanted)
			.filter(address => !this._baseBlocks.has(this._baseKey(address.column, address.row)))
			.map(address => this._rectForAddress(level, address))
			.sort((a, b) => {
				const distanceA = Math.abs(a.x + a.width / 2 - centreX) + Math.abs(a.y + a.height / 2 - centreY);
				const distanceB = Math.abs(b.x + b.width / 2 - centreX) + Math.abs(b.y + b.height / 2 - centreY);
				return distanceA - distanceB;
			});
	}

	/** Paint one overview block into its fixed backing canvas as soon as it arrives. */
	commitBaseRegion(level: TiffPageEntry, rect: Rect, imageData: ImageData | HTMLCanvasElement): void {
		const context = this._baseCanvas.getContext('2d');
		if (!context) { return; }
		if ('data' in imageData) { context.putImageData(imageData, rect.x, rect.y); }
		else { context.drawImage(imageData, rect.x, rect.y); }
		for (const address of this._addresses(level, rect)) {
			this._baseBlocks.add(this._baseKey(address.column, address.row));
		}
	}

	baseLoadedSummary(level: TiffPageEntry, wanted: Rect): { blocks: number, totalBlocks: number, pixels: number } {
		const addresses = this._addresses(level, wanted);
		let blocks = 0;
		let pixels = 0;
		for (const address of addresses) {
			if (!this._baseBlocks.has(this._baseKey(address.column, address.row))) { continue; }
			blocks++;
			const rect = this._rectForAddress(level, address);
			pixels += rect.width * rect.height;
		}
		return { blocks, totalBlocks: addresses.length, pixels };
	}

	dispose(): void {
		this.clearTiles();
		this.element.remove();
	}

	clearTiles(): void {
		for (const tile of this._tiles.values()) { tile.element.remove(); }
		this._tiles.clear();
		this._tilePixels = 0;
	}

	clearBase(): void {
		const context = this._baseCanvas.getContext('2d');
		context?.clearRect(0, 0, this._baseCanvas.width, this._baseCanvas.height);
		this._baseBlocks.clear();
	}

	/**
	 * Finish a zoom/pan transition on one uniform detail level.
	 *
	 * Other levels stay visible while the requested level is loading, then are
	 * retired together. This preserves visual continuity during interaction
	 * without leaving a permanent patchwork after the view settles.
	 */
	retainOnlyLevel(levelIndex: number): number {
		let removed = 0;
		for (const [key, tile] of this._tiles) {
			if (tile.level === levelIndex) { continue; }
			this._tiles.delete(key);
			this._tilePixels -= tile.pixels;
			tile.element.remove();
			removed++;
		}
		return removed;
	}

	/** CSS pixels per full-resolution stored pixel. */
	sceneScale(): number {
		return this.element.clientWidth > 0 ? this.element.clientWidth / this.fullWidth : 0;
	}

	private _key(level: number, column: number, row: number): string {
		return `${level}:${column}:${row}`;
	}

	private _addresses(level: TiffPageEntry, rect: Rect): PyramidTileAddress[] {
		const blockWidth = Math.max(1, level.blockWidth);
		const blockHeight = Math.max(1, level.blockHeight);
		const left = Math.max(0, Math.floor(rect.x / blockWidth));
		const top = Math.max(0, Math.floor(rect.y / blockHeight));
		const right = Math.min(
			Math.ceil(level.width / blockWidth) - 1,
			Math.floor(Math.max(rect.x, rect.x + rect.width - 1) / blockWidth),
		);
		const bottom = Math.min(
			Math.ceil(level.height / blockHeight) - 1,
			Math.floor(Math.max(rect.y, rect.y + rect.height - 1) / blockHeight),
		);
		const addresses: PyramidTileAddress[] = [];
		for (let row = top; row <= bottom; row++) {
			for (let column = left; column <= right; column++) { addresses.push({ column, row }); }
		}
		return addresses;
	}

	private _rectForAddress(level: TiffPageEntry, address: PyramidTileAddress): Rect {
		const blockWidth = Math.max(1, level.blockWidth);
		const blockHeight = Math.max(1, level.blockHeight);
		const x = address.column * blockWidth;
		const y = address.row * blockHeight;
		return {
			x,
			y,
			width: Math.min(blockWidth, level.width - x),
			height: Math.min(blockHeight, level.height - y),
		};
	}

	/**
	 * Missing independently-decodable blocks, nearest the viewport centre first.
	 *
	 * Returning blocks rather than one enclosing rectangle lets a remote COG
	 * paint as each HTTP range arrives. It also avoids fetching already cached
	 * blocks caught between two missing islands in an enclosing rectangle.
	 */
	missingRects(level: TiffPageEntry, wanted: Rect): Rect[] {
		const centreX = wanted.x + wanted.width / 2;
		const centreY = wanted.y + wanted.height / 2;
		const missing: Rect[] = [];
		for (const address of this._addresses(level, wanted)) {
			const cached = this._tiles.get(this._key(level.index, address.column, address.row));
			if (cached) {
				cached.lastUsed = ++this._clock;
				continue;
			}
			missing.push(this._rectForAddress(level, address));
		}
		return missing.sort((a, b) => {
			const distanceA = Math.abs(a.x + a.width / 2 - centreX) + Math.abs(a.y + a.height / 2 - centreY);
			const distanceB = Math.abs(b.x + b.width / 2 - centreX) + Math.abs(b.y + b.height / 2 - centreY);
			return distanceA - distanceB;
		});
	}

	/** Whether the selected level can cover this viewport within the tile cache. */
	canRetain(level: TiffPageEntry, wanted: Rect): boolean {
		const pixels = this._addresses(level, wanted)
			.map(address => this._rectForAddress(level, address))
			.reduce((sum, rect) => sum + rect.width * rect.height, 0);
		return pixels <= this._maxTilePixels;
	}

	/** Bounds of blocks from `level` already visible within the requested area. */
	loadedBounds(level: TiffPageEntry, wanted: Rect): Rect | null {
		const loaded = this._addresses(level, wanted)
			.filter(address => this._tiles.has(this._key(level.index, address.column, address.row)))
			.map(address => this._rectForAddress(level, address));
		if (!loaded.length) { return null; }
		const left = Math.min(...loaded.map(rect => rect.x));
		const top = Math.min(...loaded.map(rect => rect.y));
		const right = Math.max(...loaded.map(rect => rect.x + rect.width));
		const bottom = Math.max(...loaded.map(rect => rect.y + rect.height));
		return { x: left, y: top, width: right - left, height: bottom - top };
	}

	loadedSummary(level: TiffPageEntry, wanted: Rect): { blocks: number, pixels: number, bounds: Rect | null } {
		const addresses = this._addresses(level, wanted)
			.filter(address => this._tiles.has(this._key(level.index, address.column, address.row)));
		let pixels = 0;
		for (const address of addresses) {
			const rect = this._rectForAddress(level, address);
			pixels += rect.width * rect.height;
		}
		return { blocks: addresses.length, pixels, bounds: this.loadedBounds(level, wanted) };
	}

	/**
	 * The block-aligned bounding rectangle of detail not already resident.
	 * Existing tiles are touched for LRU purposes and never requested again.
	 */
	missingRect(level: TiffPageEntry, wanted: Rect): Rect | null {
		const missing = this.missingRects(level, wanted);
		if (!missing.length) { return null; }
		const left = Math.min(...missing.map(rect => rect.x));
		const top = Math.min(...missing.map(rect => rect.y));
		const right = Math.max(...missing.map(rect => rect.x + rect.width));
		const bottom = Math.max(...missing.map(rect => rect.y + rect.height));
		return { x: left, y: top, width: right - left, height: bottom - top };
	}

	/** Add a decoded region as independently retained block tiles. */
	commitRegion(level: TiffPageEntry, rect: Rect, imageData: ImageData | HTMLCanvasElement): void {
		const blockWidth = Math.max(1, level.blockWidth);
		const blockHeight = Math.max(1, level.blockHeight);
		for (const address of this._addresses(level, rect)) {
			const key = this._key(level.index, address.column, address.row);
			if (this._tiles.has(key)) { continue; }
			const x = address.column * blockWidth;
			const y = address.row * blockHeight;
			const width = Math.min(blockWidth, level.width - x);
			const height = Math.min(blockHeight, level.height - y);
			const sourceX = x - rect.x;
			const sourceY = y - rect.y;
			if (sourceX < 0 || sourceY < 0 || sourceX + width > imageData.width || sourceY + height > imageData.height) {
				continue;
			}

			const canvas = document.createElement('canvas');
			canvas.className = 'pyramid-tile';
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext('2d');
			if (!context) { continue; }
			if ('data' in imageData) { context.putImageData(imageData, -sourceX, -sourceY); }
			else { context.drawImage(imageData, -sourceX, -sourceY); }
			const reduction = Math.max(1, level.reduction);
			canvas.style.left = `${(x * reduction / this.fullWidth) * 100}%`;
			canvas.style.top = `${(y * reduction / this.fullHeight) * 100}%`;
			canvas.style.width = `${(width * reduction / this.fullWidth) * 100}%`;
			canvas.style.height = `${(height * reduction / this.fullHeight) * 100}%`;
			// A finer level always wins in overlap, independent of arrival order.
			canvas.style.zIndex = String(1_000_000 - reduction);
			this.element.appendChild(canvas);
			const pixels = width * height;
			this._tiles.set(key, {
				...address, key, level: level.index, reduction, pixels,
				lastUsed: ++this._clock, element: canvas,
			});
			this._tilePixels += pixels;
		}
		this._evict();
	}

	/** Finest resident level covering the entire current view, for truthful status. */
	finestVisibleLevel(levels: TiffPageEntry[], visibleInFull: Rect): TiffPageEntry | null {
		for (const level of levels) {
			const reduction = Math.max(1, level.reduction);
			const atLevel = {
				x: visibleInFull.x / reduction,
				y: visibleInFull.y / reduction,
				width: visibleInFull.width / reduction,
				height: visibleInFull.height / reduction,
			};
			const addresses = this._addresses(level, atLevel);
			if (addresses.length > 0
				&& addresses.every(address => this._tiles.has(this._key(level.index, address.column, address.row)))) {
				return level;
			}
		}
		return null;
	}

	get tileCount(): number { return this._tiles.size; }
	get tilePixels(): number { return this._tilePixels; }

	private _evict(): void {
		if (this._tilePixels <= this._maxTilePixels) { return; }
		const oldest = [...this._tiles.values()].sort((a, b) => a.lastUsed - b.lastUsed);
		for (const tile of oldest) {
			if (this._tilePixels <= this._maxTilePixels) { break; }
			this._tiles.delete(tile.key);
			this._tilePixels -= tile.pixels;
			tile.element.remove();
		}
	}
}
