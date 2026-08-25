"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';
import { DecodeWorkerClient, type DecodeWorkerLike } from './decode-worker-client.js';
import { decodePfmLocal } from './main-thread-decode.js';
import { decodeNativePfmFast } from './fast-raw-decoders.js';
import { WebGL2FloatRenderer } from './webgl2-float-renderer.js';
import type { SettingsManager, ImageSettings } from './settings-manager.js';
import type { DeferredRenderOptions } from './types.js';

type VsCodeApi = { postMessage: (msg: any) => any };

interface RawImageData {
    width: number;
    height: number;
    data: Float32Array;
    channels: number;
}

interface PendingRenderData {
    displayData: Float32Array;
    width: number;
    height: number;
    channels: number;
}

/**
 * PFM Processor for TIFF Visualizer
 * Supports grayscale (Pf) and RGB (PF) portable float map files
 */
export class PfmProcessor {
    settingsManager: SettingsManager;
    vscode: VsCodeApi;
    _lastRaw: RawImageData | null; // { width, height, data: Float32Array }
    _pendingRenderData: PendingRenderData | null; // Store data waiting for format-specific settings
    _isInitialLoad: boolean; // Track if this is the first render
    _cachedStats: { min: number, max: number } | undefined; // Cache for min/max stats (only used in stats mode)
    /** Stats computed by the Rust decoder for the current `_lastRaw` (see
     * `DecodedArray::finalize_stats` in crates/image-decoders/src/lib.rs). Consumed
     * by `_toImageDataFloat` instead of rescanning with `ImageStatsCalculator`. */
    _decodedStats: { min: number, max: number } | undefined;
    _lastRenderHistogram: any;
    _lastRenderUsedWebGL: boolean;
    _webglRenderer: WebGL2FloatRenderer;
    /** Set before each load; aborts the fetch when a newer image switch supersedes it */
    loadSignal: AbortSignal | undefined;
    /** Off-thread decoder, set by imagePreview.js; null falls back to local decoding */
    decodeWorker: DecodeWorkerLike | null;

    constructor(settingsManager: SettingsManager, vscode: VsCodeApi) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        this._lastRaw = null;
        this._pendingRenderData = null;
        this._isInitialLoad = true;
        this._cachedStats = undefined;
        this._decodedStats = undefined;
        this._lastRenderHistogram = null;
        this._lastRenderUsedWebGL = false;
        this._webglRenderer = new WebGL2FloatRenderer();
        this.loadSignal = undefined;
        this.decodeWorker = null;
    }

    async processPfm(src: string) {
        const loadSignal = this.loadSignal;
        const speculative = await DecodeWorkerClient.takeSpeculativeDecode(src, loadSignal, 'pfm');
        let decoded: any;
        if (speculative?.ok) {
            decoded = speculative.result;
        } else {
            const buffer = speculative?.buffer instanceof ArrayBuffer
                ? speculative.buffer
                : await DecodeWorkerClient.fetchArrayBuffer(src, loadSignal, 'pfm');
            if (loadSignal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
            // Parse in the decode worker when available, locally otherwise.
            decoded = await DecodeWorkerClient.decodeWithFallback(
                this.decodeWorker, 'pfm', buffer, src, loadSignal,
                (b: ArrayBuffer) => decodeNativePfmFast(b) || decodePfmLocal(b, { topDown: true }));
        }
        const { width, height, channels, data, stats } = decoded;
        const displayData = data;

        // Invalidate stats cache for new image; adopt the decoder's stats.
        this._cachedStats = undefined;
        this._decodedStats = stats;

        this._lastRaw = { width, height, data: displayData, channels };

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        // Send format info BEFORE rendering (for deferred rendering)
        if (this._isInitialLoad) {
            this._postFormatInfo(width, height, channels, 'PFM');
            this._pendingRenderData = { displayData, width, height, channels };
            // Return placeholder
            const placeholderImageData = new ImageData(width, height);
            return { canvas, imageData: placeholderImageData };
        }

        // Non-initial loads - render immediately
        this._postFormatInfo(width, height, channels, 'PFM');
        const imageData = this._toImageDataFloat(displayData, width, height, channels);
        this.vscode.postMessage({ type: 'refresh-status' });
        return { canvas, imageData };
    }

    _toImageDataFloat(data: Float32Array, width: number, height: number, channels: number = 1, renderOptions: DeferredRenderOptions = {}): ImageData {
        this._lastRenderHistogram = null;
        this._lastRenderUsedWebGL = false;
        const settings = this.settingsManager.settings;
        const isGammaMode = settings.normalization?.gammaMode || false;
        const typeMin = renderOptions.typeMin ?? 0;
        const typeMax = renderOptions.typeMax ?? 1;

        // Calculate lazily only if the user selects a stats-based mode. The
        // calculator uses the shared Rust/WASM statistics kernel when ready.
        let stats: { min: number, max: number } | undefined = this._cachedStats;
        if (!stats && NormalizationHelper.needsStats(settings)) {
            stats = this._decodedStats || ImageStatsCalculator.calculateFloatStats(data, width, height, channels);
            this._cachedStats = stats;

            if (this.vscode && stats) {
                this.vscode.postMessage({ type: 'stats', value: stats });
            }
        }

        const nanColor = this._getNanColor(settings);
        if (renderOptions.targetCanvas && this._webglRenderer.canRender({
            data,
            width,
            height,
            channels,
            isFloat: true,
            settings,
            collectHistogram: renderOptions.collectHistogram === true
        })) {
            const rendered = this._webglRenderer.render(renderOptions.targetCanvas, {
                data,
                width,
                height,
                min: (stats && Number.isFinite(stats.min)) ? stats.min : 0,
                max: (stats && Number.isFinite(stats.max)) ? stats.max : 1,
                typeMin,
                typeMax,
                settings,
                nanColor,
                channels
            });
            if (rendered) {
                this._lastRenderUsedWebGL = true;
                return renderOptions.placeholderImageData || new ImageData(width, height);
            }
        }

        // Use centralized ImageRenderer
        const options: { nanColor: { r: number, g: number, b: number }, collectHistogram: boolean, typeMin: number, typeMax: number, renderHistogramResult?: any } = {
            nanColor,
            collectHistogram: renderOptions.collectHistogram === true,
            typeMin,
            typeMax,
        };
        const imageData = ImageRenderer.render(
            data,
            width,
            height,
            channels,
            true, // isFloat (float32)
            stats || { min: 0, max: 1 },
            settings,
            options
        );
        this._lastRenderHistogram = options.renderHistogramResult || null;
        return imageData;
    }

    getColorAtPixel(x: number, y: number, naturalWidth: number, naturalHeight: number): string {
        if (!this._lastRaw) return '';
        const { width, height, data, channels } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';

        const idx = y * width + x;

        // Helper to format individual values (avoid scientific notation)
        const formatValue = (v: number) => {
            if (Number.isNaN(v)) return 'NaN';
            if (v === Infinity) return 'Inf';
            if (v === -Infinity) return '-Inf';
            // Use fixed decimal notation to avoid scientific notation
            // Show up to 6 decimal places, but remove trailing zeros
            return parseFloat(v.toFixed(6)).toString();
        };

        if (channels === 3) {
            // RGB data - return space-separated values
            const baseIdx = idx * 3;
            if (baseIdx >= 0 && baseIdx + 2 < data.length) {
                const r = data[baseIdx];
                const g = data[baseIdx + 1];
                const b = data[baseIdx + 2];
                return `${formatValue(r)} ${formatValue(g)} ${formatValue(b)}`;
            }
        } else {
            // Grayscale data
            const value = data[idx];
            return formatValue(value);
        }
        return '';
    }

    _getNanColor(settings: any): { r: number, g: number, b: number } {
        if (settings.nanColor === 'fuchsia') {
            return { r: 255, g: 0, b: 255 };
        } else {
            return { r: 0, g: 0, b: 0 };
        }
    }

    _postFormatInfo(width: number, height: number, channels: number, formatLabel: string): void {
        if (!this.vscode) return;
        this.vscode.postMessage({
            type: 'formatInfo',
            value: {
                width,
                height,
                compression: '1',
                predictor: 3,
                photometricInterpretation: channels === 3 ? 2 : 1,
                planarConfig: 1,
                samplesPerPixel: channels,
                bitsPerSample: 32,
                sampleFormat: 3,
                formatLabel,
                formatType: 'pfm', // For per-format settings
                isInitialLoad: this._isInitialLoad // Signal that this is the first load
            }
        });
    }

    /**
     * Perform the initial render if it was deferred
     * Called when format-specific settings have been applied
     * @returns The rendered image data, or null if no pending render
     */
    performDeferredRender(renderOptions: DeferredRenderOptions = {}): ImageData | null {
        if (!this._pendingRenderData) {
            return null;
        }

        const { displayData, width, height, channels } = this._pendingRenderData;
        this._pendingRenderData = null;
        this._isInitialLoad = false;

        // Now render with the correct format-specific settings
        const imageData = this._toImageDataFloat(displayData, width, height, channels, renderOptions);

        // Force status refresh
        this.vscode.postMessage({ type: 'refresh-status' });

        return imageData;
    }

    /**
     * Re-render PFM with current settings (for real-time updates)
     */
    renderPfmWithSettings(renderOptions: DeferredRenderOptions = {}): ImageData | null {
        if (!this._lastRaw) return null;
        const { width, height, data, channels } = this._lastRaw;
        return this._toImageDataFloat(data, width, height, channels, renderOptions);
    }

    /**
     * Update settings and trigger re-render
     * @param settings - New settings
     */
    updateSettings(settings: ImageSettings): void {
        this.settingsManager.updateSettings(settings);
        // Invalidate cached stats when settings change (especially for auto-normalize)
        if (settings.normalization?.autoNormalize !== this.settingsManager.settings.normalization?.autoNormalize) {
            this._cachedStats = undefined;
        }
        // Post message to trigger re-render in main code
        if (this.vscode) {
            this.vscode.postMessage({ type: 'settings-updated' });
        }
    }

    _flipImageVertically(data: Float32Array, width: number, height: number, channels: number = 1): Float32Array {
        const flipped = new Float32Array(data.length);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (channels === 3) {
                    // RGB data - flip each channel
                    const srcIdx = (y * width + x) * 3;
                    const dstIdx = ((height - 1 - y) * width + x) * 3;
                    flipped[dstIdx] = data[srcIdx];         // R
                    flipped[dstIdx + 1] = data[srcIdx + 1]; // G
                    flipped[dstIdx + 2] = data[srcIdx + 2]; // B
                } else {
                    // Grayscale data
                    const srcIdx = y * width + x;
                    const dstIdx = (height - 1 - y) * width + x;
                    flipped[dstIdx] = data[srcIdx];
                }
            }
        }
        return flipped;
    }
}
