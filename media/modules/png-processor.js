// @ts-check
"use strict";
import { LutHelper } from './lut-helper.js';

/**
 * @typedef {Object} RawImageData
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array | Uint8ClampedArray | Uint16Array} data
 * @property {number} channels
 * @property {number} bitDepth
 * @property {number} maxValue
 * @property {boolean} isRgbaFormat - If true, data is RGBA format; if false, data is raw channel format
 */

/**
 * PNG Processor for TIFF Visualizer using UPNG.js
 * Supports proper uint16 PNG handling and grayscale/RGB channel detection
 */
export class PngProcessor {
    /**
     * @param {any} settingsManager
     * @param {any} vscode
     */
    constructor(settingsManager, vscode) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        /** @type {RawImageData | null} */
        this._lastRaw = null;
        this._pendingRenderData = null; // Store data waiting for format-specific settings
        this._isInitialLoad = true; // Track if this is the first render
        this._cachedStats = undefined; // Cache for min/max stats (only used in stats mode)
    }

    /**
     * Process PNG/JPEG file - uses native API for 8-bit PNGs and all JPEGs, UPNG for 16-bit PNGs
     * Note: JPEG handling is included here since JPEGs are always 8-bit and use the same native Image API path
     * @param {string} src - Source URI
     * @returns {Promise<{canvas: HTMLCanvasElement, imageData: ImageData}>}
     */
    async processPng(src) {
        // JPEG files always use native browser Image API (they don't support 16-bit)
        const isJpeg = src.toLowerCase().includes('.jpg') || src.toLowerCase().includes('.jpeg');

        if (isJpeg) {
            return this._processWithNativeAPI(src);
        }

        // For PNG files, detect bit depth and choose appropriate loader
        try {
            // Invalidate stats cache for new image
            this._cachedStats = undefined;

            const response = await fetch(src);
            const arrayBuffer = await response.arrayBuffer();

            // Quick bit depth detection from PNG IHDR chunk (just reads byte 24)
            const bitDepth = this._detectPngBitDepth(arrayBuffer);
            // For 8-bit images, use native browser API for better performance
            if (bitDepth === 8 || bitDepth === null) {
                return this._processWithNativeAPI(src);
            }


            // Decode with UPNG.js
            // @ts-ignore
            const png = UPNG.decode(arrayBuffer);

            /*
            png = {
                width: number,
                height: number,
                depth: 1 | 2 | 4 | 8 | 16,  // Bit depth!
                ctype: 0 | 2 | 3 | 4 | 6,   // Color type
                data: ArrayBuffer,           // Raw pixel data
                tabs: {...}                  // Metadata chunks
            }

            Color types:
            0 = Grayscale
            2 = RGB
            3 = Palette (we'll convert to RGB)
            4 = Grayscale + Alpha
            6 = RGBA
            */

            const width = png.width;
            const height = png.height;
            let pngBitDepth = png.depth;
            const colorType = png.ctype;

            // Determine channels
            let channels;
            switch (colorType) {
                case 0: channels = 1; break; // Grayscale
                case 2: channels = 3; break; // RGB
                case 3: channels = 3; break; // Palette → RGB
                case 4: channels = 2; break; // Gray + Alpha
                case 6: channels = 4; break; // RGBA
                default: channels = 3;
            }

            // Convert palette images to RGBA8
            let rawData;
            if (colorType === 3) {
                // @ts-ignore
                const rgba = UPNG.toRGBA8(png);
                rawData = new Uint8Array(rgba[0]); // First frame
                channels = 4;
                pngBitDepth = 8;
            } else {
                // Use raw data - may be uint8 or uint16!
                if (pngBitDepth === 16) {
                    // PNG stores uint16 in big-endian format, need to swap bytes
                    const uint8Data = new Uint8Array(png.data);
                    const uint16Data = new Uint16Array(uint8Data.length / 2);

                    // Swap bytes from big-endian to little-endian
                    for (let i = 0; i < uint16Data.length; i++) {
                        const byteIdx = i * 2;
                        const highByte = uint8Data[byteIdx];     // MSB (big-endian)
                        const lowByte = uint8Data[byteIdx + 1];  // LSB
                        uint16Data[i] = (highByte << 8) | lowByte;
                    }

                    rawData = uint16Data;
                } else {
                    rawData = new Uint8Array(png.data);
                }
            }

            // Store raw data
            this._lastRaw = {
                width,
                height,
                data: rawData,
                channels,
                bitDepth: pngBitDepth,
                maxValue: pngBitDepth === 16 ? 65535 : 255,
                isRgbaFormat: false  // UPNG path stores raw channel format
            };

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;

            // Send format info BEFORE rendering (for deferred rendering)
            if (this._isInitialLoad) {
                this._postFormatInfo(width, height, channels, bitDepth, 'PNG');
                this._pendingRenderData = true; // Flag that _lastRaw is ready for deferred render
                // Return placeholder
                const placeholderImageData = new ImageData(width, height);
                return { canvas, imageData: placeholderImageData };
            }

            // Non-initial loads - render immediately
            this._postFormatInfo(width, height, channels, pngBitDepth, 'PNG');
            const imageData = this._renderToImageData();
            this.vscode.postMessage({ type: 'refresh-status' });
            return { canvas, imageData };
        } catch (error) {
            console.error('UPNG.js processing failed, falling back to browser Image API:', error);
            return this._processWithNativeAPI(src);
        }
    }

    /**
     * Process image using native browser Image API (for 8-bit PNGs and JPEGs)
     * @param {string} src - Source URI
     * @returns {Promise<{canvas: HTMLCanvasElement, imageData: ImageData}>}
     */
    async _processWithNativeAPI(src) {
        const image = new Image();
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        if (!ctx) {
            throw new Error('Could not get canvas context');
        }

        return new Promise((resolve, reject) => {
            image.onload = () => {
                try {
                    canvas.width = image.naturalWidth;
                    canvas.height = image.naturalHeight;

                    ctx.drawImage(image, 0, 0);
                    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const rawData = imageData.data;

                    // Determine if image has alpha channel
                    let hasAlpha = false;
                    for (let i = 3; i < rawData.length; i += 4) {
                        if (rawData[i] < 255) {
                            hasAlpha = true;
                            break;
                        }
                    }

                    this._lastRaw = {
                        width: canvas.width,
                        height: canvas.height,
                        data: rawData,
                        channels: hasAlpha ? 4 : 3,
                        bitDepth: 8,
                        maxValue: 255,
                        isRgbaFormat: true  // Fallback path stores RGBA format from getImageData
                    };

                    const format = src.toLowerCase().includes('.png') ? 'PNG' :
                        src.toLowerCase().includes('.jpg') || src.toLowerCase().includes('.jpeg') ? 'JPEG' :
                            'Image';

                    // Use deferred rendering for consistency with other formats
                    // Send format info and return placeholder - actual rendering happens in performDeferredRender()
                    this._postFormatInfo(canvas.width, canvas.height, this._lastRaw.channels, 8, format);
                    this._pendingRenderData = true; // Flag that _lastRaw is ready for deferred render

                    // Return placeholder
                    const placeholderImageData = new ImageData(canvas.width, canvas.height);
                    resolve({ canvas, imageData: placeholderImageData });
                } catch (error) {
                    reject(error);
                }
            };

            image.onerror = () => {
                reject(new Error('Failed to load image'));
            };

            image.src = src;
        });
    }

    /**
     * Render raw image data to ImageData with gamma/brightness corrections
     * @returns {ImageData}
     */
    _renderToImageData() {
        if (!this._lastRaw) {
            throw new Error('No raw image data available');
        }
        const { width, height, data, channels, bitDepth, maxValue, isRgbaFormat } = this._lastRaw;
        const settings = this.settingsManager.settings;
        const out = new Uint8ClampedArray(width * height * 4);

        // Determine the correct stride based on data format
        const stride = isRgbaFormat ? 4 : channels;
        // Calculate stats for normalization status bar
        let min = Infinity, max = -Infinity;

        // Lazy stats calculation: skip in gamma mode, cache in stats mode
        if (settings.normalization?.gammaMode === true) {
            // Gamma mode: use fixed normalization based on bit depth
            min = 0;
            max = maxValue; // 255 for 8-bit, 65535 for 16-bit
        } else if (this._cachedStats !== undefined) {
            // Stats mode: reuse cached stats if available
            min = this._cachedStats.min;
            max = this._cachedStats.max;
        } else {
            // Stats mode: compute stats for the first time
            if (settings.rgbAs24BitGrayscale && channels >= 3) {
                // For 24-bit mode, calculate stats from combined 24-bit values
                for (let i = 0; i < width * height; i++) {
                    const srcIdx = i * stride;
                    // Get RGB values
                    const rVal = data[srcIdx];
                    const gVal = data[srcIdx + 1];
                    const bVal = data[srcIdx + 2];

                    // Scale to 8-bit if needed (for 16-bit images)
                    const rByte = maxValue === 65535 ? Math.round(rVal / 257) : rVal;
                    const gByte = maxValue === 65535 ? Math.round(gVal / 257) : gVal;
                    const bByte = maxValue === 65535 ? Math.round(bVal / 257) : bVal;

                    // Combine into 24-bit value
                    const combined24bit = (rByte << 16) | (gByte << 8) | bByte;

                    if (combined24bit < min) min = combined24bit;
                    if (combined24bit > max) max = combined24bit;
                }
            } else {
                // Optimization: Fast paths for stats calculation
                if ((channels === 1 || channels === 3) && !isRgbaFormat) {
                    // Contiguous data (Gray or RGB), no alpha to skip
                    // We can iterate the array directly
                    const len = data.length;
                    for (let i = 0; i < len; i++) {
                        const value = data[i];
                        if (value < min) min = value;
                        if (value > max) max = value;
                    }
                } else if (channels === 4 || isRgbaFormat) {
                    // RGBA data, need to skip alpha (every 4th byte)
                    // Unrolled loop for performance
                    const len = width * height * 4;
                    for (let i = 0; i < len; i += 4) {
                        const r = data[i];
                        const g = data[i + 1];
                        const b = data[i + 2];

                        if (r < min) min = r;
                        if (r > max) max = r;
                        if (g < min) min = g;
                        if (g > max) max = g;
                        if (b < min) min = b;
                        if (b > max) max = b;
                    }
                } else {
                    // Fallback for other cases (e.g. Gray+Alpha)
                    for (let i = 0; i < width * height; i++) {
                        const srcIdx = i * stride;
                        for (let c = 0; c < Math.min(3, channels); c++) {
                            const value = data[srcIdx + c];
                            if (value < min) min = value;
                            if (value > max) max = value;
                        }
                    }
                }
            }

            // Cache the computed stats for reuse
            this._cachedStats = { min, max };
        }

        // Send stats to VS Code for status bar
        this.vscode.postMessage({
            type: 'stats',
            value: { min, max }
        });

        // Calculate normalization range based on settings
        let normMin, normMax;

        if (settings.normalization && settings.normalization.autoNormalize) {
            // Auto-normalize: use actual image min/max
            normMin = min;
            normMax = max;
        } else if (settings.normalization && settings.normalization.gammaMode) {
            // Gamma mode: normalize to appropriate range
            normMin = 0;
            if (settings.rgbAs24BitGrayscale && channels >= 3) {
                // For 24-bit mode, use full 24-bit range
                normMax = 16777215; // 0xFFFFFF
            } else {
                // For normal mode, use bit-depth range
                normMax = maxValue;
            }
        } else if (settings.normalization) {
            // Manual mode: use user-specified range
            normMin = settings.normalization.min;
            normMax = settings.normalization.max;

            // If normalized float mode is enabled, interpret the range as 0-1
            if (settings.normalizedFloatMode && channels === 1) {
                // Multiply by maxValue
                normMin = normMin * maxValue;
                normMax = normMax * maxValue;
            }
        } else {
            // Fallback: use bit-depth range
            normMin = 0;
            normMax = maxValue;
        }

        // Optimization: Check for identity transform
        const gammaIn = settings.gamma?.in ?? 1.0;
        const gammaOut = settings.gamma?.out ?? 1.0;
        const exposureStops = settings.brightness?.offset ?? 0;
        const isIdentityGamma = Math.abs(gammaIn - gammaOut) < 0.001 && Math.abs(exposureStops) < 0.001;
        const isFullRange = normMin === 0 && normMax === maxValue;

        if (isIdentityGamma && isFullRange) {
            // Fast path for 8-bit RGBA (already in correct format)
            if (bitDepth === 8 && channels === 4 && !isRgbaFormat) {
                console.time('PNG: Identity Path');
                console.log('PNG: Identity transform detected (8-bit RGBA), skipping pixel loop');
                // Ensure we use the correct length, as UPNG buffer might be larger
                const length = width * height * 4;
                // Create a view of the exact required size
                const result = new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, length), width, height);
                console.timeEnd('PNG: Identity Path');
                return result;
            }
            // Fast path for 8-bit RGB (add alpha)
            if (bitDepth === 8 && channels === 3 && !isRgbaFormat) {
                console.time('PNG: Identity Path');
                console.log('PNG: Identity transform detected (8-bit RGB), using fast loop');
                const out = new Uint8ClampedArray(width * height * 4);
                for (let i = 0; i < width * height; i++) {
                    const srcIdx = i * 3;
                    const outIdx = i * 4;
                    out[outIdx] = data[srcIdx];
                    out[outIdx + 1] = data[srcIdx + 1];
                    out[outIdx + 2] = data[srcIdx + 2];
                    out[outIdx + 3] = 255;
                }
                console.timeEnd('PNG: Identity Path');
                return new ImageData(out, width, height);
            }
            // Fast path for 8-bit Grayscale (expand to RGB)
            if (bitDepth === 8 && channels === 1 && !isRgbaFormat) {
                console.time('PNG: Identity Path');
                console.log('PNG: Identity transform detected (8-bit Gray), using fast loop');
                const out = new Uint8ClampedArray(width * height * 4);
                for (let i = 0; i < width * height; i++) {
                    const val = data[i];
                    const outIdx = i * 4;
                    out[outIdx] = val;
                    out[outIdx + 1] = val;
                    out[outIdx + 2] = val;
                    out[outIdx + 3] = 255;
                }
                console.timeEnd('PNG: Identity Path');
                return new ImageData(out, width, height);
            }
        }

        // Render pixels
        for (let i = 0; i < width * height; i++) {
            const srcIdx = i * stride;  // Use stride instead of channels
            const outIdx = i * 4;

            let r, g, b, a = 255;

            if (channels === 1) {
                // Grayscale
                const rawValue = data[srcIdx];
                // Use LUT directly on raw value
                const corrected = lut[rawValue];
                r = g = b = corrected;
            } else if (channels === 2) {
                // Grayscale + Alpha
                const rawValue = data[srcIdx];
                const corrected = lut[rawValue];
                r = g = b = corrected;
                a = Math.round((data[srcIdx + 1] / maxValue) * 255);
            } else if (settings.rgbAs24BitGrayscale && channels >= 3) {
                // RGB as 24-bit grayscale mode
                // Get raw RGB values (PNG stores as 0-255 for 8-bit, 0-65535 for 16-bit)
                const rVal = Math.round(Math.max(0, Math.min(maxValue, data[srcIdx])));
                const gVal = Math.round(Math.max(0, Math.min(maxValue, data[srcIdx + 1])));
                const bVal = Math.round(Math.max(0, Math.min(maxValue, data[srcIdx + 2])));

                // For 16-bit images, scale down to 8-bit for combining
                const rByte = maxValue === 65535 ? Math.round(rVal / 257) : rVal;
                const gByte = maxValue === 65535 ? Math.round(gVal / 257) : gVal;
                const bByte = maxValue === 65535 ? Math.round(bVal / 257) : bVal;

                // Combine into 24-bit value: (R << 16) | (G << 8) | B
                const combined24bit = (rByte << 16) | (gByte << 8) | bByte;

                // For 24-bit mode, we can't easily use a LUT (too big), so we fallback to calculation
                // Or we could normalize first then use a smaller LUT, but let's stick to calculation for this special mode
                // Max value is 16777215 (0xFFFFFF)

                // Now normalize the combined 24-bit value using normMin/normMax
                const norm24Range = normMax - normMin;
                let normalized24;
                if (norm24Range > 0) {
                    normalized24 = (combined24bit - normMin) / norm24Range;
                } else {
                    normalized24 = 0;
                }
                normalized24 = Math.max(0, Math.min(1, normalized24));

                // Apply gamma/brightness to the combined value
                // Note: We still use the helper method for this special case if we keep it, 
                // or inline the logic. Since we are removing _applyGammaAndBrightness, we inline it here.

                const gammaIn = settings.gamma?.in ?? 1.0;
                const gammaOut = settings.gamma?.out ?? 1.0;
                const exposureStops = settings.brightness?.offset ?? 0;

                let linear = Math.pow(normalized24, gammaIn);
                linear = linear * Math.pow(2, exposureStops);
                normalized24 = Math.pow(linear, 1.0 / gammaOut);

                // Display as grayscale
                r = g = b = Math.round(normalized24 * 255);

                // Handle alpha channel if present (RGBA)
                if (channels === 4) {
                    a = Math.round((data[srcIdx + 3] / maxValue) * 255);
                }
            } else if (channels === 3) {
                // RGB (normal mode)
                r = lut[data[srcIdx]];
                g = lut[data[srcIdx + 1]];
                b = lut[data[srcIdx + 2]];
            } else {
                // RGBA (normal mode)
                r = lut[data[srcIdx]];
                g = lut[data[srcIdx + 1]];
                b = lut[data[srcIdx + 2]];
                a = Math.round((data[srcIdx + 3] / maxValue) * 255);
            }

            out[outIdx] = Math.max(0, Math.min(255, r));
            out[outIdx + 1] = Math.max(0, Math.min(255, g));
            out[outIdx + 2] = Math.max(0, Math.min(255, b));
            out[outIdx + 3] = a;
        }

        return new ImageData(out, width, height);
    }

    /**
     * Fallback gamma rendering for browser Image API path
     * @param {Uint8Array | Uint8ClampedArray} data
```
     * @param {number} width
     * @param {number} height
     * @returns {ImageData}
     */
    _toImageDataWithGamma(data, width, height) {
        const { maxValue } = this._lastRaw;
        const settings = this.settingsManager.settings;
        const out = new Uint8ClampedArray(width * height * 4);

        // Early check for identity transform (before expensive stats calculation)
        // If normalization is full range AND gamma/brightness are identity, we can skip everything
        const gammaIn = settings.gamma?.in ?? 1.0;
        const gammaOut = settings.gamma?.out ?? 1.0;
        const exposureStops = settings.brightness?.offset ?? 0;
        const isIdentityGamma = Math.abs(gammaIn - gammaOut) < 0.001 && Math.abs(exposureStops) < 0.001;

        // Check if normalization will be full range (0-255 for 8-bit)
        // Handle undefined/null settings gracefully - default to gammaMode behavior (0-255)
        const normSettings = settings.normalization;
        const willBeFullRange = (normSettings === undefined || normSettings === null || normSettings.gammaMode === true) ||
            (!normSettings?.autoNormalize &&
                normSettings?.min === 0 &&
                normSettings?.max === 255);

        if (isIdentityGamma && willBeFullRange) {
            // Send fixed stats for 8-bit images
            if (this.vscode) {
                this.vscode.postMessage({ type: 'stats', value: { min: 0, max: 255 } });
            }
            return new ImageData(new Uint8ClampedArray(data), width, height);
        }

        // Calculate min/max for status bar (only if needed for non-identity transforms)
        // Use caching to avoid recomputation when toggling settings
        let min, max;

        if (this._cachedStats !== undefined) {
            // Reuse cached stats
            console.log('PNG (native): Using cached stats');
            min = this._cachedStats.min;
            max = this._cachedStats.max;
        } else {
            // Compute stats for the first time
            min = Infinity;
            max = -Infinity;
            for (let i = 0; i < data.length; i += 4) {
                const r = data[i];
                const g = data[i + 1];
                const b = data[i + 2];
                if (r < min) min = r;
                if (r > max) max = r;
                if (g < min) min = g;
                if (g > max) max = g;
                if (b < min) min = b;
                if (b > max) max = b;
            }

            // Cache the computed stats for reuse
            this._cachedStats = { min, max };
        }

        // Send stats to VS Code
        if (this.vscode) {
            this.vscode.postMessage({ type: 'stats', value: { min, max } });
        }

        // Calculate normalization range (data is already 0-255, so maxValue = 255)
        let normMin, normMax;

        if (settings.normalization && settings.normalization.autoNormalize) {
            normMin = min;
            normMax = max;
        } else if (settings.normalization && settings.normalization.gammaMode) {
            normMin = 0;
            normMax = 255;
        } else if (settings.normalization) {
            normMin = settings.normalization.min;
            normMax = settings.normalization.max;
        } else {
            normMin = 0;
            normMax = 255;
        }

        // Second check for identity transform (after normalization is determined)
        // This catches cases where autoNormalize resulted in full range
        const isFullRange = normMin === 0 && normMax === 255;

        if (isIdentityGamma && isFullRange) {
            console.log('PNG: Identity transform detected, skipping pixel loop');
            return new ImageData(new Uint8ClampedArray(data), width, height);
        }

        // Generate LUT for current settings
        // For native path, data is always 8-bit (0-255)
        const lut = LutHelper.generateLut(settings, 8, 255);

        // data is RGBA format [R,G,B,A,R,G,B,A,...]
        for (let i = 0; i < width * height; i++) {
            const srcIdx = i * 4;
            const outIdx = i * 4;

            // Use LUT for direct lookup
            out[outIdx + 0] = lut[data[srcIdx + 0]];
            out[outIdx + 1] = lut[data[srcIdx + 1]];
            out[outIdx + 2] = lut[data[srcIdx + 2]];
            out[outIdx + 3] = data[srcIdx + 3]; // Alpha unchanged
        }

        return new ImageData(out, width, height);
    }


    /**
     * Re-render PNG with current settings (for real-time updates)
     * @returns {ImageData | null}
     */
    renderPngWithSettings() {
        if (!this._lastRaw) return null;
        return this._renderToImageData();
    }

    /**
     * Get color value at specific pixel coordinates
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @param {number} naturalWidth - Image width
     * @param {number} naturalHeight - Image height
     * @returns {string} Formatted color string
     */
    getColorAtPixel(x, y, naturalWidth, naturalHeight) {
        if (!this._lastRaw) return '';
        const { width, height, data, channels, bitDepth, maxValue } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';

        const pixelIdx = y * width + x;
        const dataIdx = pixelIdx * channels;
        const settings = this.settingsManager.settings;

        if (dataIdx >= 0 && dataIdx < data.length) {
            if (channels === 1) {
                // Grayscale
                const value = data[dataIdx];

                // Check if normalized float mode is enabled
                if (settings.normalizedFloatMode) {
                    // Convert uint to normalized float (0-1)
                    const normalized = value / maxValue;
                    return normalized.toPrecision(4);
                }

                // Normal mode - show actual bit depth value
                return value.toString();
            } else if (channels === 2) {
                // Grayscale + Alpha
                const maxVal = bitDepth === 16 ? 65535 : 255;
                const gray = data[dataIdx];
                const alpha = data[dataIdx + 1];
                return `${gray} α:${(alpha / maxVal).toFixed(2)}`;
            } else if (channels === 3 || channels === 4) {
                // RGB or RGBA
                const r = data[dataIdx];
                const g = data[dataIdx + 1];
                const b = data[dataIdx + 2];

                // If RGB as 24-bit grayscale is enabled, show combined value
                if (settings.rgbAs24BitGrayscale && channels >= 3) {
                    // Scale to 8-bit if needed
                    const rByte = bitDepth === 16 ? Math.round(r / 257) : r;
                    const gByte = bitDepth === 16 ? Math.round(g / 257) : g;
                    const bByte = bitDepth === 16 ? Math.round(b / 257) : b;

                    // Combine into 24-bit value
                    const combined24bit = (rByte << 16) | (gByte << 8) | bByte;

                    // Apply scale factor for display
                    const scaleFactor = settings.scale24BitFactor || 1000;
                    const scaledValue = (combined24bit / scaleFactor).toFixed(3);

                    if (channels === 4) {
                        const maxVal = bitDepth === 16 ? 65535 : 255;
                        const a = data[dataIdx + 3];
                        return `${scaledValue} α:${(a / maxVal).toFixed(2)}`;
                    } else {
                        return scaledValue;
                    }
                }

                // Normal mode - show RGB values
                if (channels === 3) {
                    if (bitDepth === 16) {
                        return `${r} ${g} ${b}`;
                    } else {
                        return `${r.toString().padStart(3, '0')} ${g.toString().padStart(3, '0')} ${b.toString().padStart(3, '0')}`;
                    }
                } else {
                    // RGBA
                    const maxVal = bitDepth === 16 ? 65535 : 255;
                    const a = data[dataIdx + 3];
                    if (bitDepth === 16) {
                        return `${r} ${g} ${b} α:${(a / maxVal).toFixed(2)}`;
                    } else {
                        return `${r.toString().padStart(3, '0')} ${g.toString().padStart(3, '0')} ${b.toString().padStart(3, '0')} α:${(a / maxVal).toFixed(2)}`;
                    }
                }
            }
        }
        return '';
    }

    /**
     * Post format information to VS Code
     * @param {number} width
     * @param {number} height
     * @param {number} channels
     * @param {number} bitDepth
     * @param {string} formatLabel
     */
    _postFormatInfo(width, height, channels, bitDepth, formatLabel) {
        if (!this.vscode) return;
        this.vscode.postMessage({
            type: 'formatInfo',
            value: {
                width,
                height,
                compression: 'Deflate',
                predictor: 1,
                photometricInterpretation: channels >= 3 ? 2 : 1,
                planarConfig: 1,
                samplesPerPixel: channels,
                bitsPerSample: bitDepth,
                sampleFormat: 1, // Unsigned integer
                formatLabel: `${formatLabel} (${bitDepth}-bit)`,
                formatType: 'png',
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
        if (!this._pendingRenderData || !this._lastRaw) {
            return null;
        }

        this._pendingRenderData = null;
        this._isInitialLoad = false;

        // Render with the correct format-specific settings
        let imageData;
        if (this._lastRaw.isRgbaFormat) {
            // Fallback path - data is already RGBA format (Uint8ClampedArray)
            // Type assertion is safe because fallback path always creates Uint8ClampedArray
            imageData = this._toImageDataWithGamma(
                /** @type {Uint8Array | Uint8ClampedArray} */(this._lastRaw.data),
                this._lastRaw.width,
                this._lastRaw.height
            );
        } else {
            // UPNG path - data is in raw channel format
            imageData = this._renderToImageData();
        }

        // Force status refresh
        this.vscode.postMessage({ type: 'refresh-status' });

        return imageData;
    }

    /**
     * Detect PNG bit depth by reading the IHDR chunk
     * @param {ArrayBuffer} arrayBuffer - PNG file data
     * @returns {number|null} - Bit depth (1, 2, 4, 8, or 16), or null if detection fails
     */
    _detectPngBitDepth(arrayBuffer) {
        try {
            const data = new Uint8Array(arrayBuffer);

            // PNG signature: 137 80 78 71 13 10 26 10
            if (data.length < 8 || data[0] !== 137 || data[1] !== 80 || data[2] !== 78 || data[3] !== 71) {
                console.warn('PNG: Invalid PNG signature');
                return null;
            }

            // IHDR chunk starts at byte 8
            // Structure: [length:4][type:4="IHDR"][data:13][crc:4]
            // IHDR data: [width:4][height:4][bitDepth:1][colorType:1][compression:1][filter:1][interlace:1]
            const bitDepth = data[24]; // Bit depth is at offset 24

            return bitDepth;
        } catch (error) {
            console.error('PNG: Failed to detect bit depth:', error);
            return null;
        }
    }
}
