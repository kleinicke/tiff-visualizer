"use strict";

import { PfmProcessor } from './pfm-processor.js';
import { DecodeWorkerClient } from './decode-worker-client.js';
import type { SettingsManager } from './settings-manager.js';
import type { DeferredRenderOptions } from './types.js';
import type { ScientificDecodedImage } from './scientific-format-parsers.js';

type VsCodeApi = { postMessage: (msg: any) => any };

export interface ScientificArrayProcessorConfig {
	workerFormat: 'fits' | 'dicom' | 'netcdf';
	formatLabel: string;
	formatType: 'fits' | 'dicom' | 'netcdf';
	parse: (buffer: ArrayBuffer) => ScientificDecodedImage;
}

/** Shared renderer/lifecycle adapter for self-describing scientific arrays. */
export class ScientificArrayProcessor extends PfmProcessor {
	config: ScientificArrayProcessorConfig;
	metadata: Record<string, any> = {};

	constructor(settingsManager: SettingsManager, vscode: VsCodeApi, config: ScientificArrayProcessorConfig) {
		super(settingsManager, vscode);
		this.config = config;
	}

	async process(src: string) {
		const signal = this.loadSignal;
		const buffer = await DecodeWorkerClient.fetchArrayBuffer(src, signal, this.config.workerFormat);
		if (signal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
		const decoded: ScientificDecodedImage = await DecodeWorkerClient.decodeWithFallback(
			this.decodeWorker,
			this.config.workerFormat,
			buffer,
			src,
			signal,
			this.config.parse,
		);
		this._cachedStats = undefined;
		this.metadata = decoded.metadata || {};
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

		const imageData = this._toImageDataFloat(decoded.data, decoded.width, decoded.height, decoded.channels);
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
				bitsPerSample: 32,
				sampleFormat: 3,
				formatLabel: this.config.formatLabel,
				formatType: this.config.formatType,
				isInitialLoad: this._isInitialLoad,
				...metadata,
			},
		});
	}

	renderWithSettings(renderOptions: DeferredRenderOptions = {}): ImageData | null {
		if (!this._lastRaw) { return null; }
		const { width, height, data, channels } = this._lastRaw;
		return this._toImageDataFloat(data, width, height, channels, renderOptions);
	}
}
