import { imageRaster, type ActiveImage, type DecodedSnapshot } from './active-image.js';
"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';
import { resolveNanColor } from './nan-color.js';
import { DecodeWorkerClient } from './decode-worker-client.js';
import { WebGL2FloatRenderer } from './webgl2-float-renderer.js';
import { decodeHdrParallel } from './strip-parallel-decode.js';
import { getWasmModule, getWasmModuleSync } from './tiff-wasm-wrapper.js';
import { PerfTrace } from './perf-trace.js';
import parseHdr from 'parse-hdr';
import { parseAllTagsJson } from './tiff-tag-utils.js';
import type { SettingsManager, ImageSettings } from './settings-manager.js';
import type { TagEntry } from './tiff-tag-utils.js';
import type { DeferredRenderOptions, RenderOptions, Stats } from './types.js';

type VsCodeApi = { postMessage: (msg: any) => any };

/**
 * HDR (Radiance RGBE) Processor for TIFF Visualizer.
 * Rust returns tightly packed RGB. The parse-hdr fallback returns RGBA with
 * alpha fixed at 1.0, so its stride is retained only on that fallback path.
 */
export class HdrProcessor {
  captureDecoded(): DecodedSnapshot | null {
      const raw = this._lastRaw;
      if (!raw?.data)
          return null;
      const { width, height } = raw;
      return { width, height, restore: () => {
              this._lastRaw = raw;
              this._cachedStats = undefined;
              this._isInitialLoad = true;
              this._pendingRenderData = { data: raw.data, width: raw.width, height: raw.height, renderChannels: raw.channels };
          } };
  }

  resetForNewFile(): void {
    this._isInitialLoad = true;
    this._pendingRenderData = null;
    this._lastRaw = null;
  }

  get activeImage(): ActiveImage {
      return { stats: this._cachedStats, histogram: this._lastRenderHistogram, raster: imageRaster(this._lastRaw, { isFloat: true, typeMax: 1 }),
          readPixel: (x, y, width, height) => this.getColorAtPixel(x, y, width, height), pixelDisplay: 'float' };
  }

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
        this._webglRenderer = new WebGL2FloatRenderer();
        this.loadSignal = undefined; // Set before each load; aborts the fetch when a newer image switch supersedes it
        this.decodeWorker = null; // Off-thread decoder, set by imagePreview.js; null falls back to local decoding
    }

    async load(src: string) {
        const loadSignal = this.loadSignal;
        // parse-hdr returns { shape:[width,height], exposure, gamma, data:Float32Array }
        // data is RGBA stride-4, alpha is always 1.0
        // Parsed in the decode worker when available, locally otherwise.
        const speculative = await DecodeWorkerClient.takeSpeculativeDecode(src, loadSignal, 'hdr');
        let parsed: any;
        if (speculative?.ok && speculative.result?.deferToParallelHdr && speculative.sourceBuffer instanceof ArrayBuffer) {
            // Large files: scanline ranges across the strip pool. The source
            // stays intact (the pool copies each range), so a failed parallel
            // decode can still decode it whole.
            const source: ArrayBuffer = speculative.sourceBuffer;
            const mainWasm = getWasmModuleSync() || await getWasmModule();
            const parallelStart = performance.now();
            const parallel = await decodeHdrParallel(source, mainWasm);
            if (loadSignal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
            if (parallel) {
                PerfTrace.mark('decode-worker(hdr)');
                for (const timing of parallel.timings) { PerfTrace.detail(timing.name, timing.durationMs); }
                parsed = {
                    shape: [parallel.width, parallel.height], channels: 3,
                    exposure: parallel.exposure, gamma: parallel.gamma,
                    data: parallel.data, allTagsJson: parallel.allTagsJson,
                    decodedWith: `rust-hdr-wasm (${parallel.workers} scanline workers)`,
                    durationMs: performance.now() - parallelStart,
                };
            } else {
                parsed = await DecodeWorkerClient.decodeWithFallback(
                    this.decodeWorker, 'hdr', source, src, loadSignal, (b: ArrayBuffer) => parseHdr(b));
            }
        } else if (speculative?.ok) {
            parsed = speculative.result;
        } else {
            const buffer = speculative?.buffer instanceof ArrayBuffer
                ? speculative.buffer
                : await DecodeWorkerClient.fetchArrayBuffer(src, loadSignal, 'hdr');
            if (loadSignal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
            parsed = await DecodeWorkerClient.decodeWithFallback(
                this.decodeWorker, 'hdr', buffer, src, loadSignal, (b: ArrayBuffer) => parseHdr(b));
        }
        const width = parsed.shape[0];
        const height = parsed.shape[1];
        this._lastAllTags = parseAllTagsJson(parsed.allTagsJson);

        const data: Float32Array = parsed.data;

        // Rust is RGB; parse-hdr fallback is RGBA with a constant alpha.
        const channels = 3;
        const renderChannels = parsed.channels === 3 ? 3 : 4;

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
        // Three-channel HDR renders on the GPU: the float RGB texture is uploaded
        // packed as one channel three texels wide (see WebGL2FloatRenderer), which
        // removed the driver's RGB->RGBA expansion that once made this upload
        // slower than the whole CPU render. Other strides stay on the CPU.
        const webglData: Float32Array | null = renderChannels === 3 ? data : null;
        if (webglData && renderOptions.targetCanvas && this._webglRenderer.canRender({
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

    _getNanColor(settings: ImageSettings): { r: number; g: number; b: number } {
        return resolveNanColor(settings);
    }

    getColorAtPixel(x: number, y: number, naturalWidth: number, naturalHeight: number): string {
        if (!this._lastRaw) return '';
        const { width, height, data, channels } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';

        const baseIdx = (y * width + x) * channels;
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

    renderWithSettings(renderOptions: DeferredRenderOptions = {}): ImageData | null {
        if (!this._lastRaw) return null;
        const { width, height, data, channels } = this._lastRaw;
        return this._toImageDataFloat(data, width, height, channels, renderOptions);
    }
}
