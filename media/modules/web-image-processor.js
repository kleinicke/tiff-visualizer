// @ts-check
"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';

/**
 * Web Image Processor for TIFF Visualizer
 * Supports native formats like WebP, AVIF, and BMP via the browser's Image Decoder.
 */
export class WebImageProcessor {
    constructor(settingsManager, vscode) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        this._lastRaw = null; // { width, height, data: Uint8ClampedArray }
        this._pendingRenderData = null; // Store data waiting for format-specific settings
        this._isInitialLoad = true; // Track if this is the first render
        /** @type {{min: number, max: number} | undefined} */
        this._cachedStats = undefined;
    }

    async processWebImage(src) {
        // Detect format from src string
        let formatName = 'Web Image';
        let formatType = 'webimage';
        if (src.toLowerCase().includes('.webp')) { formatName = 'WebP'; formatType = 'webp'; }
        else if (src.toLowerCase().includes('.avif')) { formatName = 'AVIF'; formatType = 'avif'; }
        else if (src.toLowerCase().includes('.bmp')) { formatName = 'BMP'; formatType = 'bmp'; }
        else if (src.toLowerCase().includes('.ico')) { formatName = 'ICO'; formatType = 'ico'; }

        // Invalidate stats cache for new image
        this._cachedStats = undefined;

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

                    this._lastRaw = {
                        width: canvas.width,
                        height: canvas.height,
                        data: rawData,
                        channels: 4, // Canvas always gives RGBA
                        bitDepth: 8,
                        maxValue: 255,
                        originalImageData: imageData
                    };

                    if (this._isInitialLoad) {
                        this._postFormatInfo(canvas.width, canvas.height, 4, 8, formatName, formatType);
                        this._pendingRenderData = { data: rawData, width: canvas.width, height: canvas.height };
                        const placeholderImageData = new ImageData(canvas.width, canvas.height);
                        resolve({ canvas, imageData: placeholderImageData });
                        return;
                    }

                    this._postFormatInfo(canvas.width, canvas.height, 4, 8, formatName, formatType);
                    const processedImageData = this._renderToImageData(rawData, canvas.width, canvas.height, 4, imageData);
                    
                    if (this.vscode) {
                        this.vscode.postMessage({ type: 'refresh-status' });
                    }
                    resolve({ canvas, imageData: processedImageData });
                } catch (error) {
                    reject(error);
                }
            };

            image.onerror = () => {
                reject(new Error(`Failed to load native image via browser. Check if ${formatName} is supported by your VS Code/Electron version.`));
            };

            image.src = src;
        });
    }

    _renderToImageData(data, width, height, channels = 4, originalImageData = null) {
        const settings = this.settingsManager.settings;
        const isGammaMode = settings.normalization?.gammaMode || false;
        const isIdentity = NormalizationHelper.isIdentityTransformation(settings);
        const rgbAs24BitMode = settings.rgbAs24BitGrayscale && channels >= 3;

        // Zero-copy optimization path
        if (originalImageData && isGammaMode && isIdentity && !rgbAs24BitMode) {
            return originalImageData;
        }

        let stats = this._cachedStats;
        if (!stats && !isGammaMode) {
            stats = ImageStatsCalculator.calculateIntegerStats(data, width, height, channels);
            this._cachedStats = stats;
        }

        if (isGammaMode && !stats) {
            stats = { min: 0, max: 255 };
        }

        const options = {
            rgbAs24BitGrayscale: rgbAs24BitMode,
            typeMax: 255
        };

        return ImageRenderer.render(
            data,
            width,
            height,
            channels,
            false,
            stats,
            settings,
            options
        );
    }

    getColorAtPixel(x, y, naturalWidth, naturalHeight) {
        if (!this._lastRaw) return '';
        const { width, height, data, channels } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';

        const pixelIdx = y * width + x;
        const dataIdx = pixelIdx * 4;
        const settings = this.settingsManager.settings;

        if (dataIdx >= 0 && dataIdx + 3 < data.length) {
            const r = data[dataIdx];
            const g = data[dataIdx + 1];
            const b = data[dataIdx + 2];
            const a = data[dataIdx + 3];

            if (settings.rgbAs24BitGrayscale) {
                const combined24bit = (r << 16) | (g << 8) | b;
                const scaleFactor = settings.scale24BitFactor || 1000;
                const scaledValue = (combined24bit / scaleFactor).toFixed(3);
                return `${scaledValue} α:${(a / 255).toFixed(2)}`;
            }

            return `${r.toString().padStart(3, '0')} ${g.toString().padStart(3, '0')} ${b.toString().padStart(3, '0')} α:${(a / 255).toFixed(2)}`;
        }
        return '';
    }

    _postFormatInfo(width, height, channels, bitDepth, formatLabel, formatType) {
        if (!this.vscode) return;
        this.vscode.postMessage({
            type: 'formatInfo',
            value: {
                width,
                height,
                compression: 'Deflate/Lossy',
                predictor: 1,
                photometricInterpretation: 2,
                planarConfig: 1,
                samplesPerPixel: channels,
                bitsPerSample: bitDepth,
                sampleFormat: 1,
                formatLabel,
                formatType,
                isInitialLoad: this._isInitialLoad
            }
        });
    }

    performDeferredRender() {
        if (!this._pendingRenderData || !this._lastRaw) {
            return null;
        }

        const { data, width, height } = this._pendingRenderData;
        this._pendingRenderData = null;
        this._isInitialLoad = false;

        const imageData = this._renderToImageData(data, width, height, 4, this._lastRaw.originalImageData);
        this.vscode.postMessage({ type: 'refresh-status' });
        return imageData;
    }

    renderWebImageWithSettings() {
        if (!this._lastRaw) return null;
        const { width, height, data } = this._lastRaw;
        return this._renderToImageData(data, width, height, 4, this._lastRaw.originalImageData);
    }
}
