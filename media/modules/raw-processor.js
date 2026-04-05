// @ts-check
"use strict";

import LibRaw from 'libraw-wasm';
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';

/** @typedef {import('./settings-manager.js').SettingsManager} SettingsManager */
/** @typedef {import('./settings-manager.js').ImageSettings} ImageSettings */
/** @typedef {{postMessage: (msg: any) => any}} VsCodeApi */

export class RawProcessor {
    /**
     * @param {SettingsManager} settingsManager
     * @param {VsCodeApi} vscode
     */
    constructor(settingsManager, vscode) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        /** @type {{width:number, height:number, data:Uint8Array, channels:number, bitDepth:number, maxValue:number}|null} */
        this._lastRaw = null;
        this._pendingRenderData = null;
        this._isInitialLoad = true;
        /** @type {{min:number,max:number}|undefined} */
        this._cachedStats = undefined;
        /** @type {any} */
        this._libRaw = null;
        /** @type {string|null} */
        this._workerBootstrapUrl = null;
    }

    /**
     * @param {Promise<any>} promise
     * @param {number} ms
     * @param {string} label
     * @returns {Promise<any>}
     */
    async _withTimeout(promise, ms, label) {
        let timeoutId = null;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error(`${label} timed out after ${ms}ms`));
            }, ms);
        });

        try {
            return await Promise.race([promise, timeoutPromise]);
        } finally {
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
            }
        }
    }

    /**
     * @param {string} url
     * @param {number} ms
     * @param {string} label
     * @returns {Promise<Response>}
     */
    async _fetchWithTimeout(url, ms, label) {
        const response = await this._withTimeout(fetch(url), ms, label);
        return response;
    }

    /**
     * @param {any} value
     * @returns {boolean}
     */
    _isTypedArray(value) {
        return ArrayBuffer.isView(value) && !(value instanceof DataView);
    }

    /**
     * @param {any} value
     * @returns {number|null}
     */
    _toFinitePositiveInteger(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) {
            return null;
        }
        const intNum = Math.round(num);
        return intNum > 0 ? intNum : null;
    }

    /**
     * @param {any} rawOutput
     * @param {number} width
     * @param {number} height
     * @param {any} meta
     * @returns {{pixelData: Uint8Array, channels: number, payloadShape: string}}
     */
    _normalizeRawDecodeOutput(rawOutput, width, height, meta) {
        const pixelCount = width * height;
        const camera = [meta?.make, meta?.model].filter(Boolean).join(' ').trim() || 'unknown camera';

        let payload = rawOutput;
        let pixelData = null;
        let payloadShape = null;

        if (this._isTypedArray(rawOutput)) {
            pixelData = rawOutput;
            payloadShape = rawOutput.constructor?.name || typeof rawOutput;
        } else if (Array.isArray(rawOutput)) {
            pixelData = Uint8Array.from(rawOutput);
            payloadShape = 'Array';
        } else if (rawOutput && typeof rawOutput === 'object') {
            payload = rawOutput;
            payloadShape = rawOutput.constructor?.name || 'Object';
            const preferredDataKeys = ['data', 'pixels', 'rgba', 'rgb', 'imageData', 'buffer'];
            for (const key of preferredDataKeys) {
                const candidate = rawOutput[key];
                if (this._isTypedArray(candidate)) {
                    pixelData = candidate;
                    break;
                }
                if (Array.isArray(candidate)) {
                    pixelData = Uint8Array.from(candidate);
                    break;
                }
            }

            if (!pixelData) {
                for (const value of Object.values(rawOutput)) {
                    if (this._isTypedArray(value)) {
                        pixelData = value;
                        break;
                    }
                    if (Array.isArray(value)) {
                        pixelData = Uint8Array.from(value);
                        break;
                    }
                }
            }
        }

        if (!pixelData || pixelData.length === 0) {
            const keys = payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 12).join(', ') : '';
            throw new Error(`RAW decoder returned no usable pixel buffer (${camera}). payloadType=${payloadShape || typeof rawOutput}${keys ? `, keys=[${keys}]` : ''}`);
        }

        let channels = null;
        const channelKeys = ['channels', 'channelCount', 'colors', 'samplesPerPixel', 'samples_per_pixel', 'cpp'];
        if (payload && typeof payload === 'object') {
            for (const key of channelKeys) {
                const candidate = this._toFinitePositiveInteger(payload[key]);
                if (candidate) {
                    channels = candidate;
                    break;
                }
            }
        }

        if (!channels && pixelCount > 0 && Number.isFinite(pixelData.length) && pixelData.length % pixelCount === 0) {
            channels = this._toFinitePositiveInteger(pixelData.length / pixelCount);
        }

        if (!channels) {
            const metaChannels = this._toFinitePositiveInteger(meta?.colors) ||
                this._toFinitePositiveInteger(meta?.samplesPerPixel) ||
                this._toFinitePositiveInteger(meta?.raw_colors);
            if (metaChannels) {
                channels = metaChannels;
            }
        }

        if (!channels) {
            throw new Error(`Invalid RAW channel count derived from decoder output: length=${pixelData.length}, size=${width}x${height}`);
        }

        const expectedLength = pixelCount * channels;
        if (expectedLength !== pixelData.length) {
            // If decoder metadata channel field is stale, prefer mathematically exact layout.
            const computedChannels = pixelData.length % pixelCount === 0
                ? this._toFinitePositiveInteger(pixelData.length / pixelCount)
                : null;
            if (computedChannels) {
                channels = computedChannels;
            } else {
                throw new Error(`RAW pixel buffer length mismatch: length=${pixelData.length}, expected=${expectedLength}, size=${width}x${height}, channels=${channels}`);
            }
        }

        return {
            pixelData,
            channels,
            payloadShape: payloadShape || typeof rawOutput
        };
    }

    /** @returns {Promise<string>} */
    async _ensureWorkerBootstrapUrl() {
        if (this._workerBootstrapUrl) {
            return /** @type {string} */ (this._workerBootstrapUrl);
        }

        const configuredWorkerSrc = this.settingsManager?.settings?.rawWorkerSrc;
        const configuredWasmSrc = this.settingsManager?.settings?.rawWasmSrc;

        // Blob URL approach: create a same-origin (vscode-webview://) blob from the
        // fetched worker source. This is required because VS Code webviews block
        // cross-origin Worker construction (the resource CDN origin differs from the
        // webview origin). worker-src blob: in the CSP allows blob workers.
        const workerCandidates = [
            configuredWorkerSrc,
            new URL('./libraw-worker.js', import.meta.url).href,
            new URL('../libraw-worker.js', import.meta.url).href,
        ].filter(Boolean);

        // libraw.wasm is co-located with libraw-worker.js in media/
        const wasmCandidates = [
            configuredWasmSrc,
            new URL('./libraw.wasm', import.meta.url).href,
            new URL('../libraw.wasm', import.meta.url).href,
        ].filter(Boolean);

        let workerSource = null;
        for (const workerUrl of workerCandidates) {
            try {
                const response = await this._fetchWithTimeout(workerUrl, 8000, `RAW worker fetch: ${workerUrl}`);
                if (!response.ok) {
                    console.warn(`[RAW] Worker candidate rejected (${response.status}): ${workerUrl}`);
                    continue;
                }
                console.log(`[RAW] Worker candidate selected: ${workerUrl}`);
                workerSource = await response.text();
                break;
            } catch (error) {
                console.warn(`[RAW] Worker candidate failed: ${workerUrl}`, error);
            }
        }

        if (!workerSource) {
            throw new Error('Unable to fetch RAW worker script');
        }

        let wasmUrl = null;
        for (const candidate of wasmCandidates) {
            try {
                const response = await this._fetchWithTimeout(candidate, 8000, `RAW wasm fetch: ${candidate}`);
                if (!response.ok) {
                    console.warn(`[RAW] WASM candidate rejected (${response.status}): ${candidate}`);
                    continue;
                }
                wasmUrl = candidate;
                console.log(`[RAW] WASM candidate selected: ${candidate}`);
                if (response.body && typeof response.body.cancel === 'function') {
                    response.body.cancel();
                }
                break;
            } catch (error) {
                console.warn(`[RAW] WASM candidate failed: ${candidate}`, error);
            }
        }

        if (!wasmUrl) {
            throw new Error('Unable to resolve libraw.wasm URL');
        }

        // Inject the absolute WASM URL into the worker via locateFile patch + preamble,
        // since blob workers have no meaningful base URL for relative resolution.
        const locateFilePatch = 'on=(await an()).LibRaw';
        const patchedInit = 'on=(await an({locateFile:(p)=>p==="libraw.wasm"?self.__librawWasmUrl:p})).LibRaw';
        const patchedWorkerSource = workerSource.includes(locateFilePatch)
            ? workerSource.replace(locateFilePatch, patchedInit)
            : workerSource;

        const preamble = `self.__librawWasmUrl = ${JSON.stringify(wasmUrl)};\n`;
        const blob = new Blob([preamble, patchedWorkerSource], { type: 'text/javascript' });
        this._workerBootstrapUrl = URL.createObjectURL(blob);
        return /** @type {string} */ (this._workerBootstrapUrl);
    }

    /** @returns {Promise<void>} */
    async ensureWasmLoaded() {
        if (!this._libRaw) {
            const workerBootstrapUrl = await this._ensureWorkerBootstrapUrl();
            const NativeWorker = globalThis.Worker;
            const redirectedWorker = class extends NativeWorker {
                /** @param {string|URL} specifier @param {WorkerOptions} [options] */
                constructor(specifier, options) {
                    const rawSpecifier = typeof specifier === 'string' ? specifier : String(specifier);
                    if (rawSpecifier.includes('worker.js')) {
                        super(workerBootstrapUrl, { ...options, type: 'module' });
                        return;
                    }
                    super(specifier, options);
                }
            };

            globalThis.Worker = redirectedWorker;
            try {
                this._libRaw = new LibRaw();
            } finally {
                globalThis.Worker = NativeWorker;
            }

            // Workaround for libraw-wasm v1.1.2 bug:
            // runFn() stores the reject callback as key "error" but onmessage
            // destructures it as key "throw", causing "a is not a function" whenever
            // the worker returns an error response. Fix: wrap runFn to add the missing
            // "throw" alias immediately after waitForWorker is set (synchronously,
            // before any worker reply can arrive).
            const libRaw = this._libRaw;
            const origRunFn = libRaw.runFn.bind(libRaw);
            libRaw.runFn = function(/** @type {string} */ fn, /** @type {any[]} */ ...args) {
                const promise = origRunFn(fn, ...args);
                // waitForWorker was just set synchronously by origRunFn
                if (libRaw.waitForWorker && libRaw.waitForWorker.error && !libRaw.waitForWorker['throw']) {
                    libRaw.waitForWorker['throw'] = libRaw.waitForWorker.error;
                }
                return promise;
            };
        }
    }

    /** @param {string} src */
    async processRaw(src) {
        try {
            this._cachedStats = undefined;
            this._lastRaw = null;
            this._pendingRenderData = null;
            await this.ensureWasmLoaded();

            const response = await fetch(src);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const arrayBuffer = await response.arrayBuffer();

            // libraw-wasm open API
            // using default settings
            const settings = {};
            await this._withTimeout(
                this._libRaw.open(new Uint8Array(arrayBuffer), settings),
                20000,
                'RAW decode (open)'
            );

            const meta = await this._withTimeout(
                this._libRaw.metadata(),
                20000,
                'RAW decode (metadata)'
            );
            const width = meta.width;
            const height = meta.height;
            if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
                throw new Error(`Invalid RAW dimensions from decoder: ${width}x${height}`);
            }
            // fetch RGB or RGBA array from libraw
            const rawOutput = await this._withTimeout(
                this._libRaw.imageData(),
                20000,
                'RAW decode (imageData)'
            );
            const { pixelData, channels, payloadShape } = this._normalizeRawDecodeOutput(rawOutput, width, height, meta);

            console.log('[RAW] Decode result:', { width, height, channels, dataLength: pixelData.length, payloadShape });

            this._lastRaw = {
                width: width,
                height: height,
                data: pixelData,
                channels: channels,
                bitDepth: 8, // mostly standard 8-bit SDR output from imageData()
                maxValue: 255
            };

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;

            if (this._isInitialLoad) {
                this._postFormatInfo(width, height, channels, 8);
                this._pendingRenderData = true;
                const placeholderImageData = new ImageData(width, height);
                return { canvas, imageData: placeholderImageData };
            }

            this._postFormatInfo(width, height, channels, 8);
            const processedImageData = this._renderToImageData();
            
            if (this.vscode) {
                this.vscode.postMessage({ type: 'refresh-status' });
            }
            return { canvas, imageData: processedImageData };
        } catch (error) {
            console.error('RAW processing failed:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to process RAW image: ${errorMessage}`);
        }
    }

    /** @returns {ImageData} */
    _renderToImageData() {
        if (!this._lastRaw) return new ImageData(1, 1);

        const { width, height, data, channels } = this._lastRaw;
        const settings = this.settingsManager.settings;
        const isFloat = false;

        const isIdentity = NormalizationHelper.isIdentityTransformation(settings);
        const isGammaMode = settings.normalization?.gammaMode || false;
        const rgbAs24BitMode = settings.rgbAs24BitGrayscale && channels >= 3;

        // Fast path for identity settings
        if (isGammaMode && isIdentity && !rgbAs24BitMode && channels === 4) {
            // Copy into a fresh ArrayBuffer to satisfy ImageData's type requirements
            const clampedData = new Uint8ClampedArray(width * height * 4);
            clampedData.set(data);
            return new ImageData(clampedData, width, height);
        }

        let stats = this._cachedStats;
        if (!stats && !isGammaMode) {
            stats = ImageStatsCalculator.calculateIntegerStats(data, width, height, channels);
            this._cachedStats = stats;
        }

        if (isGammaMode && !stats) {
            stats = { min: 0, max: 255 };
        }

        const options = {
            rgbAs24BitGrayscale: rgbAs24BitMode,
            typeMax: 255
        };

        return ImageRenderer.render(
            data,
            width,
            height,
            channels,
            isFloat,
            stats,
            settings,
            options
        );
    }

    /** @returns {ImageData|null} */
    renderRawWithSettings() {
        if (!this._lastRaw) return null;
        return this._renderToImageData();
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {number} naturalWidth
     * @param {number} naturalHeight
     * @returns {string}
     */
    getColorAtPixel(x, y, naturalWidth, naturalHeight) {
        if (!this._lastRaw) return '';
        const { width, height, data, channels } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';

        const pixelIdx = y * width + x;
        const dataIdx = pixelIdx * channels;
        if (dataIdx < 0 || dataIdx + channels - 1 >= data.length) return '';

        const settings = this.settingsManager.settings;

        if (channels >= 3 && settings.rgbAs24BitGrayscale) {
            const r = data[dataIdx];
            const g = data[dataIdx + 1];
            const b = data[dataIdx + 2];
            const combined24bit = (r << 16) | (g << 8) | b;
            const scaleFactor = settings.scale24BitFactor || 1000;
            return (combined24bit / scaleFactor).toFixed(3);
        }

        if (channels === 1) {
            return data[dataIdx].toString().padStart(3, '0');
        }

        const r = data[dataIdx];
        const g = data[dataIdx + 1];
        const b = data[dataIdx + 2];
        // Camera RAW output has no meaningful alpha channel
        return `${r.toString().padStart(3, '0')} ${g.toString().padStart(3, '0')} ${b.toString().padStart(3, '0')}`;
    }

    /**
     * @param {number} width
     * @param {number} height
     * @param {number} channels
     * @param {number} bitDepth
     */
    _postFormatInfo(width, height, channels, bitDepth) {
        if (!this.vscode) return;

        this.vscode.postMessage({
            type: 'formatInfo',
            value: {
                width,
                height,
                compression: 'Camera RAW',
                predictor: 1,
                photometricInterpretation: channels >= 3 ? 2 : 1,
                planarConfig: 1,
                samplesPerPixel: channels,
                bitsPerSample: bitDepth,
                sampleFormat: 1,
                formatLabel: `RAW (${bitDepth}-bit)`,
                formatType: 'raw',
                isInitialLoad: this._isInitialLoad
            }
        });
    }

    /** @returns {ImageData|null} */
    performDeferredRender() {
        if (!this._pendingRenderData || !this._lastRaw) {
            return null;
        }

        this._pendingRenderData = null;
        this._isInitialLoad = false;

        const imageData = this._renderToImageData();
        this.vscode.postMessage({ type: 'refresh-status' });

        return imageData;
    }
}
