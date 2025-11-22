// @ts-check
"use strict";

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
     * Process PNG file using UPNG.js
     * @param {string} src - Source URI
     * @returns {Promise<{canvas: HTMLCanvasElement, imageData: ImageData}>}
     */
    async processPng(src) {
        // JPEG files should use fallback path (browser Image API)
        const isJpeg = src.toLowerCase().includes('.jpg') || src.toLowerCase().includes('.jpeg');

        // Check if UPNG is available (loaded via script tag)
        // @ts-ignore
        if (typeof UPNG === 'undefined' || isJpeg) {
            if (isJpeg) {
                // JPEG files use browser Image API directly
                return this._processPngFallback(src);
            }
            console.warn('UPNG.js not available, falling back to browser Image API');
            return this._processPngFallback(src);
        }

        try {
            // Invalidate stats cache for new image
            this._cachedStats = undefined;
            // Fetch PNG file as ArrayBuffer
            const response = await fetch(src);
            const arrayBuffer = await response.arrayBuffer();

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
            let bitDepth = png.depth;
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
                bitDepth = 8;
            } else {
                // Use raw data - may be uint8 or uint16!
                if (bitDepth === 16) {
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
                bitDepth,
                maxValue: bitDepth === 16 ? 65535 : 255,
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
            this._postFormatInfo(width, height, channels, bitDepth, 'PNG');
            const imageData = this._renderToImageData();
            this.vscode.postMessage({ type: 'refresh-status' });
            return { canvas, imageData };
        } catch (error) {
            console.error('UPNG.js processing failed, falling back to browser Image API:', error);
            return this._processPngFallback(src);
        }
    }

    /**
     * Fallback to browser Image API for compatibility
     * @param {string} src - Source URI
     * @returns {Promise<{canvas: HTMLCanvasElement, imageData: ImageData}>}
     */
    async _processPngFallback(src) {
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

                    // Send format info BEFORE rendering (for deferred rendering)
                    if (this._isInitialLoad) {
                        this._postFormatInfo(canvas.width, canvas.height, this._lastRaw.channels, 8, format);
                        this._pendingRenderData = true; // Flag that _lastRaw is ready for deferred render
                        // Return placeholder
                        const placeholderImageData = new ImageData(canvas.width, canvas.height);
                        resolve({ canvas, imageData: placeholderImageData });
                        return;
                    }

                    // Non-initial loads - render immediately
                    this._postFormatInfo(canvas.width, canvas.height, this._lastRaw.channels, 8, format);
                    const finalImageData = this._toImageDataWithGamma(rawData, canvas.width, canvas.height);
                    this.vscode.postMessage({ type: 'refresh-status' });

                    resolve({ canvas, imageData: finalImageData });
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
                const normalized = (rawValue - normMin) / (normMax - normMin);
                const clamped = Math.max(0, Math.min(1, normalized));
                const corrected = this._applyGammaAndBrightness(clamped, settings);
                r = g = b = Math.round(corrected * 255);
            } else if (channels === 2) {
                // Grayscale + Alpha
                const rawValue = data[srcIdx];
                const normalized = (rawValue - normMin) / (normMax - normMin);
                const clamped = Math.max(0, Math.min(1, normalized));
                const corrected = this._applyGammaAndBrightness(clamped, settings);
                r = g = b = Math.round(corrected * 255);
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
                normalized24 = this._applyGammaAndBrightness(normalized24, settings);

                // Display as grayscale
                r = g = b = Math.round(normalized24 * 255);

                // Handle alpha channel if present (RGBA)
                if (channels === 4) {
                    a = Math.round((data[srcIdx + 3] / maxValue) * 255);
                }
            } else if (channels === 3) {
                // RGB (normal mode)
                const rNorm = Math.max(0, Math.min(1, (data[srcIdx] - normMin) / (normMax - normMin)));
                const gNorm = Math.max(0, Math.min(1, (data[srcIdx + 1] - normMin) / (normMax - normMin)));
                const bNorm = Math.max(0, Math.min(1, (data[srcIdx + 2] - normMin) / (normMax - normMin)));
                const rVal = this._applyGammaAndBrightness(rNorm, settings);
                const gVal = this._applyGammaAndBrightness(gNorm, settings);
                const bVal = this._applyGammaAndBrightness(bNorm, settings);
                r = Math.round(rVal * 255);
                g = Math.round(gVal * 255);
                b = Math.round(bVal * 255);
            } else {
                // RGBA (normal mode)
                const rNorm = Math.max(0, Math.min(1, (data[srcIdx] - normMin) / (normMax - normMin)));
                const gNorm = Math.max(0, Math.min(1, (data[srcIdx + 1] - normMin) / (normMax - normMin)));
                const bNorm = Math.max(0, Math.min(1, (data[srcIdx + 2] - normMin) / (normMax - normMin)));
                const rVal = this._applyGammaAndBrightness(rNorm, settings);
                const gVal = this._applyGammaAndBrightness(gNorm, settings);
                const bVal = this._applyGammaAndBrightness(bNorm, settings);
                r = Math.round(rVal * 255);
                g = Math.round(gVal * 255);
                b = Math.round(bVal * 255);
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
     * @param {number} width
     * @param {number} height
     * @returns {ImageData}
     */
    _toImageDataWithGamma(data, width, height) {
        const settings = this.settingsManager.settings;
        const out = new Uint8ClampedArray(width * height * 4);

        // Calculate stats for normalization
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < width * height; i++) {
            const srcIdx = i * 4;
            for (let c = 0; c < 3; c++) {
                const value = data[srcIdx + c];
                if (value < min) min = value;
                if (value > max) max = value;
            }
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

        // Optimization: Check for identity transform
        // If normalization is full range (0-255) AND gamma/brightness are identity
        // We can skip the entire pixel loop
        const gammaIn = settings.gamma?.in ?? 1.0;
        const gammaOut = settings.gamma?.out ?? 1.0;
        const exposureStops = settings.brightness?.offset ?? 0;
        const isIdentityGamma = Math.abs(gammaIn - gammaOut) < 0.001 && Math.abs(exposureStops) < 0.001;
        const isFullRange = normMin === 0 && normMax === 255;

        if (isIdentityGamma && isFullRange) {
            console.log('PNG: Identity transform detected, skipping pixel loop');
            // data is already RGBA and Uint8ClampedArray (or compatible)
            return new ImageData(new Uint8ClampedArray(data), width, height);
        }

        // data is RGBA format [R,G,B,A,R,G,B,A,...]
        for (let i = 0; i < width * height; i++) {
            const srcIdx = i * 4;
            let r = data[srcIdx + 0];
            let g = data[srcIdx + 1];
            let b = data[srcIdx + 2];
            const a = data[srcIdx + 3];

            // Apply normalization first, then gamma and brightness
            // Normalize each channel
            r = Math.max(0, Math.min(1, (r - normMin) / (normMax - normMin)));
            g = Math.max(0, Math.min(1, (g - normMin) / (normMax - normMin)));
            b = Math.max(0, Math.min(1, (b - normMin) / (normMax - normMin)));

            // Apply gamma and brightness corrections
            r = this._applyGammaAndBrightness(r, settings);
            g = this._applyGammaAndBrightness(g, settings);
            b = this._applyGammaAndBrightness(b, settings);

            // Convert back to 0-255
            r = Math.round(r * 255);
            g = Math.round(g * 255);
            b = Math.round(b * 255);

            const outIdx = i * 4;
            out[outIdx + 0] = r;
            out[outIdx + 1] = g;
            out[outIdx + 2] = b;
            out[outIdx + 3] = a;
        }

        return new ImageData(out, width, height);
    }

    /**
     * Apply gamma and brightness corrections
     * Order: remove source gamma → apply brightness → apply target gamma
     * @param {number} normalizedValue - Value in 0-1 range
     * @param {any} settings - Settings object with gamma and brightness
     * @returns {number} Corrected value (may be outside 0-1 range for float images)
     */
    _applyGammaAndBrightness(normalizedValue, settings) {
        const gammaIn = settings.gamma?.in ?? 1.0;   // Source/input gamma (to remove)
        const gammaOut = settings.gamma?.out ?? 1.0; // Target/output gamma (to apply)
        const exposureStops = settings.brightness?.offset ?? 0;

        // Optimization: Skip if no changes (gamma is identity and brightness is 0)
        if (Math.abs(gammaIn - gammaOut) < 0.001 && Math.abs(exposureStops) < 0.001) {
            return normalizedValue;
        }

        // Step 1: Remove input gamma (linearize) - raise to gammaIn power
        let linear = Math.pow(normalizedValue, gammaIn);

        // Step 2: Apply brightness (exposure compensation) in linear space (no clamping)
        linear = linear * Math.pow(2, exposureStops);

        // Step 3: Apply output gamma - raise to 1/gammaOut power
        normalizedValue = Math.pow(linear, 1.0 / gammaOut);

        // Note: Do NOT clamp here - allow values outside [0,1] for float images
        // Clamping will happen when converting to display pixels (0-255)
        return normalizedValue;
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
}
