// @ts-check
"use strict";

import decode, { init as initJXLDecode } from '@jsquash/jxl/decode';
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';

/** @typedef {import('./settings-manager.js').SettingsManager} SettingsManager */
/** @typedef {import('./settings-manager.js').ImageSettings} ImageSettings */
/** @typedef {{postMessage: (msg: any) => any}} VsCodeApi */

/**
 * JPEG XL (JXL) Processor for TIFF Visualizer.
 * Uses @jsquash/jxl to decode .jxl files via WASM.
 * Decoded output is always 4-channel RGBA (8-bit SDR).
 */
export class JxlProcessor {
    /**
     * @param {SettingsManager} settingsManager
     * @param {VsCodeApi} vscode
     */
    constructor(settingsManager, vscode) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        /** @type {{width:number, height:number, data:Uint8ClampedArray, channels:number, bitDepth:number, maxValue:number, hasAlpha:boolean, originalImageData:ImageData}|null} */
        this._lastRaw = null;
        this._pendingRenderData = null;
        this._isInitialLoad = true;
        /** @type {{min:number,max:number}|undefined} */
        this._cachedStats = undefined;
        this._isWasmLoaded = false;
    }

    async ensureWasmLoaded() {
        if (this._isWasmLoaded) return;

        const configuredWasm = this.settingsManager?.settings?.jxlWasmSrc;

        const wasmCandidates = [
            configuredWasm,
            // Relative to the bundle file (media/imagePreview.bundle.js → media/wasm/jxl_dec.wasm)
            new URL('./wasm/jxl_dec.wasm', import.meta.url).href,
            new URL('../wasm/jxl_dec.wasm', import.meta.url).href,
        ].filter(Boolean);

        let lastError = /** @type {unknown} */ (null);
        for (const wasmUrl of wasmCandidates) {
            try {
                const wasmResponse = await fetch(/** @type {string} */ (wasmUrl));
                if (!wasmResponse.ok) throw new Error(`HTTP ${wasmResponse.status}`);
                const wasmBuffer = await wasmResponse.arrayBuffer();
                const wasmModule = await WebAssembly.compile(wasmBuffer);
                await initJXLDecode(wasmModule);
                this._isWasmLoaded = true;
                return;
            } catch (error) {
                lastError = error;
            }
        }

        const details = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(`Unable to initialize JXL decoder WASM (${details})`);
    }

    /**
     * @param {string} src
     */
    async processJxl(src) {
        this._cachedStats = undefined;
        await this.ensureWasmLoaded();

        const response = await fetch(src);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();

        // @jsquash/jxl decode returns a standard ImageData (RGBA, 8-bit)
        const decoded = await decode(arrayBuffer);

        const width = decoded.width;
        const height = decoded.height;
        const rawData = decoded.data;

        // Determine if the image actually uses the alpha channel
        let hasAlpha = false;
        for (let i = 3; i < rawData.length; i += 4) {
            if (rawData[i] < 255) { hasAlpha = true; break; }
        }

        this._lastRaw = {
            width,
            height,
            data: rawData,
            channels: 4, // jxl decode always returns RGBA
            bitDepth: 8,
            maxValue: 255,
            hasAlpha,
            originalImageData: decoded
        };

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const logicalChannels = hasAlpha ? 4 : 3;

        if (this._isInitialLoad) {
            this._postFormatInfo(width, height, logicalChannels, 8);
            this._pendingRenderData = true;
            return { canvas, imageData: new ImageData(width, height) };
        }

        this._postFormatInfo(width, height, logicalChannels, 8);
        const processedImageData = this._renderToImageData();
        if (this.vscode) {
            this.vscode.postMessage({ type: 'refresh-status' });
        }
        return { canvas, imageData: processedImageData };
    }

    _renderToImageData() {
        if (!this._lastRaw) return new ImageData(1, 1);

        const { width, height, data, channels, originalImageData } = this._lastRaw;
        const settings = this.settingsManager.settings;
        const isGammaMode = settings.normalization?.gammaMode || false;
        const isIdentity = NormalizationHelper.isIdentityTransformation(settings);
        const rgbAs24BitMode = settings.rgbAs24BitGrayscale && channels >= 3;

        if (originalImageData && isGammaMode && isIdentity && !rgbAs24BitMode) {
            return originalImageData;
        }

        let stats = this._cachedStats;
        if (!stats && !isGammaMode) {
            stats = ImageStatsCalculator.calculateIntegerStats(data, width, height, channels);
            this._cachedStats = stats;
            if (this.vscode) {
                this.vscode.postMessage({ type: 'stats', value: stats });
            }
        }
        if (isGammaMode && !stats) {
            stats = { min: 0, max: 255 };
        }

        return ImageRenderer.render(
            data,
            width,
            height,
            channels,
            false,
            stats,
            settings,
            { rgbAs24BitGrayscale: rgbAs24BitMode, typeMax: 255 }
        );
    }

    /** @returns {ImageData|null} */
    renderJxlWithSettings() {
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
        const { width, height, data, hasAlpha } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';

        const dataIdx = (y * width + x) * 4;
        if (dataIdx < 0 || dataIdx + 3 >= data.length) return '';

        const r = data[dataIdx];
        const g = data[dataIdx + 1];
        const b = data[dataIdx + 2];
        const a = data[dataIdx + 3];
        const settings = this.settingsManager.settings;

        if (settings.rgbAs24BitGrayscale) {
            const combined24bit = (r << 16) | (g << 8) | b;
            const scaleFactor = settings.scale24BitFactor || 1000;
            const scaledValue = (combined24bit / scaleFactor).toFixed(3);
            if (hasAlpha) return `${scaledValue} α:${(a / 255).toFixed(2)}`;
            return scaledValue;
        }

        if (hasAlpha) {
            return `${r.toString().padStart(3, '0')} ${g.toString().padStart(3, '0')} ${b.toString().padStart(3, '0')} α:${(a / 255).toFixed(2)}`;
        }
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
                compression: 'JXL',
                predictor: 1,
                photometricInterpretation: channels >= 3 ? 2 : 1,
                planarConfig: 1,
                samplesPerPixel: channels,
                bitsPerSample: bitDepth,
                sampleFormat: 1,
                formatLabel: `JXL (${bitDepth}-bit)`,
                formatType: 'jxl',
                isInitialLoad: this._isInitialLoad
            }
        });
    }

    /** @returns {ImageData|null} */
    performDeferredRender() {
        if (!this._pendingRenderData || !this._lastRaw) return null;
        this._pendingRenderData = null;
        this._isInitialLoad = false;
        const imageData = this._renderToImageData();
        if (this.vscode) {
            this.vscode.postMessage({ type: 'refresh-status' });
        }
        return imageData;
    }
}
