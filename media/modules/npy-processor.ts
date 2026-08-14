"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';
import { DecodeWorkerClient } from './decode-worker-client.js';
import { decodeNpyLocal } from './main-thread-decode.js';
import { WebGL2FloatRenderer } from './webgl2-float-renderer.js';
import type { SettingsManager, ImageSettings } from './settings-manager.js';
import type { DeferredRenderOptions } from './types.js';

type VsCodeApi = { postMessage: (msg: any) => any };

/** Mirrors the `numericDomain` shape `wasm-decoders.ts`'s `assembleDecoded`
 * reads off the Rust `DecodedArray` struct: `sampleFormat` 1=uint, 2=int,
 * 3=float (the TIFF convention). */
interface NumericDomain {
    bitsPerSample: number;
    sampleFormat: number;
    typeMin: number;
    typeMax: number;
    sourceNumericType: string;
}

interface RawImageData {
    width: number;
    height: number;
    data: Float32Array;
    dtype: string;
    numericDomain: NumericDomain;
    channels: number;
}

interface PendingRenderData {
    data: Float32Array;
    width: number;
    height: number;
}

/**
 * NPY/NPZ Processor for TIFF Visualizer
 * Parses NumPy .npy and .npz files and renders them to ImageData
 */
export class NpyProcessor {
    settingsManager: SettingsManager;
    vscode: VsCodeApi;
    _lastRaw: RawImageData | null; // { width, height, data: Float32Array, dtype: string, numericDomain, channels }
    _pendingRenderData: PendingRenderData | null; // Store data waiting for format-specific settings
    _isInitialLoad: boolean; // Track if this is the first render
    _cachedStats: { min: number, max: number } | undefined; // Cache for min/max stats (only used in stats mode)
    _cachedStatsRgb24Mode: boolean; // Track whether cached stats were computed in rgb24 mode
    /** Stats computed by the Rust decoder for the current `_lastRaw` (see
     * `DecodedArray::finalize_stats` in wasm/tiff-decoder/src/lib.rs). Only
     * valid for the plain (non-rgbAs24BitGrayscale) render. */
    _decodedStats: { min: number, max: number } | undefined;
    _lastRenderHistogram: any;
    _lastRenderUsedWebGL: boolean;
    _webglRenderer: WebGL2FloatRenderer;
    /** Set before each load; aborts the fetch when a newer image switch supersedes it */
    loadSignal: AbortSignal | undefined;
    /** Off-thread decoder, set by imagePreview.js; null falls back to local decoding */
    decodeWorker: DecodeWorkerClient | null;

    constructor(settingsManager: SettingsManager, vscode: VsCodeApi) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        this._lastRaw = null;
        this._pendingRenderData = null;
        this._isInitialLoad = true;
        this._cachedStats = undefined;
        this._cachedStatsRgb24Mode = false;
        this._decodedStats = undefined;
        this._lastRenderHistogram = null;
        this._lastRenderUsedWebGL = false;
        this._webglRenderer = new WebGL2FloatRenderer();
        this.loadSignal = undefined;
        this.decodeWorker = null;
    }

    async processNpy(src: string) {
        const loadSignal = this.loadSignal;
        // Invalidate stats cache for new image
        this._cachedStats = undefined;
        this._cachedStatsRgb24Mode = false;

        const buffer = await DecodeWorkerClient.fetchArrayBuffer(src, loadSignal, 'npy');
        if (loadSignal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }

        // Decode in the worker when available, on this thread otherwise. The
        // Rust decoder dispatches between plain .npy and .npz internally, so
        // both paths take the same call.
        const parsed = await DecodeWorkerClient.decodeWithFallback(
            this.decodeWorker, 'npy', buffer, src, loadSignal,
            (b: ArrayBuffer) => decodeNpyLocal(b));
        const { data, width, height, metadata, numericDomain, channels, stats } = parsed;
        // The numpy dtype string (e.g. "<f4") is user-visible display info,
        // not part of the DecodedArray schema — it travels through
        // `metadata.dtype` (see wasm/tiff-decoder/src/formats/npy.rs).
        const dtype: string = (metadata && metadata.dtype) || '';
        this._lastRaw = { width, height, data, dtype, numericDomain, channels };
        // Stats computed once inside the Rust decoder (DecodedArray::finalize_stats).
        // Only valid for the plain (non-rgbAs24BitGrayscale) render — see
        // _toImageDataFloat, which recomputes in JS when that mode is on.
        this._decodedStats = stats;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        // Send format info BEFORE rendering (for deferred rendering)
        if (this._isInitialLoad) {
            this._postFormatInfo(width, height, 'NPY');
            this._pendingRenderData = { data, width, height };
            // Return placeholder
            const placeholderImageData = new ImageData(width, height);
            return { canvas, imageData: placeholderImageData };
        }

        // Non-initial loads - render immediately
        const imageData = this._toImageDataFloat(data, width, height);
        this.vscode.postMessage({ type: 'refresh-status' });
        return { canvas, imageData };
    }

    _toImageDataFloat(data: Float32Array, width: number, height: number, renderOptions: DeferredRenderOptions = {}): ImageData {
        this._lastRenderHistogram = null;
        this._lastRenderUsedWebGL = false;
        const channels = this._lastRaw?.channels || 1;
        const settings = this.settingsManager.settings;
        const rgbAs24BitMode = (settings.rgbAs24BitGrayscale ?? false) && channels === 3;
        const numericDomain = this._lastRaw?.numericDomain;
        const isFloat = (numericDomain?.sampleFormat ?? 3) === 3;
        const isGammaMode = settings.normalization?.gammaMode || false;

        // Calculate stats if needed (for auto-normalize or just to have them)
        if (this._cachedStatsRgb24Mode !== rgbAs24BitMode) {
            this._cachedStats = undefined;
        }
        let stats: { min: number, max: number } | undefined = this._cachedStats;

        if (!stats && NormalizationHelper.needsStats(settings)) {
            if (rgbAs24BitMode) {
                // rgbAs24BitGrayscale packs channels into a different value space
                // than the decoder scanned (see DecodedArray::finalize_stats), so
                // its stats don't apply here. Recompute in JS rather than trying
                // to make this wasm-synchronous — see CLAUDE.md/task notes on
                // this being an intentionally JS-only path.
                stats = ImageStatsCalculator.calculateIntegerStats(data as any, width, height, channels, true);
            } else {
                // Already computed once inside the Rust decoder.
                stats = this._decodedStats;
            }
            this._cachedStats = stats;
            this._cachedStatsRgb24Mode = rgbAs24BitMode;

            if (this.vscode && stats) {
                this.vscode.postMessage({ type: 'stats', value: stats });
            }
        }

        const nanColor = this._getNanColor(settings);

        // Determine typeMax for integer types. The Rust decoder already
        // parsed the dtype (see wasm/tiff-decoder/src/formats/npy.rs's
        // `numeric_info_from_dtype`), so this reads its result instead of
        // re-deriving it from the dtype string here.
        const typeMax = isFloat ? undefined : numericDomain?.typeMax;
        const effectiveTypeMax = typeMax ?? 1.0;

        if (renderOptions.targetCanvas && this._webglRenderer.canRender({
            data,
            width,
            height,
            channels,
            isFloat,
            settings,
            collectHistogram: renderOptions.collectHistogram === true
        })) {
            const rendered = this._webglRenderer.render(renderOptions.targetCanvas, {
                data,
                width,
                height,
                min: (stats && Number.isFinite(stats.min)) ? stats.min : 0,
                max: (stats && Number.isFinite(stats.max)) ? stats.max : effectiveTypeMax,
                typeMax: effectiveTypeMax,
                settings,
                nanColor,
                channels
            });
            if (rendered) {
                this._lastRenderUsedWebGL = true;
                return renderOptions.placeholderImageData || new ImageData(width, height);
            }
        }

        // Create options object
        const options: { nanColor: { r: number, g: number, b: number }, rgbAs24BitGrayscale: boolean, flipY: boolean, typeMax: number | undefined, collectHistogram: boolean, renderHistogramResult?: any } = {
            nanColor: nanColor,
            rgbAs24BitGrayscale: rgbAs24BitMode,
            flipY: false, // NPY is usually top-down
            typeMax: typeMax,
            collectHistogram: renderOptions.collectHistogram === true
        };

        const imageData = ImageRenderer.render(
            data,
            width,
            height,
            channels,
            true, // Always true since NPY stores everything as Float32Array
            stats || { min: 0, max: 1 },
            settings,
            options
        );
        this._lastRenderHistogram = options.renderHistogramResult || null;
        return imageData;
    }


    /**
     * Re-render NPY with current settings (for real-time updates)
     */
    renderNpyWithSettings(renderOptions: DeferredRenderOptions = {}): ImageData | null {
        if (!this._lastRaw) return null;
        const { width, height, data } = this._lastRaw;
        return this._toImageDataFloat(data, width, height, renderOptions);
    }

    getColorAtPixel(x: number, y: number, naturalWidth: number, naturalHeight: number): string {
        if (!this._lastRaw) return '';
        const { width, height, data, channels, dtype } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';

        const pixelIdx = y * width + x;
        const settings = this.settingsManager.settings;
        const rgbAs24BitMode = (settings.rgbAs24BitGrayscale ?? false) && channels === 3;
        const normalizedFloatMode = settings.normalizedFloatMode;
        const formatNumber = (n: number) => {
            if (Number.isNaN(n)) return 'NaN';
            if (n === Infinity) return 'Inf';
            if (n === -Infinity) return '-Inf';
            return parseFloat(n.toFixed(6)).toString();
        };

        if (rgbAs24BitMode) {
            // RGB as 24-bit grayscale: show combined value
            const srcIdx = pixelIdx * 3;
            const rVal = Math.round(Math.max(0, Math.min(255, data[srcIdx + 0])));
            const gVal = Math.round(Math.max(0, Math.min(255, data[srcIdx + 1])));
            const bVal = Math.round(Math.max(0, Math.min(255, data[srcIdx + 2])));
            const combined24bit = (rVal << 16) | (gVal << 8) | bVal;

            // Apply scale factor for display
            const scaleFactor = settings.scale24BitFactor || 1000;
            const scaledValue = (combined24bit / scaleFactor).toFixed(3);
            return scaledValue;
        } else if (channels === 3) {
            // RGB data - return space-separated values (avoid scientific notation)
            const srcIdx = pixelIdx * 3;
            const r = data[srcIdx + 0];
            const g = data[srcIdx + 1];
            const b = data[srcIdx + 2];
            return `${formatNumber(r)} ${formatNumber(g)} ${formatNumber(b)}`;
        } else if (channels === 4) {
            // RGBA data - return space-separated values with α: prefix for alpha
            const srcIdx = pixelIdx * 4;
            const r = data[srcIdx + 0];
            const g = data[srcIdx + 1];
            const b = data[srcIdx + 2];
            const a = data[srcIdx + 3];
            return `${formatNumber(r)} ${formatNumber(g)} ${formatNumber(b)} α:${formatNumber(a)}`;
        } else {
            // Grayscale data
            const value = data[pixelIdx];
            // Check if normalized float mode is enabled for uint images
            if (normalizedFloatMode && dtype && !dtype.includes('f') && Number.isFinite(value)) {
                // Convert uint to normalized float (0-1)
                let maxValue = 255;
                if (dtype.includes('u2') || dtype.includes('i2')) {
                    maxValue = dtype.includes('u') ? 65535 : 32767;
                } else if (dtype.includes('u4') || dtype.includes('i4')) {
                    maxValue = dtype.includes('u') ? 4294967295 : 2147483647;
                }
                const normalized = value / maxValue;
                return formatNumber(normalized);
            }
            return formatNumber(value);
        }
        return '';
    }

    /**
     * Send format info to VS Code
     * @param width - Image width
     * @param height - Image height
     * @param formatLabel - Format label
     */
    _postFormatInfo(width: number, height: number, formatLabel: string): void {
        if (!this.vscode) return;

        // Bit depth and sample format come straight from the Rust decoder's
        // parsed dtype (see wasm/tiff-decoder/src/formats/npy.rs's
        // `numeric_info_from_dtype`) instead of re-deriving them here.
        const numericDomain = this._lastRaw?.numericDomain;
        const bitsPerSample = numericDomain?.bitsPerSample ?? 32;
        const sampleFormat = numericDomain?.sampleFormat ?? 3; // 1=uint, 2=int, 3=float

        const channels = this._lastRaw?.channels || 1;

        // Determine specific NPY format type for per-format settings
        let formatType = 'npy';
        if (sampleFormat === 3) {
            formatType = 'npy-float';
        } else if (sampleFormat === 1 || sampleFormat === 2) {
            formatType = 'npy-uint';
        }

        this.vscode.postMessage({
            type: 'formatInfo',
            value: {
                width,
                height,
                compression: '1',
                predictor: 3,
                photometricInterpretation: channels >= 3 ? 2 : 1,
                planarConfig: 1,
                samplesPerPixel: channels,
                bitsPerSample,
                sampleFormat,
                formatLabel,
                formatType, // For per-format settings: 'npy-float' or 'npy-uint'
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

        const { data, width, height } = this._pendingRenderData;
        this._pendingRenderData = null;
        this._isInitialLoad = false;

        // Now render with the correct format-specific settings
        const imageData = this._toImageDataFloat(data, width, height, renderOptions);

        // Force status refresh so normalization UI appears
        this.vscode.postMessage({ type: 'refresh-status' });

        return imageData;
    }

    /**
     * Get NaN color from settings
     */
    _getNanColor(settings: any): { r: number, g: number, b: number } {
        if (settings.nanColor) {
            if (typeof settings.nanColor === 'string') {
                if (settings.nanColor === 'fuchsia') {
                    return { r: 255, g: 0, b: 255 };
                }
                if (settings.nanColor === 'black') {
                    return { r: 0, g: 0, b: 0 };
                }
                // Handle explicit hex string.
                const hex = settings.nanColor.replace('#', '');
                if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
                    return { r: 0, g: 0, b: 0 };
                }
                return {
                    r: parseInt(hex.substring(0, 2), 16),
                    g: parseInt(hex.substring(2, 4), 16),
                    b: parseInt(hex.substring(4, 6), 16)
                };
            }
            // Handle object
            return settings.nanColor;
        }
        return { r: 0, g: 0, b: 0 };
    }
}
