"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';
import { DecodeWorkerClient } from './decode-worker-client.js';
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
        const { width, height, channels, data, maxval, format } = await DecodeWorkerClient.decodeWithFallback(
            this.decodeWorker, 'ppm', buffer, src, loadSignal, (b: ArrayBuffer) => this._parsePpm(b));

        // Keep RGB data for color display
        const displayData = data;

        // PPM stores pixels from top-to-bottom, which is the correct orientation for canvas
        // No flipping needed unless specifically required by the format

        // Invalidate stats cache for new image
        this._cachedStats = undefined;
        this._cachedStatsRgb24Mode = false;

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

    _parsePpm(arrayBuffer: ArrayBuffer) {
        const parserStart = performance.now();
        const decodeTimings: { name: string, durationMs: number }[] = [];
        const uint8Array = new Uint8Array(arrayBuffer);
        let offset = 0;

        // Helper function to read next token
        const readToken = () => {
            // Skip whitespace and comments
            while (offset < uint8Array.length) {
                const char = uint8Array[offset];
                if (char === 35) { // '#' - comment
                    // Skip to end of line
                    while (offset < uint8Array.length && uint8Array[offset] !== 10) {
                        offset++;
                    }
                    if (offset < uint8Array.length) offset++; // Skip newline
                } else if (char === 32 || char === 9 || char === 10 || char === 13) { // whitespace
                    offset++;
                } else {
                    break;
                }
            }

            // Read token
            let token = '';
            while (offset < uint8Array.length) {
                const char = uint8Array[offset];
                if (char === 32 || char === 9 || char === 10 || char === 13 || char === 35) {
                    break;
                }
                token += String.fromCharCode(char);
                offset++;
            }
            return token;
        };

        // Read a numeric header field (width/height/maxval). Unlike readToken,
        // this stops at the first non-digit, so it never swallows binary raster
        // bytes when the single whitespace before the data is missing or when a
        // data byte merely happens not to be whitespace.
        const readNumber = () => {
            // Skip whitespace and comments (same rules as readToken).
            while (offset < uint8Array.length) {
                const char = uint8Array[offset];
                if (char === 35) { // '#' - comment
                    while (offset < uint8Array.length && uint8Array[offset] !== 10) {
                        offset++;
                    }
                    if (offset < uint8Array.length) offset++; // Skip newline
                } else if (char === 32 || char === 9 || char === 10 || char === 13) {
                    offset++;
                } else {
                    break;
                }
            }
            let token = '';
            while (offset < uint8Array.length) {
                const char = uint8Array[offset];
                if (char >= 48 && char <= 57) { // '0'-'9'
                    token += String.fromCharCode(char);
                    offset++;
                } else {
                    break;
                }
            }
            return parseInt(token, 10);
        };

        // Read magic number
        const magic = readToken();
        if (!['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].includes(magic)) {
            throw new Error(`Invalid PPM/PGM/PBM magic number: ${magic}`);
        }

        const isAscii = magic === 'P1' || magic === 'P2' || magic === 'P3';
        const channels = (magic === 'P1' || magic === 'P4' || magic === 'P2' || magic === 'P5') ? 1 : 3;
        const format = magic === 'P1' ? 'PBM (ASCII)' :
            magic === 'P2' ? 'PGM (ASCII)' :
                magic === 'P3' ? 'PPM (ASCII)' :
                    magic === 'P4' ? 'PBM (Binary)' :
                        magic === 'P5' ? 'PGM (Binary)' : 'PPM (Binary)';
        const isPbm = magic === 'P1' || magic === 'P4';

        // Read dimensions
        const width = readNumber();
        const height = readNumber();
        // PBM files don't have maxval, only PGM/PPM do
        const maxval = isPbm ? 1 : readNumber();

        if (width <= 0 || height <= 0 || (!isPbm && maxval <= 0)) {
            throw new Error('Invalid PPM/PGM/PBM dimensions or maxval');
        }

        const pixelCount = width * height;
        const totalValues = pixelCount * channels;

        // Determine data type based on maxval
        const use16bit = !isPbm && maxval > 255;
        const DataType = use16bit ? Uint16Array : Uint8Array;
        let data: Uint8Array | Uint16Array = new DataType(totalValues);
        decodeTimings.push({ name: 'decode-ppm-header', durationMs: performance.now() - parserStart });

        const rasterStart = performance.now();
        if (isPbm && isAscii) {
            // PBM ASCII format (P1) - read 0s and 1s
            for (let i = 0; i < totalValues; i++) {
                const token = readToken();
                const value = parseInt(token, 10);
                if (value !== 0 && value !== 1) {
                    throw new Error(`Invalid PBM pixel value: ${token} (must be 0 or 1)`);
                }
                // Convert 0=white to 255, 1=black to 0 for display
                data[i] = value === 0 ? 255 : 0;
            }
        } else if (isPbm && !isAscii) {
            // PBM binary format (P4) - packed bits
            // PBM spec: exactly one whitespace separates the header from the
            // raster data. Skip it (matching the P5/P6 branch below); tolerate
            // its absence in slightly malformed files.
            if (offset < uint8Array.length) {
                const char = uint8Array[offset];
                if (char === 32 || char === 9 || char === 10 || char === 13) {
                    offset++;
                }
            }

            const bytesPerRow = Math.ceil(width / 8);
            const expectedBytes = bytesPerRow * height;

            if (offset + expectedBytes > uint8Array.length) {
                throw new Error('Insufficient data for binary PBM');
            }

            let dataIdx = 0;
            for (let row = 0; row < height; row++) {
                for (let col = 0; col < width; col++) {
                    const byteIdx = offset + row * bytesPerRow + Math.floor(col / 8);
                    const bitIdx = 7 - (col % 8); // Most significant bit first
                    const bit = (uint8Array[byteIdx] >> bitIdx) & 1;
                    // Convert 0=white to 255, 1=black to 0 for display
                    data[dataIdx++] = bit === 0 ? 255 : 0;
                }
            }
        } else if (isAscii) {
            // ASCII format - read space-separated values (P2/P3)
            for (let i = 0; i < totalValues; i++) {
                const token = readToken();
                const value = parseInt(token, 10);
                if (isNaN(value) || value < 0 || value > maxval) {
                    throw new Error(`Invalid pixel value: ${token}`);
                }
                data[i] = value;
            }
        } else {
            const binarySetupStart = performance.now();
            // Binary format (P5/P6)
            // PPM spec: after maxval, there is exactly ONE whitespace character (usually newline),
            // then the binary data starts immediately
            // Skip the single whitespace separator
            if (offset < uint8Array.length) {
                const char = uint8Array[offset];
                if (char === 32 || char === 9 || char === 10 || char === 13) {
                    offset++;
                }
            }

            const bytesPerValue = use16bit ? 2 : 1;
            const expectedBytes = totalValues * bytesPerValue;

            if (offset + expectedBytes > uint8Array.length) {
                throw new Error('Insufficient data for binary PPM/PGM');
            }
            decodeTimings.push({ name: 'decode-ppm-binary-setup', durationMs: performance.now() - binarySetupStart });

            const binaryCopyStart = performance.now();
            if (use16bit) {
                // 16-bit values are big-endian in NetPBM. Prefer a Uint16Array
                // view plus in-place byte swap over byte-by-byte reconstruction.
                const isAligned = offset % 2 === 0;
                const rasterBuffer = isAligned ? arrayBuffer : arrayBuffer.slice(offset, offset + expectedBytes);
                const rasterOffset = isAligned ? offset : 0;
                data = new Uint16Array(rasterBuffer, rasterOffset, totalValues);
                if (IS_LITTLE_ENDIAN) {
                    for (let i = 0; i < totalValues; i++) {
                        const value = data[i];
                        data[i] = ((value & 0xff) << 8) | (value >>> 8);
                    }
                    decodeTimings.push({
                        name: isAligned ? 'decode-ppm-byte-swap-u16-inplace' : 'decode-ppm-byte-swap-u16-slice',
                        durationMs: performance.now() - binaryCopyStart
                    });
                } else {
                    decodeTimings.push({
                        name: isAligned ? 'decode-ppm-raster-view-u16' : 'decode-ppm-raster-slice-u16',
                        durationMs: performance.now() - binaryCopyStart
                    });
                }
            } else {
                // 8-bit binary raster can be used as a direct view.
                data = uint8Array.subarray(offset, offset + expectedBytes);
                decodeTimings.push({
                    name: 'decode-ppm-raster-view-u8',
                    durationMs: performance.now() - binaryCopyStart
                });
            }
        }
        decodeTimings.push({ name: 'decode-ppm-raster-total', durationMs: performance.now() - rasterStart });
        for (const timing of decodeTimings) {
            PerfTrace.detail(timing.name, timing.durationMs);
        }

        return { width, height, channels, data, maxval, format, decodeTimings };
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
                stats = ImageStatsCalculator.calculateIntegerStats(data, width, height, channels);
            }
            this._cachedStats = stats;
            this._cachedStatsRgb24Mode = rgbAs24BitMode;
            if (this.vscode) {
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
