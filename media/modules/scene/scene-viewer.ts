"use strict";

import { compositeChannels, type ChannelPlane, type ChannelSettings } from '../channel-composite.js';
import type { RegionSamples, TiffChannelSource } from './channel-source.js';
import {
	chooseLevel, chooseOverview, clampCamera, fitCamera, fitScale, screenToScene, tileKey, tileRect, tileSceneRect,
	tileSizeFor, visibleSceneRect, visibleTiles, zoomAt,
	type Camera, type SceneLevel, type SceneSize, type TileAddress,
} from './pyramid.js';

/**
 * A pan/zoom view of several pyramidal channel files shown as one composite.
 *
 * The picture is built from two kinds of layer, both composited with the
 * Channels panel's arithmetic (`compositeChannels`: per-channel range and tint,
 * summed):
 *
 *  - an OVERVIEW: one coarse level of every channel, read whole at the start.
 *    It is always drawn, so there is never a blank window, and it supplies the
 *    channel statistics the panel's Auto range works from;
 *  - TILES of the level the zoom calls for, read as the window needs them.
 *
 * Raw samples are cached per tile and per channel, separately from the
 * composited picture. Changing a range or tint therefore recomposites cached
 * tiles instead of decoding anything, and a channel switched off is never read.
 *
 * Overlays (cell outlines, transcripts) plug into `addOverlay`: they draw after
 * the tiles with the canvas transform set to SCENE pixels, so they share the
 * image's coordinates and its zoom.
 */

export interface SceneOverlay {
	/** `context` maps scene pixels to device pixels; `scale` is device pixels per scene pixel. */
	draw(context: CanvasRenderingContext2D, camera: Camera, scale: number): void;
}

export interface SceneViewerOptions {
	container: HTMLElement;
	sources: TiffChannelSource[];
	names: string[];
	pixelSizeUm: number;
	/** Largest overview, in pixels (all channels read whole at start). */
	overviewMaxPixels?: number;
	getSettings: () => ChannelSettings[];
	/** Channel indices to show alone, or null. */
	getSolo: () => readonly number[] | null;
	nanColor?: [number, number, number];
	initialCamera?: Camera;
	onCameraChange?: (camera: Camera) => void;
}

interface TileEntry {
	key: string;
	address: TileAddress;
	width: number;
	height: number;
	planes: (RegionSamples['data'] | null)[];
	pending: (AbortController | null)[];
	failed: boolean[];
	canvas: HTMLCanvasElement | null;
	renderedVersion: number;
	renderedMask: string;
	bytes: number;
	used: number;
}

const CACHE_BYTES = 640 * 1024 * 1024;
const MAX_ZOOM_PIXELS = 24;
const BACKGROUND = '#161616';
const EMPTY: ArrayLike<number> = new Uint8Array(0);

export class SceneViewer {
	readonly levels: SceneLevel[];
	readonly scene: SceneSize;
	readonly overviewPlanes: ChannelPlane[] = [];
	private readonly options: SceneViewerOptions;
	private readonly canvas: HTMLCanvasElement;
	private readonly hud: HTMLDivElement;
	private readonly context: CanvasRenderingContext2D;
	private readonly overviewPosition: number;
	private readonly overviewCanvas = document.createElement('canvas');
	private readonly tiles = new Map<string, TileEntry>();
	private readonly overlays: SceneOverlay[] = [];
	private readonly resizeObserver: ResizeObserver;
	private camera: Camera = { scale: 1, x: 0, y: 0 };
	private viewWidth = 1;
	private viewHeight = 1;
	private version = 0;
	private overviewVersion = -1;
	private overviewMask = '';
	private frame = 0;
	private bytes = 0;
	private clock = 0;
	private cursor: { x: number; y: number } | null = null;
	private drag: { x: number; y: number } | null = null;
	private disposed = false;
	private cameraTimer = 0;
	private loadingTiles = 0;

	private constructor(options: SceneViewerOptions, overviewPosition: number) {
		this.options = options;
		this.levels = options.sources[0].levels;
		this.scene = { width: this.levels[0].width, height: this.levels[0].height };
		this.overviewPosition = overviewPosition;

		this.canvas = document.createElement('canvas');
		this.canvas.className = 'scene-canvas';
		this.canvas.tabIndex = 0;
		const context = this.canvas.getContext('2d');
		if (!context) { throw new Error('A 2D canvas is not available.'); }
		this.context = context;
		this.hud = document.createElement('div');
		this.hud.className = 'scene-hud';
		options.container.append(this.canvas, this.hud);

		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(options.container);
		this.canvas.addEventListener('wheel', event => this.onWheel(event), { passive: false });
		this.canvas.addEventListener('pointerdown', event => this.onPointerDown(event));
		this.canvas.addEventListener('pointermove', event => this.onPointerMove(event));
		this.canvas.addEventListener('pointerup', event => this.onPointerUp(event));
		this.canvas.addEventListener('pointercancel', event => this.onPointerUp(event));
		this.canvas.addEventListener('pointerleave', () => { this.cursor = null; this.updateHud(); });
		this.canvas.addEventListener('dblclick', () => this.fit());
		this.canvas.addEventListener('keydown', event => this.onKey(event));
		this.resize();
		this.camera = options.initialCamera ?? fitCamera(this.viewWidth, this.viewHeight, this.scene.width, this.scene.height);
	}

	/** Read the overview of every channel and start drawing. */
	static async create(options: SceneViewerOptions): Promise<SceneViewer> {
		const { sources } = options;
		const first = sources[0].levels;
		for (const source of sources) {
			const level = source.levels[0];
			if (level.width !== first[0].width || level.height !== first[0].height || source.levels.length !== first.length) {
				throw new Error('The channel images differ in size or in number of resolution levels.');
			}
		}
		const position = chooseOverview(first, options.overviewMaxPixels ?? 2_000_000);
		const viewer = new SceneViewer(options, position);
		await viewer.readOverview();
		viewer.requestRender();
		return viewer;
	}

	private async readOverview(): Promise<void> {
		const level = this.levels[this.overviewPosition];
		const rect = { x: 0, y: 0, width: level.width, height: level.height };
		const regions = await Promise.all(this.options.sources.map(source => source.readRegion(this.overviewPosition, rect)));
		regions.forEach((region, index) => this.overviewPlanes.push({
			index, name: this.options.names[index] ?? `Channel ${index + 1}`, data: region.data, width: region.width, height: region.height,
		}));
		this.overviewCanvas.width = level.width;
		this.overviewCanvas.height = level.height;
	}

	addOverlay(overlay: SceneOverlay): void { this.overlays.push(overlay); this.requestRender(); }

	get currentCamera(): Camera { return { ...this.camera }; }

	setCamera(camera: Camera): void { this.camera = this.clamped(camera); this.cameraChanged(); }

	fit(): void {
		this.camera = fitCamera(this.viewWidth, this.viewHeight, this.scene.width, this.scene.height);
		this.cameraChanged();
	}

	/** Display settings (range, tint, visibility, solo) changed: recomposite, reading only what is new. */
	invalidate(): void {
		this.version++;
		this.requestRender();
	}

	requestRender(): void {
		if (this.disposed || this.frame) { return; }
		this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
	}

	dispose(): void {
		this.disposed = true;
		cancelAnimationFrame(this.frame);
		clearTimeout(this.cameraTimer);
		this.resizeObserver.disconnect();
		for (const entry of this.tiles.values()) { entry.pending.forEach(controller => controller?.abort()); }
		this.tiles.clear();
		this.canvas.remove();
		this.hud.remove();
	}

	// --- display state -----------------------------------------------------

	/** Channels the composite needs right now: visible, and in the solo set when there is one. */
	private activeChannels(): boolean[] {
		const settings = this.options.getSettings();
		const solo = this.options.getSolo();
		return this.options.sources.map((_source, index) => !!settings[index]?.visible && (solo === null || solo.includes(index)));
	}

	private maskOf(active: boolean[]): string { return active.map(on => (on ? '1' : '0')).join(''); }

	private composite(planes: ChannelPlane[], width: number, height: number): ImageData {
		return compositeChannels(planes, this.options.getSettings(), width, height, {
			soloIndex: this.options.getSolo(), nanColor: this.options.nanColor,
		});
	}

	private renderOverview(active: boolean[]): void {
		const mask = this.maskOf(active);
		if (this.overviewVersion === this.version && this.overviewMask === mask) { return; }
		const level = this.levels[this.overviewPosition];
		const context = this.overviewCanvas.getContext('2d');
		if (!context) { return; }
		context.putImageData(this.composite(this.overviewPlanes, level.width, level.height), 0, 0);
		this.overviewVersion = this.version;
		this.overviewMask = mask;
	}

	// --- rendering ---------------------------------------------------------

	private render(): void {
		if (this.disposed) { return; }
		const started = performance.now();
		const active = this.activeChannels();
		const mask = this.maskOf(active);
		this.renderOverview(active);

		const levelPosition = chooseLevel(this.levels, this.camera.scale);
		const wanted: TileEntry[] = [];
		if (levelPosition < this.overviewPosition) {
			const level = this.levels[levelPosition];
			const tileSize = tileSizeFor(level);
			const visible = visibleSceneRect(this.camera, this.viewWidth, this.viewHeight, this.scene.width, this.scene.height);
			for (const address of visibleTiles(level, levelPosition, tileSize, visible, this.scene)) {
				wanted.push(this.entryFor(address, level, tileSize));
			}
		}
		const wantedKeys = new Set(wanted.map(entry => entry.key));
		for (const entry of this.tiles.values()) {
			if (!wantedKeys.has(entry.key)) { entry.pending.forEach((controller, index) => { if (controller) { controller.abort(); entry.pending[index] = null; } }); }
		}

		// Composite tiles whose samples are all here, within a frame budget so a
		// burst of arrivals or a slider drag stays responsive.
		let compositing = false;
		for (const entry of wanted) {
			entry.used = ++this.clock;
			this.load(entry, active);
			if (!this.hasPlanes(entry, active)) { continue; }
			if (entry.renderedVersion === this.version && entry.renderedMask === mask && entry.canvas) { continue; }
			if (performance.now() - started > 10 && entry.canvas) { compositing = true; continue; }
			this.compositeTile(entry, active, mask);
		}

		this.draw(wanted, levelPosition);
		this.evict(wantedKeys);
		this.loadingTiles = wanted.filter(entry => !this.hasPlanes(entry, active) && !entry.failed.some(Boolean)).length;
		this.updateHud(levelPosition);
		if (compositing) { this.requestRender(); }
	}

	private draw(wanted: TileEntry[], levelPosition: number): void {
		const dpr = window.devicePixelRatio || 1;
		const context = this.context;
		context.setTransform(1, 0, 0, 1, 0, 0);
		context.fillStyle = BACKGROUND;
		context.fillRect(0, 0, this.canvas.width, this.canvas.height);
		const scale = this.camera.scale * dpr;
		context.setTransform(scale, 0, 0, scale, this.camera.x * dpr, this.camera.y * dpr);

		// A level pixel larger than ~2 screen pixels is shown as the square it is.
		const overview = this.levels[this.overviewPosition];
		context.imageSmoothingEnabled = overview.width / this.scene.width * this.camera.scale < 0.5;
		context.drawImage(this.overviewCanvas, 0, 0, this.scene.width, this.scene.height);

		const level = this.levels[levelPosition];
		context.imageSmoothingEnabled = (this.scene.width / level.width) * this.camera.scale < 0.5;
		const tileSize = tileSizeFor(level);
		for (const entry of wanted) {
			if (!entry.canvas) { continue; }
			const target = tileSceneRect(level, entry.address, tileSize, this.scene);
			context.drawImage(entry.canvas, target.x, target.y, target.width, target.height);
		}
		for (const overlay of this.overlays) { overlay.draw(context, this.camera, scale); }
		context.setTransform(1, 0, 0, 1, 0, 0);
	}

	// --- tiles -------------------------------------------------------------

	private entryFor(address: TileAddress, level: SceneLevel, tileSize: number): TileEntry {
		const key = tileKey(address);
		let entry = this.tiles.get(key);
		if (!entry) {
			const rect = tileRect(level, address, tileSize);
			const count = this.options.sources.length;
			entry = {
				key, address, width: rect.width, height: rect.height,
				planes: new Array(count).fill(null), pending: new Array(count).fill(null), failed: new Array(count).fill(false),
				canvas: null, renderedVersion: -1, renderedMask: '', bytes: 0, used: ++this.clock,
			};
			this.tiles.set(key, entry);
		}
		return entry;
	}

	private hasPlanes(entry: TileEntry, active: boolean[]): boolean {
		return active.every((on, index) => !on || entry.planes[index] !== null);
	}

	/** Start reads for the active channels this tile lacks. */
	private load(entry: TileEntry, active: boolean[]): void {
		const level = this.levels[entry.address.level];
		const rect = { ...tileRect(level, entry.address, tileSizeFor(level)) };
		active.forEach((on, index) => {
			if (!on || entry.planes[index] || entry.pending[index] || entry.failed[index]) { return; }
			const controller = new AbortController();
			entry.pending[index] = controller;
			this.options.sources[index].readRegion(entry.address.level, rect, controller.signal).then(region => {
				if (entry.pending[index] !== controller) { return; }
				entry.pending[index] = null;
				entry.planes[index] = region.data;
				entry.bytes += region.data.byteLength;
				this.bytes += region.data.byteLength;
				this.requestRender();
			}).catch(error => {
				if (entry.pending[index] === controller) { entry.pending[index] = null; }
				if (error instanceof DOMException && error.name === 'AbortError') { return; }
				entry.failed[index] = true;
				console.warn(`[Scene] Tile ${entry.key} of channel ${index + 1} could not be read:`, error);
				this.requestRender();
			});
		});
	}

	private compositeTile(entry: TileEntry, active: boolean[], mask: string): void {
		const planes: ChannelPlane[] = this.options.sources.map((_source, index) => ({
			index, name: this.options.names[index] ?? '', data: active[index] ? entry.planes[index] ?? EMPTY : EMPTY, width: entry.width, height: entry.height,
		}));
		const image = this.composite(planes, entry.width, entry.height);
		if (!entry.canvas) {
			entry.canvas = document.createElement('canvas');
			entry.canvas.width = entry.width;
			entry.canvas.height = entry.height;
			const added = entry.width * entry.height * 4;
			entry.bytes += added;
			this.bytes += added;
		}
		entry.canvas.getContext('2d')?.putImageData(image, 0, 0);
		entry.renderedVersion = this.version;
		entry.renderedMask = mask;
	}

	/** Drop the least recently used tiles that are not on screen once the cache is over budget. */
	private evict(wantedKeys: Set<string>): void {
		if (this.bytes <= CACHE_BYTES) { return; }
		const candidates = [...this.tiles.values()].filter(entry => !wantedKeys.has(entry.key)).sort((a, b) => a.used - b.used);
		for (const entry of candidates) {
			if (this.bytes <= CACHE_BYTES * 0.8) { break; }
			entry.pending.forEach(controller => controller?.abort());
			this.bytes -= entry.bytes;
			this.tiles.delete(entry.key);
		}
	}

	// --- interaction -------------------------------------------------------

	private resize(): void {
		const rect = this.options.container.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		this.viewWidth = Math.max(1, rect.width);
		this.viewHeight = Math.max(1, rect.height);
		this.canvas.width = Math.round(this.viewWidth * dpr);
		this.canvas.height = Math.round(this.viewHeight * dpr);
		this.canvas.style.width = `${this.viewWidth}px`;
		this.canvas.style.height = `${this.viewHeight}px`;
		this.requestRender();
	}

	private clamped(camera: Camera): Camera {
		return clampCamera(camera, this.viewWidth, this.viewHeight, this.scene.width, this.scene.height);
	}

	private cameraChanged(): void {
		this.requestRender();
		clearTimeout(this.cameraTimer);
		this.cameraTimer = window.setTimeout(() => this.options.onCameraChange?.(this.currentCamera), 250);
	}

	private zoomBy(factor: number, x: number, y: number): void {
		const minScale = fitScale(this.viewWidth, this.viewHeight, this.scene.width, this.scene.height) * 0.5;
		this.camera = this.clamped(zoomAt(this.camera, factor, x, y, minScale, MAX_ZOOM_PIXELS));
		this.cameraChanged();
	}

	private onWheel(event: WheelEvent): void {
		event.preventDefault();
		const rect = this.canvas.getBoundingClientRect();
		// deltaMode 1 is lines; a pinch gesture arrives as ctrl+wheel with small deltas.
		const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
		this.zoomBy(Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0015)), event.clientX - rect.left, event.clientY - rect.top);
	}

	private onPointerDown(event: PointerEvent): void {
		if (event.button !== 0 && event.button !== 1) { return; }
		this.canvas.setPointerCapture(event.pointerId);
		this.canvas.focus();
		this.drag = { x: event.clientX, y: event.clientY };
		this.canvas.classList.add('dragging');
	}

	private onPointerMove(event: PointerEvent): void {
		const rect = this.canvas.getBoundingClientRect();
		this.cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
		if (this.drag) {
			this.camera = this.clamped({ ...this.camera, x: this.camera.x + event.clientX - this.drag.x, y: this.camera.y + event.clientY - this.drag.y });
			this.drag = { x: event.clientX, y: event.clientY };
			this.cameraChanged();
		}
		this.updateHud();
	}

	private onPointerUp(event: PointerEvent): void {
		if (this.canvas.hasPointerCapture(event.pointerId)) { this.canvas.releasePointerCapture(event.pointerId); }
		this.drag = null;
		this.canvas.classList.remove('dragging');
	}

	private onKey(event: KeyboardEvent): void {
		const centre = { x: this.viewWidth / 2, y: this.viewHeight / 2 };
		if (event.key === '+' || event.key === '=') { this.zoomBy(1.5, centre.x, centre.y); }
		else if (event.key === '-' || event.key === '_') { this.zoomBy(1 / 1.5, centre.x, centre.y); }
		else if (event.key === '0') { this.fit(); }
		else if (event.key.startsWith('Arrow')) {
			const step = 80 * (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? 1 : -1);
			const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
			this.camera = this.clamped({ ...this.camera, x: this.camera.x + (horizontal ? step : 0), y: this.camera.y + (horizontal ? 0 : step) });
			this.cameraChanged();
		} else { return; }
		event.preventDefault();
	}

	/** Scene pixel under a client position, or null outside the slide. */
	sceneAt(clientX: number, clientY: number): { x: number; y: number } | null {
		const rect = this.canvas.getBoundingClientRect();
		const point = screenToScene(this.camera, clientX - rect.left, clientY - rect.top);
		return point.x >= 0 && point.y >= 0 && point.x < this.scene.width && point.y < this.scene.height ? point : null;
	}

	private updateHud(levelPosition = chooseLevel(this.levels, this.camera.scale)): void {
		const parts: string[] = [];
		if (this.cursor) {
			const point = screenToScene(this.camera, this.cursor.x, this.cursor.y);
			if (point.x >= 0 && point.y >= 0 && point.x < this.scene.width && point.y < this.scene.height) {
				const micron = this.options.pixelSizeUm;
				parts.push(`x ${Math.floor(point.x)}, y ${Math.floor(point.y)} px`);
				parts.push(`${(point.x * micron).toFixed(1)}, ${(point.y * micron).toFixed(1)} µm`);
			}
		}
		parts.push(`${Math.round(this.camera.scale * 1000) / 10}%`);
		parts.push(`level ${Math.min(levelPosition, this.overviewPosition) + 1}/${this.levels.length}`);
		if (this.loadingTiles > 0) { parts.push(`loading ${this.loadingTiles} tile${this.loadingTiles === 1 ? '' : 's'}…`); }
		this.hud.textContent = parts.join('  ·  ');
	}
}
