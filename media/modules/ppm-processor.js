// @ts-check
"use strict";

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
    }

    async processPpm(src) {
        const response = await fetch(src);
        const buffer = await response.arrayBuffer();
        const { width, height, channels, data, maxval, format } = this._parsePpm(buffer);
        
        // Keep RGB data for color display
        const displayData = data;

        // PPM stores pixels from top-to-bottom, which is the correct orientation for canvas
        // No flipping needed unless specifically required by the format

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

    _toImageData(data, width, height, maxval, channels = 1) {
        const settings = this.settingsManager.settings;
        const out = new Uint8ClampedArray(width * height * 4);
        
        // Normalize to 0-255 range
        const scale = 255 / maxval;
        
        for (let i = 0; i < width * height; i++) {
            let r, g, b;
            
            if (channels === 3) {
                // RGB data
                r = data[i * 3 + 0] * scale;
                g = data[i * 3 + 1] * scale;
                b = data[i * 3 + 2] * scale;
            } else {
                // Grayscale data
                const value = data[i] * scale;
                r = g = b = value;
            }
            
            // Apply gamma and brightness corrections
            // Correct order: remove input gamma → apply brightness → apply output gamma
            if (settings.gamma || settings.brightness) {
                const gammaIn = settings.gamma?.in ?? 1.0;
                const gammaOut = settings.gamma?.out ?? 1.0;
                const exposureStops = settings.brightness?.offset ?? 0;

                // Normalize to 0-1 range first
                r = r / 255;
                g = g / 255;
                b = b / 255;

                // Step 1: Remove input gamma (linearize) - raise to gammaIn power
                r = Math.pow(r, gammaIn);
                g = Math.pow(g, gammaIn);
                b = Math.pow(b, gammaIn);

                // Step 2: Apply brightness in linear space (no clamping)
                const brightnessFactor = Math.pow(2, exposureStops);
                r = r * brightnessFactor;
                g = g * brightnessFactor;
                b = b * brightnessFactor;

                // Step 3: Apply output gamma - raise to 1/gammaOut power
                r = Math.pow(r, 1.0 / gammaOut);
                g = Math.pow(g, 1.0 / gammaOut);
                b = Math.pow(b, 1.0 / gammaOut);

                // Convert back to 0-255 range (without clamping - allows values outside range)
                r = r * 255;
                g = g * 255;
                b = b * 255;
            }

            const p = i * 4;
            // Clamp only for display conversion to valid byte range
            out[p] = Math.round(Math.max(0, Math.min(255, r)));     // R
            out[p + 1] = Math.round(Math.max(0, Math.min(255, g))); // G
            out[p + 2] = Math.round(Math.max(0, Math.min(255, b))); // B
            out[p + 3] = 255;        // A
        }

        // Send stats to VS Code
        if (this.vscode) {
            let min = Infinity, max = -Infinity;
            for (let i = 0; i < data.length; i++) {
                const value = data[i];
                if (value < min) min = value;
                if (value > max) max = value;
            }
            this.vscode.postMessage({ type: 'stats', value: { min, max } });
        }

        return new ImageData(out, width, height);
    }

    _toImageDataWithNormalization(data, width, height, maxval, channels = 1) {
        const settings = this.settingsManager.settings;
        const rgbAs24BitMode = settings.rgbAs24BitGrayscale && channels === 3;

        // Calculate min/max for auto-normalization
        let min = Infinity, max = -Infinity;

        if (rgbAs24BitMode) {
            // For 24-bit mode, compute stats from combined 24-bit values
            for (let i = 0; i < width * height; i++) {
                const srcIdx = i * 3;
                const r = Math.round(Math.max(0, Math.min(255, data[srcIdx + 0])));
                const g = Math.round(Math.max(0, Math.min(255, data[srcIdx + 1])));
                const b = Math.round(Math.max(0, Math.min(255, data[srcIdx + 2])));
                const combined24bit = (r << 16) | (g << 8) | b;
                min = Math.min(min, combined24bit);
                max = Math.max(max, combined24bit);
            }
        } else {
            // Normal mode: use individual channel values
            for (let i = 0; i < data.length; i++) {
                const value = data[i];
                if (value < min) min = value;
                if (value > max) max = value;
            }
        }

        let normMin, normMax;

        // PPM/PGM files are always uint, so default to gamma mode (0-maxval range)
        // unless user explicitly requests auto-normalization or custom range
        if (settings.normalization && settings.normalization.autoNormalize) {
            // User explicitly requested auto-normalize
            normMin = min;
            normMax = max;
        } else if (settings.normalization && settings.normalization.gammaMode) {
            // Gamma mode: use type-appropriate range
            normMin = 0;
            if (rgbAs24BitMode) {
                normMax = 16777215; // 24-bit max
            } else {
                normMax = maxval; // Use file's maxval
            }
        } else if (settings.normalization && (settings.normalization.min !== undefined && settings.normalization.max !== undefined)) {
            // Manual mode: user-specified range
            normMin = settings.normalization.min;
            normMax = settings.normalization.max;

            // If normalized float mode is enabled, interpret the range as 0-1
            if (settings.normalizedFloatMode) {
                // Multiply by maxval
                normMin = normMin * maxval;
                normMax = normMax * maxval;
                console.log(`[PpmProcessor] Manual with normalized float mode: [${settings.normalization.min}, ${settings.normalization.max}] → [${normMin}, ${normMax}]`);
            }
        } else {
            // Default for all PPM/PGM: use gamma mode with 0-maxval range
            normMin = 0;
            normMax = maxval;
        }

        const range = normMax - normMin || 1;
        const out = new Uint8ClampedArray(width * height * 4);

        for (let i = 0; i < width * height; i++) {
            let r, g, b;

            if (rgbAs24BitMode) {
                // RGB as 24-bit grayscale
                const srcIdx = i * 3;
                const rVal = Math.round(Math.max(0, Math.min(255, data[srcIdx + 0])));
                const gVal = Math.round(Math.max(0, Math.min(255, data[srcIdx + 1])));
                const bVal = Math.round(Math.max(0, Math.min(255, data[srcIdx + 2])));
                const combined24bit = (rVal << 16) | (gVal << 8) | bVal;
                const normalized = (combined24bit - normMin) / range;
                r = g = b = Math.max(0, Math.min(1, normalized));
            } else if (channels === 3) {
                // RGB data (PPM)
                const srcIdx = i * 3;
                r = (data[srcIdx + 0] - normMin) / range;
                g = (data[srcIdx + 1] - normMin) / range;
                b = (data[srcIdx + 2] - normMin) / range;

                // Clamp to 0-1 range
                r = Math.max(0, Math.min(1, r));
                g = Math.max(0, Math.min(1, g));
                b = Math.max(0, Math.min(1, b));
            } else {
                // Grayscale data (PGM)
                let normalizedValue = (data[i] - normMin) / range;
                normalizedValue = Math.max(0, Math.min(1, normalizedValue));
                r = g = b = normalizedValue;
            }

            // Apply gamma and brightness only in gamma mode, NOT in auto-normalize mode
            const applyGamma = settings.normalization?.gammaMode === true &&
                              settings.normalization?.autoNormalize !== true;
            if (applyGamma) {
                const gammaIn = settings.gamma?.in ?? 1.0;
                const gammaOut = settings.gamma?.out ?? 1.0;
                const exposureStops = settings.brightness?.offset ?? 0;

                // Step 1: Remove input gamma (linearize) - raise to gammaIn power
                r = Math.pow(r, gammaIn);
                g = Math.pow(g, gammaIn);
                b = Math.pow(b, gammaIn);

                // Step 2: Apply brightness in linear space
                const brightnessFactor = Math.pow(2, exposureStops);
                r = r * brightnessFactor;
                g = g * brightnessFactor;
                b = b * brightnessFactor;

                // Step 3: Apply output gamma - raise to 1/gammaOut power
                r = Math.pow(r, 1.0 / gammaOut);
                g = Math.pow(g, 1.0 / gammaOut);
                b = Math.pow(b, 1.0 / gammaOut);

                // Clamp after gamma correction
                r = Math.max(0, Math.min(1, r));
                g = Math.max(0, Math.min(1, g));
                b = Math.max(0, Math.min(1, b));
            }

            const p = i * 4;
            out[p] = Math.round(r * 255);     // R
            out[p + 1] = Math.round(g * 255); // G
            out[p + 2] = Math.round(b * 255); // B
            out[p + 3] = 255;                 // A
        }

        // Send stats to VS Code
        if (this.vscode) {
            this.vscode.postMessage({ type: 'stats', value: { min, max } });
        }

        return new ImageData(out, width, height);
    }

    /**
     * Re-render PPM/PGM with current settings (for real-time updates)
     */
    renderPgmWithSettings() {
        if (!this._lastRaw) return null;
        const { width, height, data, maxval, channels } = this._lastRaw;
        return this._toImageDataWithNormalization(data, width, height, maxval, channels);
    }

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