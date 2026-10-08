import { imageRaster, type ActiveImage } from './active-image.js';
import { DecodeWorkerClient } from './decode-worker-client.js';
import { ImageRenderer, ImageStatsCalculator, NormalizationHelper } from './normalization-helper.js';
import type { DecodedLayeredPreview, LayeredDocumentFormat, LayeredDocumentSummary, LayeredPixelArray } from './layered-document.js';
import type { DeferredRenderOptions } from './types.js';
import { PerfTrace } from './perf-trace.js';

type VsCodeApi = { postMessage: (msg: any) => any };

type PsdPool = Promise<{ strips: typeof import('./strip-parallel-decode.js'); wasm: any }>;

function startPsdPool(): PsdPool {
	const tools = Promise.all([import('./strip-parallel-decode.js'), import('./tiff-wasm-wrapper.js')])
		.then(async ([strips, wrapper]) => {
			strips.prewarmStripPool();
			return { strips, wasm: wrapper.getWasmModuleSync() || await wrapper.getWasmModule() };
		});
	tools.catch(() => {});
	return tools;
}

async function decodeLayeredLocally(format: LayeredDocumentFormat, buffer: ArrayBuffer, options?: Record<string, any>) {
	const url = (window as any).__tiffVisualizerVendorAssets?.layeredPreviewFallback;
	if (!url) { throw new Error('Layered preview fallback asset is unavailable'); }
	const decoder = await import(url) as typeof import('./layered-preview-decoders.js');
	return decoder.decodeLayeredPreview(format, buffer, options || {});
}

export class LayeredPreviewProcessor {
  resetForNewFile(): void {
    this._isInitialLoad = true;
    this._pendingRenderData = null;
    this.reset();
  }

  get activeImage(): ActiveImage {
      return { stats: this._cachedStats, raster: imageRaster(this._lastRaw ? { ...this._lastRaw, data: this.activeData() } : null, { isFloat: this._lastRaw?.sampleFormat === 3, typeMax: this._lastRaw?.sampleFormat === 3 ? 1 : this._lastRaw?.bitDepth === 16 ? 65535 : 255 }),
          readPixel: (x, y, width, height) => this.getColorAtPixel(x, y, width, height), pixelDisplay: 'native' };
  }

	settingsManager: any;
	vscode: VsCodeApi;
	decodeWorker: DecodeWorkerClient | null = null;
	loadSignal: AbortSignal | undefined;
	_isInitialLoad = true;
	_pendingRenderData: boolean | null = null;
	_lastRenderUsedWebGL = false;
	_lastRaw: DecodedLayeredPreview | null = null;
	document: LayeredDocumentSummary | null = null;
	metadata: Record<string, string | number | boolean> = {};
	_cachedStats: { min: number; max: number } | undefined;
	previewMode: 'integrated' | 'reconstructed' = 'integrated';
	decodeEditableLayers = true;
	onLayersReady: ((decoded: DecodedLayeredPreview) => void) | null = null;
	private _deferredDecodeToken = 0;
	private _deferredLayersPromise: Promise<void> | null = null;

	constructor(settingsManager: any, vscode: VsCodeApi) {
		this.settingsManager = settingsManager;
		this.vscode = vscode;
	}

	async load(src: string, format: LayeredDocumentFormat) {
		const signal = this.loadSignal;
		const splitLayeredDecode = this.decodeEditableLayers &&
			(format === 'psd' || format === 'psb' || format === 'ora' || format === 'kra');
		// The composite of a PSD/PSB decodes on the strip pool; boot it (and the
		// WebAssembly it plans with) while the file is read.
		const psdPool = splitLayeredDecode && (format === 'psd' || format === 'psb') ? startPsdPool() : null;
		let buffer = await DecodeWorkerClient.fetchArrayBuffer(src, signal, format);
		if (signal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
		let decoded: DecodedLayeredPreview | null = null;
		if (psdPool) {
			const parallel = await this._decodePsdPreviewParallel(psdPool, buffer, src, format, signal);
			decoded = parallel.decoded;
			buffer = parallel.buffer;
		}
		decoded ??= await DecodeWorkerClient.decodeWithFallback(
			this.decodeWorker, format, buffer, src, signal,
			(localBuffer, options) => decodeLayeredLocally(format, localBuffer, options),
			splitLayeredDecode ? { previewOnly: true } : {},
		);
		this._cachedStats = undefined;
		this._lastRaw = decoded;
		this.previewMode = 'integrated';
		this.document = decoded.document;
		this.metadata = decoded.metadata || {};
		this._postFormatInfo(decoded);
		// A buffer still attached here (the PSD path keeps it) saves reading the
		// whole document again for its layers.
		if (splitLayeredDecode) { this._startDeferredLayerDecode(src, format, signal, buffer.byteLength ? buffer : undefined); }
		const canvas = document.createElement('canvas');
		canvas.width = decoded.width;
		canvas.height = decoded.height;
		if (this._isInitialLoad) {
			this._pendingRenderData = true;
			return { canvas, imageData: new ImageData(decoded.width, decoded.height) };
		}
		return { canvas, imageData: this.renderWithSettings() };
	}

	/**
	 * PSD/PSB preview: the composite rows on the strip pool, byte for byte
	 * ag-psd's, while the layered worker parses only the document structure.
	 * Returns null to use the ordinary ag-psd preview, with a buffer that is
	 * still readable (refetched if the worker already took it).
	 */
	private async _decodePsdPreviewParallel(
		psdPool: PsdPool,
		buffer: ArrayBuffer,
		src: string,
		format: LayeredDocumentFormat,
		signal: AbortSignal | undefined,
	): Promise<{ decoded: DecodedLayeredPreview | null; buffer: ArrayBuffer }> {
		const tools = await psdPool.catch((): null => null);
		if (!tools) { return { decoded: null, buffer }; }
		let structure: Promise<DecodedLayeredPreview> | null = null;
		const composite = await tools.strips.decodePsdCompositeParallel(buffer, tools.wasm, () => {
			structure = DecodeWorkerClient.decodeWithFallback(
				this.decodeWorker, format, buffer, src, signal,
				(localBuffer, options) => decodeLayeredLocally(format, localBuffer, options),
				{ previewOnly: true, skipComposite: true, returnSource: true },
			);
			structure.catch(() => {});
		});
		const result = structure ? await (structure as Promise<DecodedLayeredPreview & { sourceBuffer?: ArrayBuffer }>).catch((): null => null) : null;
		if (signal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
		const { sourceBuffer, ...parsed } = result || {} as DecodedLayeredPreview & { sourceBuffer?: ArrayBuffer };
		if (sourceBuffer instanceof ArrayBuffer) { buffer = sourceBuffer; }
		if (composite && result && parsed.width === composite.width && parsed.height === composite.height) {
			for (const timing of composite.timings) { PerfTrace.detail(timing.name, timing.durationMs); }
			PerfTrace.note('psd-composite', `${composite.workers} strip workers`);
			return {
				buffer,
				decoded: {
					...parsed,
					data: composite.data,
					metadata: { ...parsed.metadata, decoder: `rust-psd-composite (${composite.workers} strip workers) + ag-psd` },
				},
			};
		}
		// The worker took the bytes and did not hand them back.
		if (!buffer.byteLength) { buffer = await DecodeWorkerClient.fetchArrayBuffer(src, signal, format); }
		return { decoded: null, buffer };
	}

	private _startDeferredLayerDecode(
		src: string,
		format: LayeredDocumentFormat,
		signal: AbortSignal | undefined,
		source?: ArrayBuffer,
	): void {
		const token = ++this._deferredDecodeToken;
		this._deferredLayersPromise = new Promise<void>(resolve => setTimeout(resolve, 0)).then(async () => {
			const buffer = source || await DecodeWorkerClient.fetchArrayBuffer(src, signal, `${format}-layers`);
			if (signal?.aborted || token !== this._deferredDecodeToken) { return; }
			const decoded = await DecodeWorkerClient.decodeWithFallback(
				this.decodeWorker, format, buffer, src, signal,
				(localBuffer, options) => decodeLayeredLocally(format, localBuffer, options),
				{ layersOnly: true },
			);
			if (signal?.aborted || token !== this._deferredDecodeToken || !this._lastRaw) { return; }
			const preview = this._lastRaw;
			this._lastRaw = {
				...decoded,
				data: preview.data,
				integratedData: preview.integratedData || preview.data,
			};
			this.document = decoded.document;
			this.metadata = decoded.metadata || {};
			this.onLayersReady?.(this._lastRaw);
		}).catch(error => {
			if (!signal?.aborted && token === this._deferredDecodeToken) {
				console.warn(`[LayeredPreview] Deferred ${format.toUpperCase()} layer decode failed:`, error);
			}
		}).finally(() => {
			if (token === this._deferredDecodeToken) { this._deferredLayersPromise = null; }
		});
	}

	private _postFormatInfo(decoded: DecodedLayeredPreview): void {
		this.vscode.postMessage({
			type: 'formatInfo',
			value: {
				width: decoded.width,
				height: decoded.height,
				compression: 'document-defined',
				photometricInterpretation: 2,
				planarConfig: 1,
				samplesPerPixel: decoded.channels,
				bitsPerSample: decoded.bitDepth,
				sampleFormat: decoded.sampleFormat,
				formatLabel: decoded.formatLabel,
				formatType: decoded.formatType,
				isInitialLoad: this._isInitialLoad,
				layerCount: decoded.document.layerCount,
				previewKind: decoded.document.previewKind,
				previewIsAuthoritative: decoded.document.previewIsAuthoritative,
				previewWarnings: decoded.document.warnings,
				...decoded.metadata,
			},
		});
	}

	private _render(data: LayeredPixelArray, renderOptions: DeferredRenderOptions = {}): ImageData {
		if (!this._lastRaw) { return new ImageData(1, 1); }
		const raw = this._lastRaw;
		const isFloat = raw.sampleFormat === 3;
		let stats = this._cachedStats;
		if (!stats && NormalizationHelper.needsStats(this.settingsManager.settings)) {
			stats = isFloat
				? ImageStatsCalculator.calculateFloatStats(data as Float32Array, raw.width, raw.height, raw.channels)
				: ImageStatsCalculator.calculateIntegerStats(data as any, raw.width, raw.height, raw.channels, false);
			this._cachedStats = stats;
			this.vscode.postMessage({ type: 'stats', value: stats });
		}
		const typeMax = isFloat ? 1 : raw.bitDepth === 16 ? 65535 : 255;
		const normalization = this.settingsManager.settings.normalization;
		const identityEightBitRgba =
			raw.bitDepth === 8 && raw.channels === 4 &&
			(data instanceof Uint8Array || data instanceof Uint8ClampedArray) &&
			!renderOptions.collectHistogram &&
			!this.settingsManager.settings.rgbAs24BitGrayscale &&
			(!this.settingsManager.settings.displayColormap || this.settingsManager.settings.displayColormap === 'none') &&
			NormalizationHelper.isIdentityTransformation(this.settingsManager.settings) &&
			(normalization?.gammaMode === true ||
				(normalization?.autoNormalize === false && normalization.min === 0 && normalization.max === 255));
		if (identityEightBitRgba) {
			const bytes = data as Uint8Array | Uint8ClampedArray;
			const clamped = bytes.buffer instanceof ArrayBuffer
				? new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength)
				: new Uint8ClampedArray(bytes);
			return new ImageData(clamped, raw.width, raw.height);
		}
		return ImageRenderer.render(data, raw.width, raw.height, raw.channels, isFloat, stats, this.settingsManager.settings, {
			typeMax,
			collectHistogram: renderOptions.collectHistogram === true,
		});
	}

	renderWithSettings(renderOptions: DeferredRenderOptions = {}): ImageData | null {
		if (!this._lastRaw) { return null; }
		this._lastRenderUsedWebGL = false;
		return this._render(this.activeData(), renderOptions);
	}

	hasReconstruction(): boolean { return !!this._lastRaw?.reconstructedData; }

	hasDeferredLayersPending(): boolean { return this._deferredLayersPromise !== null; }

	activeData(): LayeredPixelArray {
		if (!this._lastRaw) { return new Uint8Array(); }
		return this.previewMode === 'reconstructed' && this._lastRaw.reconstructedData
			? this._lastRaw.reconstructedData
			: this._lastRaw.integratedData || this._lastRaw.data;
	}

	setPreviewMode(mode: 'integrated' | 'reconstructed'): boolean {
		if (mode === 'reconstructed' && !this.hasReconstruction()) { return false; }
		if (this.previewMode === mode) { return false; }
		this.previewMode = mode;
		this._cachedStats = undefined;
		return true;
	}

	performDeferredRender(renderOptions: DeferredRenderOptions = {}): ImageData | null {
		if (!this._pendingRenderData || !this._lastRaw) { return null; }
		this._pendingRenderData = null;
		this._isInitialLoad = false;
		const imageData = this.renderWithSettings(renderOptions);
		this.vscode.postMessage({ type: 'refresh-status' });
		return imageData;
	}

	getColorAtPixel(x: number, y: number, naturalWidth: number, naturalHeight: number): string {
		const raw = this._lastRaw;
		if (!raw || raw.width !== naturalWidth || raw.height !== naturalHeight || x < 0 || y < 0 || x >= raw.width || y >= raw.height) { return ''; }
		const base = (y * raw.width + x) * raw.channels;
		const values: number[] = [];
		const data = this.activeData();
		for (let channel = 0; channel < raw.channels; channel++) { values.push(Number(data[base + channel])); }
		const fmt = (value: number) => raw.sampleFormat === 3 ? parseFloat(value.toFixed(6)).toString() : String(value);
		if (values.length === 4) { return `${fmt(values[0])} ${fmt(values[1])} ${fmt(values[2])} α:${fmt(values[3])}`; }
		return values.map(fmt).join(' ');
	}

	reset(): void {
		this._deferredDecodeToken++;
		this._deferredLayersPromise = null;
		this._lastRaw = null;
		this.document = null;
		this.metadata = {};
		this._pendingRenderData = null;
		this._cachedStats = undefined;
		this._isInitialLoad = true;
		this.previewMode = 'integrated';
	}
}
