"use strict";

import { PfmProcessor } from './pfm-processor.js';
import { DecodeWorkerClient } from './decode-worker-client.js';
import type { SettingsManager } from './settings-manager.js';
import type { DeferredRenderOptions } from './types.js';
import type { ScientificDecodedImage } from './types.js';

type VsCodeApi = { postMessage: (msg: any) => any };

export interface ScientificArrayProcessorConfig {
	workerFormat: 'fits' | 'dicom' | 'netcdf' | 'czi' | 'nd2' | 'lif' | 'jxr' | 'jp2' | 'jxl';
	/**
	 * Keep the source bytes in the decode worker between requests. Worth it for
	 * formats where one file is decoded repeatedly to show different planes, and
	 * only safe when the parser copies out of the buffer instead of aliasing it.
	 */
	cacheSourceInWorker?: boolean;
	formatLabel: string;
	formatType: 'fits' | 'dicom' | 'netcdf' | 'czi' | 'nd2' | 'lif' | 'jxr' | 'jp2' | 'jxl';
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

	async process(src: string, decodeOptions: Record<string, any> = {}) {
		const signal = this.loadSignal;
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
		this._postScientificFormatInfo(decoded);

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
		return this._toImageDataFloat(data, width, height, channels, {
			...renderOptions,
			typeMin: this.numericDomain.typeMin,
			typeMax: this.numericDomain.typeMax,
		});
	}
}
