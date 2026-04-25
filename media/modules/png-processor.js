// @ts-check
"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';

/**
 * @typedef {Object} RawImageData
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array | Uint8ClampedArray | Uint16Array} data
 * @property {number} channels
 * @property {number} bitDepth
 * @property {number} maxValue
 * @property {boolean} isRgbaFormat - If true, data is RGBA format; if false, data is raw channel format
 * @property {boolean} [hasAlpha] - Whether the image actually has a meaningful alpha channel (native API path only)
 * @property {ImageData} [originalImageData] - Original ImageData from getImageData for zero-copy fast path
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
        this._pendingRenderData = null;
        this._isInitialLoad = true;
        /** @type {{min:number,max:number}|undefined} */
        this._cachedStats = undefined;
        this._cachedStatsRgb24Mode = false;
        this._lastRenderReusedOriginalImageData = false;
        /** @type {{image: HTMLImageElement, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, tempCanvas?: HTMLCanvasElement, tempCtx?: CanvasRenderingContext2D | null, width: number, height: number, format: string} | null} */
        this._lazyNativeReadback = null;
    }

    /**
     * Process PNG/JPEG file - uses native API for 8-bit PNGs and all JPEGs, UPNG for 16-bit PNGs
     * Note: JPEG handling is included here since JPEGs are always 8-bit and use the same native Image API path
     * @param {string} src - Source URI
     * @returns {Promise<{canvas: HTMLCanvasElement, imageData: ImageData | null, canvasAlreadyRendered?: boolean, lazyPixelData?: boolean, displayElement?: HTMLElement}>}
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
            this._cachedStatsRgb24Mode = false;

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
     * @returns {Promise<{canvas: HTMLCanvasElement, imageData: ImageData | null, canvasAlreadyRendered?: boolean, lazyPixelData?: boolean, displayElement?: HTMLElement}>}
     */
    async _processWithNativeAPI(src) {
        const lowerSrc = src.toLowerCase();
        const isJpeg = lowerSrc.includes('.jpg') || lowerSrc.includes('.jpeg');
        const image = new Image();
        const canvas = document.createElement('canvas');
        canvas.classList.add('scale-to-fit');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        if (!ctx) {
            throw new Error('Could not get canvas context');
        }

        return new Promise((resolve, reject) => {
            image.onload = () => {
                try {
                    canvas.width = image.naturalWidth;
                    canvas.height = image.naturalHeight;

                    const format = lowerSrc.includes('.png') ? 'PNG' :
                        isJpeg ? 'JPEG' :
                            'Image';

                    // Large JPEGs: show <img> immediately and use 1x1 canvas for pixel picking
                    if (isJpeg && canvas.width * canvas.height > 100_000) {
                        image.classList.add('scale-to-fit');
                        this._lastRaw = null;
                        this._cachedStats = undefined;
                        this._cachedStatsRgb24Mode = false;
                        this._lazyNativeReadback = { image, canvas, ctx, width: canvas.width, height: canvas.height, format: 'JPEG' };
                        this._postFormatInfo(canvas.width, canvas.height, 4, 8, 'JPEG');
                        this._pendingRenderData = false;
                        resolve({ canvas, imageData: null, canvasAlreadyRendered: true, lazyPixelData: true, displayElement: image });
                        return;
                    }

                    ctx.drawImage(image, 0, 0);
                    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const rawData = imageData.data;

                    // JPEG cannot carry alpha — skip the scan
                    let hasAlpha = false;
                    if (!isJpeg) {
                        for (let i = 3; i < rawData.length; i += 4) {
                            if (rawData[i] < 255) {
                                hasAlpha = true;
                                break;
                            }
                        }
                    }

                    this._cachedStats = undefined;
                    this._cachedStatsRgb24Mode = false;
                    this._lastRaw = {
                        width: canvas.width,
                        height: canvas.height,
                        data: rawData,
                        channels: 4,
                        bitDepth: 8,
                        maxValue: 255,
                        isRgbaFormat: true,
                        hasAlpha,
                        originalImageData: imageData
                    };

                    this._postFormatInfo(canvas.width, canvas.height, 4, 8, format);
                    this._pendingRenderData = true;

                    resolve({ canvas, imageData, canvasAlreadyRendered: true });
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
        if (!this._lastRaw) return new ImageData(1, 1);
        this._lastRenderReusedOriginalImageData = false;

        const { width, height, data, channels, bitDepth, maxValue, originalImageData } = this._lastRaw;
        const settings = this.settingsManager.settings;
        const isFloat = false; // PNG is always integer

        // Ultra-fast path: If we have the original ImageData from getImageData and no processing is needed, return it directly
        // This is a zero-copy optimization for the common case: 8-bit PNG/JPEG with no normalization or effects
        const isIdentity = NormalizationHelper.isIdentityTransformation(settings);
        const isGammaMode = settings.normalization?.gammaMode || false;
        const rgbAs24BitMode = settings.rgbAs24BitGrayscale && channels >= 3;

        if (originalImageData &&
            isGammaMode &&
            isIdentity &&
            !rgbAs24BitMode &&
            bitDepth === 8) {
            // Can use original ImageData directly - no processing needed
            this._lastRenderReusedOriginalImageData = true;
            return originalImageData;
        }

        // Calculate stats if needed
        if (this._cachedStatsRgb24Mode !== rgbAs24BitMode) {
            this._cachedStats = undefined;
        }
        /** @type {{min:number,max:number}|undefined} */
        let stats = this._cachedStats;
        if (!stats && !isGammaMode) {
            stats = ImageStatsCalculator.calculateIntegerStats(/** @type {any} */ (data), width, height, channels, rgbAs24BitMode);
            this._cachedStats = stats;
            this._cachedStatsRgb24Mode = rgbAs24BitMode;
            if (this.vscode) {
                this.vscode.postMessage({ type: 'stats', value: stats });
            }
        }

        // For gamma mode, provide dummy stats (renderer uses full type range)
        if (isGammaMode && !stats) {
            stats = { min: 0, max: maxValue };
        }

        // Create options object
        const options = {
            rgbAs24BitGrayscale: settings.rgbAs24BitGrayscale && channels >= 3,
            typeMax: maxValue
        };

        return ImageRenderer.render(
            data,
            width,
            height,
            channels,
            isFloat,
            stats,
            settings,
            options
        );
    }
    hasLazyNativeReadback() {
        return !!this._lazyNativeReadback;
    }

    /** @param {any} settings @returns {boolean} */
    canUseLazyNativeCanvasForSettings(settings) {
        if (!this._lazyNativeReadback) return false;
        const isGammaMode = settings.normalization?.gammaMode || false;
        const isIdentity = NormalizationHelper.isIdentityTransformation(settings);
        const rgbAs24BitMode = settings.rgbAs24BitGrayscale === true;
        return isGammaMode && isIdentity && !rgbAs24BitMode;
    }

    /** @returns {ImageData | null} */
    _ensureLazyNativeImageData() {
        if (this._lastRaw?.originalImageData) return this._lastRaw.originalImageData;
        if (!this._lazyNativeReadback) return null;
        const { image, canvas, ctx } = this._lazyNativeReadback;
        ctx.drawImage(image, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        this._lastRaw = { width: canvas.width, height: canvas.height, data: imageData.data, channels: 4, bitDepth: 8, maxValue: 255, isRgbaFormat: true, hasAlpha: false, originalImageData: imageData };
        this._lazyNativeReadback = null;
        return imageData;
    }

    renderPngWithSettings() {
        if (!this._lastRaw && !this._ensureLazyNativeImageData()) return null;
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
        if (!this._lastRaw && this._lazyNativeReadback) {
            const lazy = this._lazyNativeReadback;
            if (lazy.width !== naturalWidth || lazy.height !== naturalHeight) return '';
            if (!lazy.tempCanvas) {
                lazy.tempCanvas = document.createElement('canvas');
                lazy.tempCanvas.width = 1;
                lazy.tempCanvas.height = 1;
                lazy.tempCtx = lazy.tempCanvas.getContext('2d', { willReadFrequently: true });
            }
            if (!lazy.tempCtx) return '';
            lazy.tempCtx.clearRect(0, 0, 1, 1);
            lazy.tempCtx.drawImage(lazy.image, x, y, 1, 1, 0, 0, 1, 1);
            const pixel = lazy.tempCtx.getImageData(0, 0, 1, 1).data;
            return `${pixel[0].toString().padStart(3, '0')} ${pixel[1].toString().padStart(3, '0')} ${pixel[2].toString().padStart(3, '0')}`;
        }
        if (!this._lastRaw) return '';
        const { width, height, data, channels, bitDepth, maxValue, hasAlpha } = this._lastRaw;
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

                    if (channels === 4 && hasAlpha !== false) {
                        const maxVal = bitDepth === 16 ? 65535 : 255;
                        const a = data[dataIdx + 3];
                        return `${scaledValue} α:${(a / maxVal).toFixed(2)}`;
                    } else {
                        return scaledValue;
                    }
                }

                // Normal mode - show RGB values
                // hasAlpha=false means native API returned RGBA but image has no real alpha
                const showAlpha = channels === 4 && hasAlpha !== false;
                if (!showAlpha) {
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

        // Determine format type: 'png' or 'jpg' based on format label
        const formatType = formatLabel === 'JPEG' ? 'jpg' : 'png';

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
                formatType: formatType, // 'png' or 'jpg' for independent settings
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
        const imageData = this._renderToImageData();

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
