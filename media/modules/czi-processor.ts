/**
 * Zeiss CZI through ranged reads (`czi-source.ts`). A plane of an ordinary
 * file decodes from only its own subblocks; a mosaic too large to hold whole
 * opens at a stored pyramid level that fits the window and serves finer
 * levels region by region through the same `PyramidScene` large TIFFs use.
 * Without range support or a decode worker it reads the file whole, as before.
 *
 * The scene contract (shared with TiffProcessor): `pageDirectory` lists the
 * levels (index 0 the full plane, overviews by reduction), `pageIndex` is the
 * level shown as the base canvas, `renderRegion` renders a rectangle of a
 * level with the image-wide statistics, and the readout methods answer from
 * decoded samples only.
 */
import { ScientificArrayProcessor } from './scientific-array-processor.js';
import { CziSource, type CziLayout } from './czi-source.js';
import { ImageRenderer, NormalizationHelper } from './normalization-helper.js';
import type { TiffPageEntry } from './tiff-pages.js';
import { PerfTrace } from './perf-trace.js';

/** Planes above this many pixels open as a pyramid scene. */
const SCENE_MIN_PIXELS = 50_000_000;
/** The overview: the finest level whose plane stays within this many pixels. */
const OVERVIEW_MAX_PIXELS = 8_000_000;
const REGION_CACHE_MAX_BYTES = 96 * 1024 * 1024;
const READOUT_BLOCK = 256;

type Rect = { x: number, y: number, width: number, height: number };
interface CachedRegion { level: number, x: number, y: number, width: number, height: number, channels: number, data: Float32Array, bytes: number }

export class CziProcessor extends ScientificArrayProcessor {
	private _source: CziSource | null = null;
	private _sourceTried = '';
	private _indices: Record<string, number> = {};
	private _layout: CziLayout | null = null;
	private _regionCache = new Map<string, CachedRegion>();
	private _regionCacheBytes = 0;
	private _sceneGeneration = 0;

	/** Levels of the plane shown as a scene; empty when the plane is decoded whole. */
	pageDirectory: TiffPageEntry[] = [];
	pageIndex = 0;
	readonly isRemoteSource = false;
	readonly isProgressiveRemoteBase = false;
	readonly hasGeneratedPreview = false;
	_lastStatistics: { min: number, max: number } | null = null;

	get isScene(): boolean { return this.pageDirectory.length > 1; }

	resetForNewFile(): void {
		super.resetForNewFile();
		this._clearScene();
	}

	private _clearScene(): void {
		this.pageDirectory = [];
		this.pageIndex = 0;
		this._lastStatistics = null;
		this._regionCache.clear();
		this._regionCacheBytes = 0;
		this._sceneGeneration++;
	}

	async load(src: string, decodeOptions: Record<string, any> = {}) {
		const signal = this.loadSignal;
		if (this._sourceTried !== src) {
			this._sourceTried = src;
			this._source = await CziSource.open(src, this.decodeWorker, signal);
		}
		const source = this._source;
		if (signal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
		if (!source) {
			this._clearScene();
			return super.load(src, decodeOptions);
		}
		try {
			return await this._loadCziRanged(source, decodeOptions);
		} catch (error) {
			if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) { throw error; }
			console.warn('[CZI] ranged read failed, reading the file whole:', error);
			this._source = null;
			this._clearScene();
			return super.load(src, decodeOptions);
		}
	}

	private async _loadCziRanged(source: CziSource, decodeOptions: Record<string, any>) {
		const signal = this.loadSignal;
		const indices: Record<string, number> = { ...(decodeOptions.indices || {}) };
		const started = performance.now();
		const layout = await source.layout(indices);
		const metadata = JSON.parse(layout.metadataJson || '{}');
		const factors = layout.factors?.length ? layout.factors : [1];
		const full = layout.width * layout.height;
		const sceneFactors = full > SCENE_MIN_PIXELS ? sceneLevels(layout.width, layout.height, factors) : [1];
		const overview = sceneFactors.find(factor => (layout.width / factor) * (layout.height / factor) <= OVERVIEW_MAX_PIXELS)
			?? sceneFactors[sceneFactors.length - 1];
		const decoded = await source.region({ indices, factor: overview }, signal);
		if (signal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
		PerfTrace.detail('czi-ranged-read+decode', performance.now() - started);
		PerfTrace.note('czi-ranged-bytes', `${(source.bytesRead / 1048576).toFixed(1)}MB of ${(source.size / 1048576).toFixed(0)}MB`);

		this._clearScene();
		this._indices = indices;
		this._layout = layout;
		this._workerCachedSource = '';
		if (sceneFactors.length > 1) {
			this.pageDirectory = sceneFactors.map((factor, index) => ({
				index,
				width: Math.ceil(layout.width / factor),
				height: Math.ceil(layout.height / factor),
				samplesPerPixel: layout.channels,
				subfileType: index === 0 ? 0 : 1,
				kind: index === 0 ? 'image' : 'overview',
				parent: index === 0 ? null : 0,
				reduction: factor,
				subIfdCount: 0,
				blockWidth: 512,
				blockHeight: 512,
			}));
			this.pageIndex = sceneFactors.indexOf(overview);
			metadata.pyramidLevels = sceneFactors.length;
			metadata.displayedLevelReduction = overview;
		}
		decoded.metadata = { ...metadata, ...(decoded.metadata || {}) };
		const result = this._adoptDecoded(decoded, { width: layout.width, height: layout.height });
		if (this.isScene) {
			this._lastStatistics = this._decodedStats ? { ...this._decodedStats } : null;
			this._cacheRegion(this.pageIndex, 0, 0, decoded.width, decoded.height, decoded.channels, decoded.data);
		}
		return result;
	}

	private _cacheRegion(level: number, x: number, y: number, width: number, height: number, channels: number, data: Float32Array): void {
		const bytes = data.byteLength;
		if (!(bytes > 0) || bytes > REGION_CACHE_MAX_BYTES) { return; }
		const key = `${level}:${x}:${y}:${width}:${height}`;
		const previous = this._regionCache.get(key);
		if (previous) { this._regionCacheBytes -= previous.bytes; }
		this._regionCache.delete(key);
		this._regionCache.set(key, { level, x, y, width, height, channels, data, bytes });
		this._regionCacheBytes += bytes;
		while (this._regionCacheBytes > REGION_CACHE_MAX_BYTES) {
			// Keep the overview's samples: it stays visible under every detail tile.
			const oldest = [...this._regionCache.entries()].find(([, region]) => region.level !== this.pageIndex);
			if (!oldest) { break; }
			this._regionCache.delete(oldest[0]);
			this._regionCacheBytes -= oldest[1].bytes;
		}
	}

	private _formatSamples(samples: number[]): string {
		const integer = this.numericDomain.sampleFormat !== 3;
		return samples.map(value => Number.isNaN(value) ? 'NaN' : integer ? String(value) : value.toPrecision(4)).join(' ');
	}

	private _readCached(level: number, x: number, y: number): string | null {
		for (const [key, region] of this._regionCache) {
			if (region.level !== level || x < region.x || y < region.y || x >= region.x + region.width || y >= region.y + region.height) { continue; }
			this._regionCache.delete(key);
			this._regionCache.set(key, region);
			const offset = ((y - region.y) * region.width + (x - region.x)) * region.channels;
			return this._formatSamples(Array.from(region.data.subarray(offset, offset + region.channels)));
		}
		return null;
	}

	/** Best already-decoded value at a full-resolution coordinate, finest level first. Never reads. */
	readCachedScenePixel(x: number, y: number): { value: string, exact: boolean } | null {
		for (const level of this.pageDirectory) {
			const reduction = Math.max(1, level.reduction);
			const value = this._readCached(level.index, Math.floor(x / reduction), Math.floor(y / reduction));
			if (value !== null) { return { value, exact: reduction === 1 }; }
		}
		return null;
	}

	/** Exact full-resolution value; decodes and keeps the block around it. */
	async readFullResolutionPixel(x: number, y: number): Promise<string | null> {
		const storedX = Math.floor(x);
		const storedY = Math.floor(y);
		const cached = this._readCached(0, storedX, storedY);
		if (cached !== null) { return cached; }
		const full = this.pageDirectory[0];
		if (!full || storedX < 0 || storedY < 0 || storedX >= full.width || storedY >= full.height) { return null; }
		const rect = {
			x: Math.floor(storedX / READOUT_BLOCK) * READOUT_BLOCK,
			y: Math.floor(storedY / READOUT_BLOCK) * READOUT_BLOCK,
			width: 0, height: 0,
		};
		rect.width = Math.min(READOUT_BLOCK, full.width - rect.x);
		rect.height = Math.min(READOUT_BLOCK, full.height - rect.y);
		const region = await this._decodeLevelRegion(0, rect);
		return region ? this._readCached(0, storedX, storedY) : null;
	}

	async readStoredPixel(x: number, y: number): Promise<string | null> {
		const reduction = this.pageDirectory[this.pageIndex]?.reduction ?? 1;
		return this.isScene ? this.readFullResolutionPixel(x * reduction, y * reduction) : null;
	}

	private async _decodeLevelRegion(levelIndex: number, rect: Rect, signal?: AbortSignal): Promise<{ width: number, height: number, channels: number, data: Float32Array } | null> {
		const level = this.pageDirectory[levelIndex];
		if (!this._source || !level) { return null; }
		const generation = this._sceneGeneration;
		const factor = Math.max(1, level.reduction);
		const decoded = await this._source.region({
			indices: this._indices,
			factor,
			rect: { x: rect.x * factor, y: rect.y * factor, width: rect.width * factor, height: rect.height * factor },
			parallel: true,
		}, signal);
		if (generation !== this._sceneGeneration || signal?.aborted || !decoded?.data?.length) { return null; }
		this._cacheRegion(levelIndex, rect.x, rect.y, decoded.width, decoded.height, decoded.channels, decoded.data);
		return decoded;
	}

	/** A level rectangle rendered with the image-wide statistics, as the scene paints it. */
	async renderRegion(levelIndex: number, rect: Rect, signal?: AbortSignal): Promise<ImageData | null> {
		try {
			const region = await this._decodeLevelRegion(levelIndex, rect, signal);
			if (!region || signal?.aborted) { return null; }
			const settings = this.settingsManager.settings;
			const stats = this._cachedStats || this._decodedStats || this._lastStatistics || undefined;
			return ImageRenderer.render(
				region.data, region.width, region.height, region.channels, true,
				NormalizationHelper.needsStats(settings) && stats ? stats : (stats || { min: 0, max: 1 }),
				settings,
				{
					nanColor: this._getNanColor(settings),
					typeMin: this.numericDomain.typeMin,
					typeMax: this.numericDomain.typeMax,
				} as any,
			);
		} catch (error) {
			if (!signal?.aborted) { console.warn('[CZI] region decode failed:', error); }
			return null;
		}
	}

	async renderRegionCanvas(levelIndex: number, rect: Rect, signal?: AbortSignal): Promise<ImageData | null> {
		return this.renderRegion(levelIndex, rect, signal);
	}
}

/**
 * Scene levels for a plane: the stored pyramid factors, extended by halvings
 * read from the finest available level when the file stores none small enough
 * for an overview (a large mosaic without a pyramid still opens).
 */
function sceneLevels(width: number, height: number, stored: number[]): number[] {
	const factors = [...new Set([1, ...stored])].sort((a, b) => a - b);
	let coarsest = factors[factors.length - 1];
	while ((width / coarsest) * (height / coarsest) > OVERVIEW_MAX_PIXELS) {
		coarsest *= 2;
		factors.push(coarsest);
	}
	return factors;
}
