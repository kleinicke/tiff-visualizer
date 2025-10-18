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
    }

    /**
     * Process PNG file using UPNG.js
     * @param {string} src - Source URI
     * @returns {Promise<{canvas: HTMLCanvasElement, imageData: ImageData}>}
     */
    async processPng(src) {
        // Check if UPNG is available (loaded via script tag)
        // @ts-ignore
        if (typeof UPNG === 'undefined') {
            console.warn('UPNG.js not available, falling back to browser Image API');
            return this._processPngFallback(src);
        }

        try {
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

            this._postFormatInfo(width, height, channels, bitDepth, 'PNG');

            // Render to ImageData
            const imageData = this._renderToImageData();

            // Force status refresh
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
        console.log(`[PngProcessor] _renderToImageData: channels=${channels}, isRgbaFormat=${isRgbaFormat}, stride=${stride}`);
        console.log(`[PngProcessor] settings.rgbAs24BitGrayscale:`, settings.rgbAs24BitGrayscale);
        console.log(`[PngProcessor] Full settings:`, settings);

        // Calculate stats for normalization status bar
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < width * height; i++) {
            const srcIdx = i * stride;
            for (let c = 0; c < Math.min(3, channels); c++) {
                const value = data[srcIdx + c];
                if (value < min) min = value;
                if (value > max) max = value;
            }
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
            console.log(`[PngProcessor] Auto-normalize mode: [${normMin}, ${normMax}]`);
        } else if (settings.normalization && settings.normalization.gammaMode) {
            // Gamma mode: normalize to bit-depth range (0 to maxValue)
            normMin = 0;
            normMax = maxValue;
            console.log(`[PngProcessor] Gamma mode: [${normMin}, ${normMax}] (bit depth: ${bitDepth})`);
        } else if (settings.normalization) {
            // Manual mode: use user-specified range
            normMin = settings.normalization.min;
            normMax = settings.normalization.max;
            console.log(`[PngProcessor] Manual mode: [${normMin}, ${normMax}]`);
        } else {
            // Fallback: use bit-depth range
            normMin = 0;
            normMax = maxValue;
            console.log(`[PngProcessor] Fallback mode: [${normMin}, ${normMax}]`);
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
                // Apply normalization to each channel first, then combine
                const rNorm = Math.max(0, Math.min(1, (data[srcIdx] - normMin) / (normMax - normMin)));
                const gNorm = Math.max(0, Math.min(1, (data[srcIdx + 1] - normMin) / (normMax - normMin)));
                const bNorm = Math.max(0, Math.min(1, (data[srcIdx + 2] - normMin) / (normMax - normMin)));

                // Convert to 0-255 range for combining
                const rVal = Math.round(rNorm * 255);
                const gVal = Math.round(gNorm * 255);
                const bVal = Math.round(bNorm * 255);

                // Combine into 24-bit value: (R << 16) | (G << 8) | B
                const combined24bit = (rVal << 16) | (gVal << 8) | bVal;
                // Max value is 16777215 (0xFFFFFF)

                // Normalize 24-bit value to 0-1 range
                let normalized24 = combined24bit / 16777215.0;

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
            console.log(`[PngProcessor] _toImageDataWithGamma Auto-normalize: [${normMin}, ${normMax}]`);
        } else if (settings.normalization && settings.normalization.gammaMode) {
            normMin = 0;
            normMax = 255;
            console.log(`[PngProcessor] _toImageDataWithGamma Gamma mode: [${normMin}, ${normMax}]`);
        } else if (settings.normalization) {
            normMin = settings.normalization.min;
            normMax = settings.normalization.max;
            console.log(`[PngProcessor] _toImageDataWithGamma Manual mode: [${normMin}, ${normMax}]`);
        } else {
            normMin = 0;
            normMax = 255;
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
     * @returns {number} Corrected value in 0-1 range
     */
    _applyGammaAndBrightness(normalizedValue, settings) {
        const gammaIn = settings.gamma?.in ?? 1.0;   // Source/input gamma (to remove)
        const gammaOut = settings.gamma?.out ?? 1.0; // Target/output gamma (to apply)
        const exposureStops = settings.brightness?.offset ?? 0;

        // Step 1: Remove input gamma (linearize) - raise to gammaIn power
        let linear = Math.pow(normalizedValue, gammaIn);

        // Step 2: Apply brightness (exposure compensation) in linear space
        linear = linear * Math.pow(2, exposureStops);

        // Step 3: Apply output gamma - raise to 1/gammaOut power
        normalizedValue = Math.pow(linear, 1.0 / gammaOut);

        return Math.max(0, Math.min(1, normalizedValue));
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
        const { width, height, data, channels, bitDepth } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';

        const pixelIdx = y * width + x;
        const dataIdx = pixelIdx * channels;

        if (dataIdx >= 0 && dataIdx < data.length) {
            if (channels === 1) {
                // Grayscale - show actual bit depth value
                return data[dataIdx].toString();
            } else if (channels === 2) {
                // Grayscale + Alpha
                const maxVal = bitDepth === 16 ? 65535 : 255;
                const gray = data[dataIdx];
                const alpha = data[dataIdx + 1];
                return `${gray} α:${(alpha / maxVal).toFixed(2)}`;
            } else if (channels === 3) {
                // RGB - show actual bit depth values
                const r = data[dataIdx];
                const g = data[dataIdx + 1];
                const b = data[dataIdx + 2];
                if (bitDepth === 16) {
                    return `${r} ${g} ${b}`;
                } else {
                    return `${r.toString().padStart(3, '0')} ${g.toString().padStart(3, '0')} ${b.toString().padStart(3, '0')}`;
                }
            } else {
                // RGBA
                const maxVal = bitDepth === 16 ? 65535 : 255;
                const r = data[dataIdx];
                const g = data[dataIdx + 1];
                const b = data[dataIdx + 2];
                const a = data[dataIdx + 3];

                if (bitDepth === 16) {
                    return `${r} ${g} ${b} α:${(a / maxVal).toFixed(2)}`;
                } else {
                    return `${r.toString().padStart(3, '0')} ${g.toString().padStart(3, '0')} ${b.toString().padStart(3, '0')} α:${(a / maxVal).toFixed(2)}`;
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
                formatType: 'png'
            }
        });
    }
}
