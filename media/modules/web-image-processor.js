// @ts-check
"use strict";
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';

/** @typedef {import('./settings-manager.js').SettingsManager} SettingsManager */
/** @typedef {import('./settings-manager.js').ImageSettings} ImageSettings */
/** @typedef {{postMessage: (msg: any) => any}} VsCodeApi */

/**
 * Web Image Processor for TIFF Visualizer.
 * Handles native browser formats: WebP, AVIF, BMP, ICO.
 *
 * All formats are decoded via the browser's Image element and canvas.getImageData(),
 * which always returns 4-channel RGBA regardless of the source color space.
 * We scan the alpha channel to detect whether the image actually carries
 * transparency so the pixel inspector only shows α: when meaningful.
 */
export class WebImageProcessor {
    /**
     * @param {SettingsManager} settingsManager
     * @param {VsCodeApi} vscode
     */
    constructor(settingsManager, vscode) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        /** @type {{width:number, height:number, data:Uint8ClampedArray, channels:number, bitDepth:number, maxValue:number, hasAlpha:boolean, originalImageData:ImageData}|null} */
        this._lastRaw = null;
        this._pendingRenderData = null;
        this._isInitialLoad = true;
        /** @type {{min:number,max:number}|undefined} */
        this._cachedStats = undefined;
    }

    /** @param {string} src */
    async processWebImage(src) {
        const lower = src.toLowerCase();
        let formatName = 'WebP';
        let formatType = 'webp';
        if (lower.includes('.avif')) { formatName = 'AVIF'; formatType = 'avif'; }
        else if (lower.includes('.bmp')) { formatName = 'BMP'; formatType = 'bmp'; }
        else if (lower.includes('.ico')) { formatName = 'ICO'; formatType = 'ico'; }

        this._cachedStats = undefined;

        const image = new Image();
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('Could not get canvas context');

        return new Promise((resolve, reject) => {
            image.onload = () => {
                try {
                    canvas.width = image.naturalWidth;
                    canvas.height = image.naturalHeight;
                    ctx.drawImage(image, 0, 0);

                    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const rawData = imageData.data;

                    // Determine whether this image actually uses the alpha channel.
                    // If every alpha byte is 255, the image is opaque RGB — don't show α:.
                    let hasAlpha = false;
                    for (let i = 3; i < rawData.length; i += 4) {
                        if (rawData[i] < 255) { hasAlpha = true; break; }
                    }

                    this._lastRaw = {
                        width: canvas.width,
                        height: canvas.height,
                        data: rawData,
                        channels: 4, // canvas.getImageData always returns RGBA
                        bitDepth: 8,
                        maxValue: 255,
                        hasAlpha,
                        originalImageData: imageData
                    };

                    if (this._isInitialLoad) {
                        this._postFormatInfo(canvas.width, canvas.height, hasAlpha ? 4 : 3, 8, formatName, formatType);
                        this._pendingRenderData = true;
                        resolve({ canvas, imageData: new ImageData(canvas.width, canvas.height) });
                        return;
                    }

                    this._postFormatInfo(canvas.width, canvas.height, hasAlpha ? 4 : 3, 8, formatName, formatType);
                    const processedImageData = this._renderToImageData();
                    if (this.vscode) {
                        this.vscode.postMessage({ type: 'refresh-status' });
                    }
                    resolve({ canvas, imageData: processedImageData });
                } catch (error) {
                    reject(error);
                }
            };

            image.onerror = () => {
                reject(new Error(
                    `Failed to load ${formatName} image. ` +
                    `Check that ${formatName} is supported by your VS Code/Electron version.`
                ));
            };

            image.src = src;
        });
    }

    _renderToImageData() {
        if (!this._lastRaw) return new ImageData(1, 1);
        const { width, height, data, channels, originalImageData } = this._lastRaw;
        const settings = this.settingsManager.settings;
        const isGammaMode = settings.normalization?.gammaMode || false;
        const isIdentity = NormalizationHelper.isIdentityTransformation(settings);
        const rgbAs24BitMode = settings.rgbAs24BitGrayscale && channels >= 3;

        // Zero-copy fast path
        if (originalImageData && isGammaMode && isIdentity && !rgbAs24BitMode) {
            return originalImageData;
        }

        let stats = this._cachedStats;
        if (!stats && !isGammaMode) {
            stats = ImageStatsCalculator.calculateIntegerStats(data, width, height, channels);
            this._cachedStats = stats;
            if (this.vscode) {
                this.vscode.postMessage({ type: 'stats', value: stats });
            }
        }
        if (isGammaMode && !stats) {
            stats = { min: 0, max: 255 };
        }

        return ImageRenderer.render(
            data,
            width,
            height,
            channels,
            false, // isFloat
            stats,
            settings,
            { rgbAs24BitGrayscale: rgbAs24BitMode, typeMax: 255 }
        );
    }

    /** @returns {ImageData|null} */
    renderWebImageWithSettings() {
        if (!this._lastRaw) return null;
        return this._renderToImageData();
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {number} naturalWidth
     * @param {number} naturalHeight
     * @returns {string}
     */
    getColorAtPixel(x, y, naturalWidth, naturalHeight) {
        if (!this._lastRaw) return '';
        const { width, height, data, hasAlpha } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';

        const dataIdx = (y * width + x) * 4;
        if (dataIdx < 0 || dataIdx + 3 >= data.length) return '';

        const r = data[dataIdx];
        const g = data[dataIdx + 1];
        const b = data[dataIdx + 2];
        const a = data[dataIdx + 3];
        const settings = this.settingsManager.settings;

        if (settings.rgbAs24BitGrayscale) {
            const combined24bit = (r << 16) | (g << 8) | b;
            const scaleFactor = settings.scale24BitFactor || 1000;
            const scaledValue = (combined24bit / scaleFactor).toFixed(3);
            if (hasAlpha) {
                return `${scaledValue} α:${(a / 255).toFixed(2)}`;
            }
            return scaledValue;
        }

        if (hasAlpha) {
            return `${r.toString().padStart(3, '0')} ${g.toString().padStart(3, '0')} ${b.toString().padStart(3, '0')} α:${(a / 255).toFixed(2)}`;
        }
        return `${r.toString().padStart(3, '0')} ${g.toString().padStart(3, '0')} ${b.toString().padStart(3, '0')}`;
    }

    /**
     * @param {number} width
     * @param {number} height
     * @param {number} channels
     * @param {number} bitDepth
     * @param {string} formatLabel
     * @param {string} formatType
     */
    _postFormatInfo(width, height, channels, bitDepth, formatLabel, formatType) {
        if (!this.vscode) return;
        this.vscode.postMessage({
            type: 'formatInfo',
            value: {
                width,
                height,
                compression: formatType === 'bmp' ? 'None' : 'Lossy/Lossless',
                predictor: 1,
                photometricInterpretation: channels >= 3 ? 2 : 1,
                planarConfig: 1,
                samplesPerPixel: channels,
                bitsPerSample: bitDepth,
                sampleFormat: 1,
                formatLabel: `${formatLabel} (${bitDepth}-bit)`,
                formatType,
                isInitialLoad: this._isInitialLoad
            }
        });
    }

    /** @returns {ImageData|null} */
    performDeferredRender() {
        if (!this._pendingRenderData || !this._lastRaw) return null;
        this._pendingRenderData = null;
        this._isInitialLoad = false;
        const imageData = this._renderToImageData();
        if (this.vscode) {
            this.vscode.postMessage({ type: 'refresh-status' });
        }
        return imageData;
    }
}
