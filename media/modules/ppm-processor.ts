"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';
import { DecodeWorkerClient, type DecodeWorkerLike } from './decode-worker-client.js';
import { decodePpmLocal } from './main-thread-decode.js';
import { decodeBinaryNetpbmFast } from './fast-raw-decoders.js';
import { WebGL2FloatRenderer } from './webgl2-float-renderer.js';
import { PerfTrace } from './perf-trace.js';
import type { SettingsManager } from './settings-manager.js';
import type { DeferredRenderOptions } from './types.js';

const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

type VsCodeApi = { postMessage: (msg: any) => any };

interface RawImageData {
    width: number;
    height: number;
    data: Uint8Array | Uint16Array;
    maxval: number;
    channels: number;
    format: string;
}

interface PendingRenderData {
    displayData: Uint8Array | Uint16Array;
    width: number;
    height: number;
    maxval: number;
    channels: number;
}

/**
 * PPM/PGM Processor for TIFF Visualizer
 * Supports PGM (grayscale) and PPM (RGB) portable pixmap files
 * Both ASCII (P2/P3) and binary (P5/P6) formats
 */
export class PpmProcessor {
    settingsManager: SettingsManager;
    vscode: VsCodeApi;
    _lastRaw: RawImageData | null; // { width, height, data: Uint8Array|Uint16Array, maxval, channels }
    _pendingRenderData: PendingRenderData | null; // Store data waiting for format-specific settings
    _isInitialLoad: boolean; // Track if this is the first render
    _cachedStats: { min: number, max: number } | undefined; // Cache for min/max stats (only used in stats mode)
    _cachedStatsRgb24Mode: boolean; // Track whether cached stats were computed in rgb24 mode
    /** Stats computed by the Rust decoder for the current `_lastRaw` (see
     * `DecodedArray::finalize_stats` in crates/image-decoders/src/lib.rs). Only
     * valid for the plain (non-rgbAs24BitGrayscale) render. */
    _decodedStats: { min: number, max: number } | undefined;
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
        this._cachedStatsRgb24Mode = false;
        this._decodedStats = undefined;
        this._lastRenderUsedWebGL = false;
        this._webglRenderer = new WebGL2FloatRenderer();
        this.loadSignal = undefined;
        this.decodeWorker = null;
    }

    async processPpm(src: string) {
        const loadSignal = this.loadSignal;
        const buffer = await DecodeWorkerClient.fetchArrayBuffer(src, loadSignal, 'ppm');
        if (loadSignal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
        // Parse in the decode worker when available, locally otherwise.
        const { width, height, channels, data, numericDomain, formatLabel: format, stats } = await DecodeWorkerClient.decodeWithFallback(
            this.decodeWorker, 'ppm', buffer, src, loadSignal,
            (b: ArrayBuffer) => decodeBinaryNetpbmFast(b) || decodePpmLocal(b));
        const maxval = numericDomain.typeMax;

        // Keep RGB data for color display
        const displayData = data;

        // PPM stores pixels from top-to-bottom, which is the correct orientation for canvas
        // No flipping needed unless specifically required by the format

        // The initial gamma-mode display decoder intentionally skips stats.
        // A non-gamma render computes them lazily below.
        this._cachedStats = undefined;
        this._cachedStatsRgb24Mode = false;
        this._decodedStats = stats;

        this._lastRaw = { width, height, data: displayData, maxval, channels, format };

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        // Send format info BEFORE rendering (for deferred rendering)
        if (this._isInitialLoad) {
            this._postFormatInfo(width, height, channels, format, maxval);
            this._pendingRenderData = { displayData, width, height, maxval, channels };
            // Return placeholder
            const placeholderImageData = new ImageData(width, height);
            return { canvas, imageData: placeholderImageData };
        }

        // Non-initial loads - render immediately
        this._postFormatInfo(width, height, channels, format, maxval);
        const imageData = this._toImageDataWithNormalization(displayData, width, height, maxval, channels);
        this.vscode.postMessage({ type: 'refresh-status' });
        return { canvas, imageData };
    }

    _toImageDataWithNormalization(data: Uint8Array | Uint16Array, width: number, height: number, maxval: number, channels: number = 1, renderOptions: DeferredRenderOptions = {}): ImageData {
        this._lastRenderUsedWebGL = false;
        const settings = this.settingsManager.settings;
        const rgbAs24BitMode = (settings.rgbAs24BitGrayscale ?? false) && channels === 3;
        const isGammaMode = settings.normalization?.gammaMode || false;

        // Invalidate cached stats if rgb24 mode changed
        if (this._cachedStatsRgb24Mode !== rgbAs24BitMode) {
            this._cachedStats = undefined;
        }

        // Calculate stats if needed
        let stats = this._cachedStats;
        if (!stats && NormalizationHelper.needsStats(settings)) {
            if (rgbAs24BitMode) {
                // For 24-bit mode, compute stats from combined 24-bit values
                let min = Infinity;
                let max = -Infinity;
                const len = width * height;

                // Check if data is 16-bit to handle scaling correctly
                const is16Bit = data instanceof Uint16Array;

                for (let i = 0; i < len; i++) {
                    const srcIdx = i * 3;
                    let r, g, b;

                    if (is16Bit) {
                        r = Math.round(data[srcIdx] / 257);
                        g = Math.round(data[srcIdx + 1] / 257);
                        b = Math.round(data[srcIdx + 2] / 257);
                    } else {
                        r = data[srcIdx];
                        g = data[srcIdx + 1];
                        b = data[srcIdx + 2];
                    }

                    const combined24bit = (r << 16) | (g << 8) | b;
                    if (combined24bit < min) min = combined24bit;
                    if (combined24bit > max) max = combined24bit;
                }
                stats = { min, max };
            } else {
                stats = this._decodedStats || ImageStatsCalculator.calculateIntegerStats(data, width, height, channels, false);
            }
            this._cachedStats = stats;
            this._cachedStatsRgb24Mode = rgbAs24BitMode;
            if (this.vscode && stats) {
                this.vscode.postMessage({ type: 'stats', value: stats });
            }
        }

        // Create options object
        const options = {
            rgbAs24BitGrayscale: rgbAs24BitMode,
            typeMax: rgbAs24BitMode ? 16777215 : maxval
        };
        const typeMax = rgbAs24BitMode ? 16777215 : maxval;
        if (renderOptions.targetCanvas && this._webglRenderer.canRender({
            data,
            width,
            height,
            channels,
            isFloat: false,
            settings
        })) {
            const rendered = this._webglRenderer.render(renderOptions.targetCanvas, {
                data: data as Uint16Array,
                width,
                height,
                channels,
                isFloat: false,
                min: (stats && Number.isFinite(stats.min)) ? stats.min : 0,
                max: (stats && Number.isFinite(stats.max)) ? stats.max : typeMax,
                typeMax,
                settings,
                nanColor: { r: 0, g: 0, b: 0 }
            });
            if (rendered) {
                this._lastRenderUsedWebGL = true;
                return renderOptions.placeholderImageData || new ImageData(width, height);
            }
        }

        return ImageRenderer.render(
            data,
            width,
            height,
            channels,
            false, // isFloat
            stats,
            settings,
            options
        );
    }


    /**
     * Re-render PPM/PGM with current settings (for real-time updates)
     */
    renderPgmWithSettings(renderOptions: DeferredRenderOptions = {}): ImageData | null {
        if (!this._lastRaw) return null;
        const { width, height, data, maxval, channels } = this._lastRaw;
        return this._toImageDataWithNormalization(data, width, height, maxval, channels, renderOptions);
    }

    /**
     * Get color at specific pixel
     * @param x - X coordinate
     * @param y - Y coordinate
     * @param naturalWidth - Image natural width
     * @param naturalHeight - Image natural height
     * @returns Color string
     */
    getColorAtPixel(x: number, y: number, naturalWidth: number, naturalHeight: number): string {
        if (!this._lastRaw) return '';
        const { width, height, data, channels, maxval } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';

        const settings = this.settingsManager.settings;
        const rgbAs24BitMode = (settings.rgbAs24BitGrayscale ?? false) && channels === 3;
        const normalizedFloatMode = settings.normalizedFloatMode;

        const idx = y * width + x;
        if (rgbAs24BitMode) {
            // RGB as 24-bit grayscale: show combined value
            const baseIdx = idx * 3;
            if (baseIdx >= 0 && baseIdx + 2 < data.length) {
                const r = Math.round(Math.max(0, Math.min(255, data[baseIdx])));
                const g = Math.round(Math.max(0, Math.min(255, data[baseIdx + 1])));
                const b = Math.round(Math.max(0, Math.min(255, data[baseIdx + 2])));
                const combined24bit = (r << 16) | (g << 8) | b;

                // Apply scale factor for display
                const scaleFactor = settings.scale24BitFactor || 1000;
                const scaledValue = (combined24bit / scaleFactor).toFixed(3);
                return scaledValue;
            }
        } else if (channels === 3) {
            // RGB data (normal mode) - return space-separated values
            const baseIdx = idx * 3;
            if (baseIdx >= 0 && baseIdx + 2 < data.length) {
                const r = data[baseIdx];
                const g = data[baseIdx + 1];
                const b = data[baseIdx + 2];
                return `${r} ${g} ${b}`;
            }
        } else {
            // Grayscale data
            if (idx >= 0 && idx < data.length) {
                const value = data[idx];

                // Check if normalized float mode is enabled
                if (normalizedFloatMode) {
                    // Convert uint to normalized float (0-1)
                    const normalized = value / maxval;
                    return normalized.toPrecision(4);
                }

                return value.toString();
            }
        }
        return '';
    }

    _flipImageVertically(data: Uint8Array | Uint16Array, width: number, height: number): Uint8Array | Uint16Array {
        const flipped: Uint8Array | Uint16Array = new (data.constructor as any)(data.length);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const srcIdx = y * width + x;
                const dstIdx = (height - 1 - y) * width + x;
                flipped[dstIdx] = data[srcIdx];
            }
        }
        return flipped;
    }

    /**
     * Send format info to VS Code
     * @param width - Image width
     * @param height - Image height
     * @param channels - Number of channels
     * @param formatLabel - Format label
     * @param maxval - Maximum value
     */
    _postFormatInfo(width: number, height: number, channels: number, formatLabel: string, maxval: number): void {
        if (!this.vscode) return;
        this.vscode.postMessage({
            type: 'formatInfo',
            value: {
                width,
                height,
                compression: 'None',
                predictor: 1,
                photometricInterpretation: channels === 3 ? 2 : 1,
                planarConfig: 1,
                samplesPerPixel: channels,
                bitsPerSample: maxval > 255 ? 16 : 8,
                sampleFormat: 1, // Unsigned integer
                formatLabel,
                maxval,
                formatType: 'ppm', // For per-format settings
                isInitialLoad: this._isInitialLoad // Signal that this is the first load
            }
        });
    }

    /**
     * Perform the initial render if it was deferred
     * Called when format-specific settings have been applied
     * Perform deferred rendering using stored data and current settings
     * @returns Rendered image data or null
     */
    performDeferredRender(renderOptions: DeferredRenderOptions = {}): ImageData | null {
        if (!this._pendingRenderData) {
            return null;
        }

        const { displayData, width, height, maxval, channels } = this._pendingRenderData;
        this._pendingRenderData = null;
        this._isInitialLoad = false;

        PerfTrace.mark('ppm-deferred-render-start');
        // Now render with the correct format-specific settings
        const imageData = this._toImageDataWithNormalization(displayData, width, height, maxval, channels, renderOptions);

        // Force status refresh
        this.vscode.postMessage({ type: 'refresh-status' });

        return imageData;
    }
}
