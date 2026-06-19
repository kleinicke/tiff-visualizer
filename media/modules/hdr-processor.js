// @ts-check
"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';
import { DecodeWorkerClient } from './decode-worker-client.js';
import { WebGL2FloatRenderer } from './webgl2-float-renderer.js';
import parseHdr from 'parse-hdr';

/** @typedef {import('./settings-manager.js').SettingsManager} SettingsManager */
/** @typedef {import('./settings-manager.js').ImageSettings} ImageSettings */
/** @typedef {{postMessage: (msg: any) => any}} VsCodeApi */

/**
 * HDR (Radiance RGBE) Processor for TIFF Visualizer.
 * Uses parse-hdr to decode .hdr files into RGBA Float32Arrays.
 *
 * parse-hdr always returns 4-channel (RGBA) data with alpha fixed at 1.0.
 * We pass channels=4 to ImageRenderer (correct stride) but never show α: in
 * the color picker since alpha carries no image information.
 */
export class HdrProcessor {
    /**
     * @param {SettingsManager} settingsManager
     * @param {VsCodeApi} vscode
     */
    constructor(settingsManager, vscode) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        /** @type {{width:number, height:number, data:Float32Array, channels:number}|null} */
        this._lastRaw = null;
        this._pendingRenderData = null;
        this._isInitialLoad = true;
        /** @type {{min:number,max:number}|undefined} */
        this._cachedStats = undefined;
        this._lastRenderHistogram = null;
        this._lastRenderUsedWebGL = false;
        this._webglRenderer = new WebGL2FloatRenderer();
        /** @type {AbortSignal|undefined} */
        this.loadSignal = undefined; // Set before each load; aborts the fetch when a newer image switch supersedes it
        /** @type {DecodeWorkerClient|null} */
        this.decodeWorker = null; // Off-thread decoder, set by imagePreview.js; null falls back to local decoding
    }

    /** @param {string} src */
    async processHdr(src) {
        const loadSignal = this.loadSignal;
        const buffer = await DecodeWorkerClient.fetchArrayBuffer(src, loadSignal, 'hdr');
        if (loadSignal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }

        // parse-hdr returns { shape:[width,height], exposure, gamma, data:Float32Array }
        // data is RGBA stride-4, alpha is always 1.0
        // Parsed in the decode worker when available, locally otherwise.
        const parsed = await DecodeWorkerClient.decodeWithFallback(
            this.decodeWorker, 'hdr', buffer, src, loadSignal, (b) => parseHdr(b));
        const width = parsed.shape[0];
        const height = parsed.shape[1];

        /** @type {Float32Array} */
        const data = parsed.data;

        // parse-hdr alpha is always 1.0 — no image information.
        // Report 3 channels to format info; pass stride=4 to ImageRenderer.
        const channels = 3;
        const renderChannels = 4;

        this._cachedStats = undefined;
        this._lastRaw = { width, height, data, channels: renderChannels };

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        if (this._isInitialLoad) {
            this._postFormatInfo(width, height, channels, 'HDR');
            this._pendingRenderData = { data, width, height, renderChannels };
            return { canvas, imageData: new ImageData(width, height) };
        }

        this._postFormatInfo(width, height, channels, 'HDR');
        const imageData = this._toImageDataFloat(data, width, height, renderChannels);
        if (this.vscode) {
            this.vscode.postMessage({ type: 'refresh-status' });
        }
        return { canvas, imageData };
    }

    /**
     * @param {Float32Array} data
     * @param {number} width
     * @param {number} height
     * @param {number} renderChannels - actual data stride (4 from parse-hdr)
     * @returns {ImageData}
     */
    _toImageDataFloat(data, width, height, renderChannels, renderOptions = {}) {
        this._lastRenderHistogram = null;
        this._lastRenderUsedWebGL = false;
        const settings = this.settingsManager.settings;
        const isGammaMode = settings.normalization?.gammaMode || false;

        let stats = this._cachedStats;
        if (!stats && NormalizationHelper.needsStats(settings)) {
            // Calculate stats over RGB channels only (ignore alpha at index 3)
            stats = ImageStatsCalculator.calculateFloatStats(data, width, height, renderChannels);
            this._cachedStats = stats;
            if (this.vscode) {
                this.vscode.postMessage({ type: 'stats', value: stats });
            }
        }
        const nanColor = this._getNanColor(settings);
        // parse-hdr currently exposes RGBA float data, with alpha fixed at 1.0.
        // Uploading that 4-channel float texture is very expensive for large HDRs,
        // so keep the CPU path until we can decode or pack HDR as RGB directly.
        const canUseWebGL = renderChannels <= 3;
        if (canUseWebGL && renderOptions.targetCanvas && this._webglRenderer.canRender({
            data,
            width,
            height,
            channels: renderChannels,
            isFloat: true,
            settings
        })) {
            const rendered = this._webglRenderer.render(renderOptions.targetCanvas, {
                data,
                width,
                height,
                channels: renderChannels,
                isFloat: true,
                min: (stats && Number.isFinite(stats.min)) ? stats.min : 0,
                max: (stats && Number.isFinite(stats.max)) ? stats.max : 1,
                typeMax: 1.0,
                settings,
                nanColor
            });
            if (rendered) {
                this._lastRenderUsedWebGL = true;
                return renderOptions.placeholderImageData || new ImageData(width, height);
            }
        }

        const options = {
            nanColor,
            collectHistogram: renderOptions.collectHistogram === true
        };
        
        const imageData = ImageRenderer.render(
            data,
            width,
            height,
            renderChannels,
            true, // isFloat
            stats || { min: 0, max: 1 },
            settings,
            options
        );
        this._lastRenderHistogram = options.renderHistogramResult || null;
        return imageData;
    }

    /**
     * @param {any} settings
     * @returns {{r:number,g:number,b:number}}
     */
    _getNanColor(settings) {
        return settings.nanColor === 'fuchsia' ? { r: 255, g: 0, b: 255 } : { r: 0, g: 0, b: 0 };
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
        const { width, height, data } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';

        // Data from parse-hdr has stride 4 (RGBA), ignore alpha
        const baseIdx = (y * width + x) * 4;
        if (baseIdx < 0 || baseIdx + 2 >= data.length) return '';

        const r = data[baseIdx];
        const g = data[baseIdx + 1];
        const b = data[baseIdx + 2];

        const fmt = (/** @type {number} */ v) => {
            if (Number.isNaN(v)) return 'NaN';
            if (v === Infinity) return 'Inf';
            if (v === -Infinity) return '-Inf';
            return parseFloat(v.toFixed(6)).toString();
        };

        return `${fmt(r)} ${fmt(g)} ${fmt(b)}`;
    }

    /**
     * @param {number} width
     * @param {number} height
     * @param {number} channels
     * @param {string} formatLabel
     */
    _postFormatInfo(width, height, channels, formatLabel) {
        if (!this.vscode) return;
        this.vscode.postMessage({
            type: 'formatInfo',
            value: {
                width,
                height,
                compression: 'RLE',
                predictor: 1,
                photometricInterpretation: 2,
                planarConfig: 1,
                samplesPerPixel: channels,
                bitsPerSample: 32,
                sampleFormat: 3,
                formatLabel,
                formatType: 'hdr',
                isInitialLoad: this._isInitialLoad
            }
        });
    }

    /** @returns {ImageData|null} */
    performDeferredRender(renderOptions = {}) {
        if (!this._pendingRenderData) return null;
        const { data, width, height, renderChannels } = this._pendingRenderData;
        this._pendingRenderData = null;
        this._isInitialLoad = false;
        const imageData = this._toImageDataFloat(data, width, height, renderChannels, renderOptions);
        if (this.vscode) {
            this.vscode.postMessage({ type: 'refresh-status' });
        }
        return imageData;
    }

    /** @returns {ImageData|null} */
    renderHdrWithSettings(renderOptions = {}) {
        if (!this._lastRaw) return null;
        const { width, height, data } = this._lastRaw;
        return this._toImageDataFloat(data, width, height, 4, renderOptions);
    }
}
