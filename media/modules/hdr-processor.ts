"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';
import { DecodeWorkerClient } from './decode-worker-client.js';
import { WebGL2FloatRenderer } from './webgl2-float-renderer.js';
import { PerfTrace } from './perf-trace.js';
import parseHdr from 'parse-hdr';
import { parseAllTagsJson } from './tiff-tag-utils.js';
import type { SettingsManager, ImageSettings } from './settings-manager.js';
import type { TagEntry } from './tiff-tag-utils.js';
import type { DeferredRenderOptions, RenderOptions, Stats } from './types.js';

type VsCodeApi = { postMessage: (msg: any) => any };

/**
 * HDR (Radiance RGBE) Processor for TIFF Visualizer.
 * Uses parse-hdr to decode .hdr files into RGBA Float32Arrays.
 *
 * parse-hdr always returns 4-channel (RGBA) data with alpha fixed at 1.0.
 * We pass channels=4 to ImageRenderer (correct stride) but never show α: in
 * the color picker since alpha carries no image information.
 */
export class HdrProcessor {
    settingsManager: SettingsManager;
    vscode: VsCodeApi;
    _lastRaw: { width: number; height: number; data: Float32Array; channels: number } | null;
    /** HDR header lines, for the Metadata panel (Rust decode path only) */
    _lastAllTags: TagEntry[];
    _pendingRenderData: { data: Float32Array; width: number; height: number; renderChannels: number } | null;
    _isInitialLoad: boolean;
    _cachedStats: Stats | undefined;
    _lastRenderHistogram: any;
    _lastRenderUsedWebGL: boolean;
    _cachedWebglRgb: { source: Float32Array; data: Float32Array } | null;
    _webglRenderer: WebGL2FloatRenderer;
    loadSignal: AbortSignal | undefined;
    decodeWorker: DecodeWorkerClient | null;

    constructor(settingsManager: SettingsManager, vscode: VsCodeApi) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        this._lastRaw = null;
        this._lastAllTags = [];
        this._pendingRenderData = null;
        this._isInitialLoad = true;
        this._cachedStats = undefined;
        this._lastRenderHistogram = null;
        this._lastRenderUsedWebGL = false;
        this._cachedWebglRgb = null;
        this._webglRenderer = new WebGL2FloatRenderer();
        this.loadSignal = undefined; // Set before each load; aborts the fetch when a newer image switch supersedes it
        this.decodeWorker = null; // Off-thread decoder, set by imagePreview.js; null falls back to local decoding
    }

    async processHdr(src: string) {
        const loadSignal = this.loadSignal;
        const buffer = await DecodeWorkerClient.fetchArrayBuffer(src, loadSignal, 'hdr');
        if (loadSignal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }

        // parse-hdr returns { shape:[width,height], exposure, gamma, data:Float32Array }
        // data is RGBA stride-4, alpha is always 1.0
        // Parsed in the decode worker when available, locally otherwise.
        const parsed = await DecodeWorkerClient.decodeWithFallback(
            this.decodeWorker, 'hdr', buffer, src, loadSignal, (b: ArrayBuffer) => parseHdr(b));
        const width = parsed.shape[0];
        const height = parsed.shape[1];
        this._lastAllTags = parseAllTagsJson(parsed.allTagsJson);

        const data: Float32Array = parsed.data;

        // parse-hdr alpha is always 1.0 — no image information.
        // Report 3 channels to format info; pass stride=4 to ImageRenderer.
        const channels = 3;
        const renderChannels = 4;

        this._cachedStats = undefined;
        this._cachedWebglRgb = null;
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
     * @param renderChannels actual data stride (4 from parse-hdr)
     */
    _toImageDataFloat(data: Float32Array, width: number, height: number, renderChannels: number, renderOptions: DeferredRenderOptions = {}): ImageData {
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
        // HDR arrives as RGBA floats, while the WebGL renderer needs RGB.
        // On large images the extra pack + RGB32F upload has measured slower
        // than the CPU path, so keep HDR on CPU until a no-copy GPU path exists.
        const webglData: Float32Array | null = null;
        if (webglData && this._webglRenderer.canRender({
            data: webglData,
            width,
            height,
            channels: 3,
            isFloat: true,
            settings
        })) {
            const rendered = this._webglRenderer.render(renderOptions.targetCanvas, {
                data: webglData,
                width,
                height,
                channels: 3,
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

        const options: RenderOptions = {
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
     * parse-hdr returns RGBA with alpha fixed at 1.0. The renderer only needs RGB,
     * and uploading RGB avoids a large, useless alpha channel texture.
     */
    _getWebglRgbData(data: Float32Array, width: number, height: number, renderChannels: number): Float32Array | null {
        if (renderChannels === 3) return data;
        if (renderChannels !== 4) return null;
        if (this._cachedWebglRgb?.source === data) {
            return this._cachedWebglRgb.data;
        }
        const start = performance.now();
        const pixels = width * height;
        const rgb = new Float32Array(pixels * 3);
        for (let src = 0, dst = 0; dst < rgb.length; src += 4, dst += 3) {
            rgb[dst] = data[src];
            rgb[dst + 1] = data[src + 1];
            rgb[dst + 2] = data[src + 2];
        }
        this._cachedWebglRgb = { source: data, data: rgb };
        PerfTrace.detail('hdr-pack-rgb', performance.now() - start);
        return rgb;
    }

    _getNanColor(settings: ImageSettings): { r: number; g: number; b: number } {
        return settings.nanColor === 'fuchsia' ? { r: 255, g: 0, b: 255 } : { r: 0, g: 0, b: 0 };
    }

    getColorAtPixel(x: number, y: number, naturalWidth: number, naturalHeight: number): string {
        if (!this._lastRaw) return '';
        const { width, height, data } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';

        // Data from parse-hdr has stride 4 (RGBA), ignore alpha
        const baseIdx = (y * width + x) * 4;
        if (baseIdx < 0 || baseIdx + 2 >= data.length) return '';

        const r = data[baseIdx];
        const g = data[baseIdx + 1];
        const b = data[baseIdx + 2];

        const fmt = (v: number) => {
            if (Number.isNaN(v)) return 'NaN';
            if (v === Infinity) return 'Inf';
            if (v === -Infinity) return '-Inf';
            return parseFloat(v.toFixed(6)).toString();
        };

        return `${fmt(r)} ${fmt(g)} ${fmt(b)}`;
    }

    _postFormatInfo(width: number, height: number, channels: number, formatLabel: string) {
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

    performDeferredRender(renderOptions: DeferredRenderOptions = {}): ImageData | null {
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

    renderHdrWithSettings(renderOptions: DeferredRenderOptions = {}): ImageData | null {
        if (!this._lastRaw) return null;
        const { width, height, data } = this._lastRaw;
        return this._toImageDataFloat(data, width, height, 4, renderOptions);
    }
}
