import { imageRaster, type ActiveImage, type DecodedSnapshot } from './active-image.js';
"use strict";

import { PfmProcessor } from './pfm-processor.js';
import { DecodeWorkerClient } from './decode-worker-client.js';
import { RangedFile } from './ranged-source.js';
import { PerfTrace } from './perf-trace.js';
import type { SettingsManager } from './settings-manager.js';
import type { DeferredRenderOptions } from './types.js';
import type { ScientificDecodedImage } from './types.js';

type VsCodeApi = { postMessage: (msg: any) => any };

export interface ScientificArrayProcessorConfig {
	workerFormat: 'sgi' | 'fits' | 'dicom' | 'netcdf' | 'czi' | 'nd2' | 'lif' | 'sdt' | 'jxr' | 'jp2' | 'jxl';
	/**
	 * Keep the source bytes in the decode worker between requests. Worth it for
	 * formats where one file is decoded repeatedly to show different planes, and
	 * only safe when the parser copies out of the buffer instead of aliasing it.
	 */
	cacheSourceInWorker?: boolean;
	/**
	 * Decode from partial reads (`ranged-source.ts`) with the worker's
	 * `<ranged>-ranged` format: only the parts of the file a plane needs are
	 * read. Falls back to reading the file whole when ranges are unavailable.
	 */
	ranged?: 'nd2' | 'lif';
	formatLabel: string;
	formatType: 'sgi' | 'fits' | 'dicom' | 'netcdf' | 'czi' | 'nd2' | 'lif' | 'sdt' | 'jxr' | 'jp2' | 'jxl';
	/**
	 * Report a different format type for some files. JPEG XL is the only user:
	 * an 8-bit .jxl is a photograph and wants gamma mode, while a float .jxl
	 * carries scene-referred values that gamma mode's [0, 1] would clip, so the
	 * two need different per-format defaults. Every other format here answers
	 * with one type regardless of what it decoded.
	 */
	formatTypeFor?: (numericDomain: ScientificDecodedImage['numericDomain']) => string;
	parse: (buffer: ArrayBuffer, options?: Record<string, any>) => ScientificDecodedImage | Promise<ScientificDecodedImage>;
}

/**
 * Shared renderer/lifecycle adapter for self-describing arrays.
 *
 * Most members are scientific dataset formats with plane navigation; JPEG XR
 * and JPEG XL are here because they are the same shape of problem — a Rust
 * decode returning samples of whatever type the file declares — minus the
 * navigation, which costs nothing when the decoder reports no selectors.
 */
export class ScientificArrayProcessor extends PfmProcessor {
  captureDecoded(): DecodedSnapshot | null {
      if (this.config.workerFormat !== 'dicom' || !this._lastRaw?.data)
          return null;
      const raw = { image: this._lastRaw, metadata: { ...this.metadata }, numericDomain: { ...this.numericDomain } };
      const { width, height } = raw.image;
      const decodedStats = this._decodedStats;
      return { width, height, restore: () => {
              const image = raw.image;
              if (!image?.data) {
                  return;
              }
              this._lastRaw = image;
              this.metadata = raw.metadata;
              this.numericDomain = raw.numericDomain;
              this._decodedStats = decodedStats;
              this._cachedStats = undefined;
              this._isInitialLoad = true;
              this._pendingRenderData = { displayData: image.data, width: image.width, height: image.height, channels: image.channels };
          } };
  }

  resetForNewFile(): void {
    this._isInitialLoad = true;
    this._pendingRenderData = null;
    this._lastRaw = null;
  }

  get activeImage(): ActiveImage {
      return { stats: this._cachedStats, histogram: this._lastRenderHistogram, typeMin: this.numericDomain.typeMin, raster: imageRaster(this._lastRaw, { isFloat: true, typeMax: this.numericDomain.typeMax, sourceNumericType: this.numericDomain.sourceNumericType }),
          readPixel: (x, y, width, height) => this.getColorAtPixel(x, y, width, height), pixelDisplay: 'float' };
  }

	config: ScientificArrayProcessorConfig;
	metadata: Record<string, any> = {};
	/** Source key the decode worker is believed to still hold, if any. */
	_workerCachedSource = '';
	numericDomain: ScientificDecodedImage['numericDomain'] = {
		bitsPerSample: 32,
		sampleFormat: 3,
		typeMin: 0,
		typeMax: 1,
		sourceNumericType: 'float32',
	};

	constructor(settingsManager: SettingsManager, vscode: VsCodeApi, config: ScientificArrayProcessorConfig) {
		super(settingsManager, vscode);
		this.config = config;
	}

	_rangedFile: RangedFile | null = null;
	_rangedTried = '';

	async load(src: string, decodeOptions: Record<string, any> = {}) {
		const signal = this.loadSignal;
		if (this.config.ranged && this.decodeWorker) {
			const decoded = await this._loadRanged(src, decodeOptions);
			if (decoded) { return this._adoptDecoded(decoded); }
		}
		// When the worker still holds this file, send no bytes at all: refetching
		// a large stack per plane costs far more than the decode does. On a miss
		// the worker fails the request and decodeWithFallback refetches.
		const cacheKey = this.config.cacheSourceInWorker ? src : '';
		const reuseWorkerSource = !!cacheKey
			&& this._workerCachedSource === cacheKey
			&& !!this.decodeWorker?.canDecode(this.config.workerFormat);
		const buffer = reuseWorkerSource
			? new ArrayBuffer(0)
			: await DecodeWorkerClient.fetchArrayBuffer(src, signal, this.config.workerFormat);
		if (signal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
		const options = cacheKey ? { ...decodeOptions, sourceCacheKey: cacheKey } : decodeOptions;
		let decoded: ScientificDecodedImage;
		try {
			decoded = await DecodeWorkerClient.decodeWithFallback(
				this.decodeWorker,
				this.config.workerFormat,
				buffer,
				src,
				signal,
				(localBuffer, opts) => this.config.parse(localBuffer, opts),
				options,
			);
		} catch (error) {
			// Never let a stale cache assumption strand the next load.
			this._workerCachedSource = '';
			throw error;
		}
		this._workerCachedSource = cacheKey;
		return this._adoptDecoded(decoded);
	}

	/** The ranged decode of `src`, or null to read it whole instead. */
	async _loadRanged(src: string, decodeOptions: Record<string, any>): Promise<ScientificDecodedImage | null> {
		const signal = this.loadSignal;
		const worker = this.decodeWorker!;
		const booting = worker.whenBooting?.();
		if (booting) { await booting; }
		if (!worker.canDecode(`${this.config.ranged}-ranged`)) { return null; }
		if (this._rangedTried !== src) {
			this._rangedTried = src;
			this._rangedFile = await RangedFile.open(src, signal);
		}
		const file = this._rangedFile;
		if (!file) { return null; }
		const started = performance.now();
		const readBefore = file.bytesRead;
		try {
			const decoded = await file.decode(worker, this.config.ranged!, decodeOptions, signal);
			PerfTrace.detail(`${this.config.ranged}-ranged-read+decode`, performance.now() - started);
			PerfTrace.note(`${this.config.ranged}-ranged-bytes`, `${((file.bytesRead - readBefore) / 1048576).toFixed(1)}MB of ${(file.size / 1048576).toFixed(0)}MB in ${file.lastRoundTrips} reads`);
			this._workerCachedSource = '';
			return decoded;
		} catch (error) {
			if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) { throw error; }
			console.warn(`[${this.config.formatLabel}] ranged read failed, reading the file whole:`, error);
			this._rangedFile = null;
			return null;
		}
	}

	/** Keep a decoded plane and hand the viewer its canvas (deferred on first load). */
	_adoptDecoded(decoded: ScientificDecodedImage, formatInfoSize?: { width: number, height: number }) {
		this._cachedStats = undefined;
		this._decodedStats = decoded.stats;
		this.metadata = decoded.metadata || {};
		this.numericDomain = decoded.numericDomain;
		this._lastRaw = {
			width: decoded.width,
			height: decoded.height,
			data: decoded.data,
			channels: decoded.channels,
		};

		const canvas = document.createElement('canvas');
		canvas.width = decoded.width;
		canvas.height = decoded.height;
		this._postScientificFormatInfo(formatInfoSize ? { ...decoded, ...formatInfoSize } : decoded);

		if (this._isInitialLoad) {
			this._pendingRenderData = {
				displayData: decoded.data,
				width: decoded.width,
				height: decoded.height,
				channels: decoded.channels,
			};
			return { canvas, imageData: new ImageData(decoded.width, decoded.height) };
		}

		const imageData = this._toImageDataFloat(decoded.data, decoded.width, decoded.height, decoded.channels, {
			typeMin: this.numericDomain.typeMin,
			typeMax: this.numericDomain.typeMax,
		});
		this.vscode.postMessage({ type: 'refresh-status' });
		return { canvas, imageData };
	}

	_postScientificFormatInfo(decoded: Pick<ScientificDecodedImage, 'width' | 'height' | 'channels'> & { metadata?: Record<string, any> }) {
		const metadata = decoded.metadata || this.metadata;
		this.vscode.postMessage({
			type: 'formatInfo',
			value: {
				width: decoded.width,
				height: decoded.height,
				compression: 'none',
				photometricInterpretation: decoded.channels >= 3 ? 2 : 1,
				planarConfig: 1,
				samplesPerPixel: decoded.channels,
				bitsPerSample: this.numericDomain.bitsPerSample,
				sampleFormat: this.numericDomain.sampleFormat,
				typeMin: this.numericDomain.typeMin,
				typeMax: this.numericDomain.typeMax,
				sourceNumericType: this.numericDomain.sourceNumericType,
				floatCarrier: true,
				formatLabel: this.config.formatLabel,
				formatType: this.config.formatTypeFor?.(this.numericDomain) ?? this.config.formatType,
				isInitialLoad: this._isInitialLoad,
				...metadata,
			},
		});
	}

	renderWithSettings(renderOptions: DeferredRenderOptions = {}): ImageData | null {
		if (!this._lastRaw) { return null; }
		const { width, height, data, channels } = this._lastRaw;
		return this._toImageDataFloat(data, width, height, channels, this._withNumericDomain(renderOptions));
	}

	/**
	 * The samples always arrive in a Float32Array, so nothing downstream can
	 * infer the type range from the carrier — `_toImageDataFloat` falls back to
	 * [0, 1], the float default. Every render this class performs must therefore
	 * state the decoded domain explicitly.
	 */
	_withNumericDomain(renderOptions: DeferredRenderOptions): DeferredRenderOptions {
		return {
			...renderOptions,
			typeMin: this.numericDomain.typeMin,
			typeMax: this.numericDomain.typeMax,
		};
	}

	/**
	 * The initial render is deferred until the extension has applied this
	 * format's default settings, and the base implementation passes the
	 * caller's options through untouched. That loses the numeric domain, which
	 * matters for the one default that consumes it: an integer JPEG XL opens in
	 * gamma mode, whose range IS the type range, so a uint16 image normalized
	 * against [0, 1] rendered white above a value of 1. The formats that open
	 * in auto-normalize took their range from the data statistics instead and
	 * hid the same omission.
	 */
	performDeferredRender(renderOptions: DeferredRenderOptions = {}): ImageData | null {
		return super.performDeferredRender(this._withNumericDomain(renderOptions));
	}
}
