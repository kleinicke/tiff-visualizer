// @ts-check
"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';
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
    }

    /** @param {string} src */
    async processHdr(src) {
        const response = await fetch(src);
        const buffer = await response.arrayBuffer();

        // parse-hdr returns { shape:[width,height], exposure, gamma, data:Float32Array }
        // data is RGBA stride-4, alpha is always 1.0
        const parsed = parseHdr(buffer);
        const width = parsed.shape[0];
        const height = parsed.shape[1];

        /** @type {Float32Array} */
        const data = parsed.data;

        // parse-hdr alpha is always 1.0 — no image information.
        // Report 3 channels to format info; pass stride=4 to ImageRenderer.
        const channels = 3;
        const renderChannels = 4;

        this._cachedStats = undefined;
        this._lastRaw = { width, height, data, channels };

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
    _toImageDataFloat(data, width, height, renderChannels) {
        const settings = this.settingsManager.settings;
        const isGammaMode = settings.normalization?.gammaMode || false;

        let stats = this._cachedStats;
        if (!stats && !isGammaMode) {
            // Calculate stats over RGB channels only (ignore alpha at index 3)
            stats = ImageStatsCalculator.calculateFloatStats(data, width, height, renderChannels);
            this._cachedStats = stats;
            if (this.vscode) {
                this.vscode.postMessage({ type: 'stats', value: stats });
            }
        }

        return ImageRenderer.render(
            data,
            width,
            height,
            renderChannels,
            true, // isFloat
            stats || { min: 0, max: 1 },
            settings,
            { nanColor: this._getNanColor(settings) }
        );
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
    performDeferredRender() {
        if (!this._pendingRenderData) return null;
        const { data, width, height, renderChannels } = this._pendingRenderData;
        this._pendingRenderData = null;
        this._isInitialLoad = false;
        const imageData = this._toImageDataFloat(data, width, height, renderChannels);
        if (this.vscode) {
            this.vscode.postMessage({ type: 'refresh-status' });
        }
        return imageData;
    }

    /** @returns {ImageData|null} */
    renderHdrWithSettings() {
        if (!this._lastRaw) return null;
        const { width, height, data } = this._lastRaw;
        return this._toImageDataFloat(data, width, height, 4);
    }
}
