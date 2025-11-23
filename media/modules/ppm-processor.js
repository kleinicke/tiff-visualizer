// @ts-check
"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';

/**
 * PPM/PGM Processor for TIFF Visualizer
 * Supports PGM (grayscale) and PPM (RGB) portable pixmap files
 * Both ASCII (P2/P3) and binary (P5/P6) formats
 */
export class PpmProcessor {
    constructor(settingsManager, vscode) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        this._lastRaw = null; // { width, height, data: Uint8Array|Uint16Array, maxval, channels }
        this._pendingRenderData = null; // Store data waiting for format-specific settings
        this._isInitialLoad = true; // Track if this is the first render
        this._cachedStats = undefined; // Cache for min/max stats (only used in stats mode)
    }

    async processPpm(src) {
        const response = await fetch(src);
        const buffer = await response.arrayBuffer();
        const { width, height, channels, data, maxval, format } = this._parsePpm(buffer);

        // Keep RGB data for color display
        const displayData = data;

        // PPM stores pixels from top-to-bottom, which is the correct orientation for canvas
        // No flipping needed unless specifically required by the format

        // Invalidate stats cache for new image
        this._cachedStats = undefined;

        this._lastRaw = { width, height, data: displayData, maxval, channels };

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

    _parsePpm(arrayBuffer) {
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
        const width = parseInt(readToken(), 10);
        const height = parseInt(readToken(), 10);
        // PBM files don't have maxval, only PGM/PPM do
        const maxval = isPbm ? 1 : parseInt(readToken(), 10);

        if (width <= 0 || height <= 0 || (!isPbm && maxval <= 0)) {
            throw new Error('Invalid PPM/PGM/PBM dimensions or maxval');
        }

        const pixelCount = width * height;
        const totalValues = pixelCount * channels;

        // Determine data type based on maxval
        const use16bit = !isPbm && maxval > 255;
        const DataType = use16bit ? Uint16Array : Uint8Array;
        const data = new DataType(totalValues);

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

            if (use16bit) {
                // 16-bit values (big-endian as per PPM spec)
                const dataView = new DataView(arrayBuffer, offset);
                for (let i = 0; i < totalValues; i++) {
                    data[i] = dataView.getUint16(i * 2, false); // false = big-endian
                }
            } else {
                // 8-bit values
                for (let i = 0; i < totalValues; i++) {
                    data[i] = uint8Array[offset + i];
                }
            }
        }

        return { width, height, channels, data, maxval, format };
    }



    _toImageDataWithNormalization(data, width, height, maxval, channels = 1) {
        const settings = this.settingsManager.settings;
        const rgbAs24BitMode = settings.rgbAs24BitGrayscale && channels === 3;
        const isGammaMode = settings.normalization?.gammaMode || false;

        // Calculate stats if needed
        let stats = this._cachedStats;
        if (!stats && !isGammaMode) {
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
        }

        // Create options object
        const options = {
            rgbAs24BitGrayscale: rgbAs24BitMode,
            typeMax: rgbAs24BitMode ? 16777215 : maxval
        };

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
    renderPgmWithSettings() {
        if (!this._lastRaw) return null;
        const { width, height, data, maxval, channels } = this._lastRaw;
        return this._toImageDataWithNormalization(data, width, height, maxval, channels);
    }

    /**
     * Get color at specific pixel
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @param {number} naturalWidth - Image natural width
     * @param {number} naturalHeight - Image natural height
     * @returns {string} Color string
     */
    getColorAtPixel(x, y, naturalWidth, naturalHeight) {
        if (!this._lastRaw) return '';
        const { width, height, data, channels, maxval } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';

        const settings = this.settingsManager.settings;
        const rgbAs24BitMode = settings.rgbAs24BitGrayscale && channels === 3;
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

    _flipImageVertically(data, width, height) {
        const flipped = new (data.constructor)(data.length);
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
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} channels - Number of channels
     * @param {string} formatLabel - Format label
     * @param {number} maxval - Maximum value
     */
    _postFormatInfo(width, height, channels, formatLabel, maxval) {
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
     * @returns {ImageData|null} - The rendered image data, or null if no pending render
     */
    /**
     * Perform deferred rendering using stored data and current settings
     * @returns {ImageData|null} Rendered image data or null
     */
    performDeferredRender() {
        if (!this._pendingRenderData) {
            return null;
        }

        const { displayData, width, height, maxval, channels } = this._pendingRenderData;
        this._pendingRenderData = null;
        this._isInitialLoad = false;

        // Now render with the correct format-specific settings
        const imageData = this._toImageDataWithNormalization(displayData, width, height, maxval, channels);

        // Force status refresh
        this.vscode.postMessage({ type: 'refresh-status' });

        return imageData;
    }
}