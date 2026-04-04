// @ts-check
"use strict";
import TgaLoader from 'tga-js';
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';

/** @typedef {import('./settings-manager.js').SettingsManager} SettingsManager */
/** @typedef {import('./settings-manager.js').ImageSettings} ImageSettings */
/** @typedef {{postMessage: (msg: any) => any}} VsCodeApi */

/**
 * Targa (TGA) Processor for TIFF Visualizer.
 * Uses tga-js to decode TGA files. tga-js always decodes to 4-channel RGBA
 * regardless of the source bit depth, so we track the original bit depth and
 * whether the source actually has an alpha channel to display correct pixel
 * values and alpha visibility.
 */
export class TgaProcessor {
    /**
     * @param {SettingsManager} settingsManager
     * @param {VsCodeApi} vscode
     */
    constructor(settingsManager, vscode) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        /** @type {{width:number, height:number, data:Uint8ClampedArray, channels:number, bitDepth:number, maxValue:number, originalBitDepth:number, originalIsGrey:boolean, hasAlpha:boolean, originalImageData:ImageData}|null} */
        this._lastRaw = null;
        this._pendingRenderData = null;
        this._isInitialLoad = true;
        /** @type {{min:number,max:number}|undefined} */
        this._cachedStats = undefined;
    }

    /** @param {string} src */
    async processTga(src) {
        try {
            this._cachedStats = undefined;

            const response = await fetch(src);
            const arrayBuffer = await response.arrayBuffer();

            // @ts-ignore
            const tga = new TgaLoader();
            tga.load(new Uint8Array(arrayBuffer));

            const width = tga.header.width;
            const height = tga.header.height;
            const originalBitDepth = tga.header.pixelDepth;
            const originalIsGrey = tga.header.isGreyColor;

            // tga-js always decodes into RGBA ImageData
            const imageData = new ImageData(width, height);
            tga.getImageData(imageData);

            // Determine if the source image actually carries an alpha channel.
            // 32-bit color TGA = RGBA (8 bits per channel).
            // 16-bit grey TGA is grey (8-bit) + alpha (8-bit) by the TGA spec.
            // All other depths do not have a dedicated alpha channel.
            const hasAlpha = (originalBitDepth === 32) || (originalIsGrey && originalBitDepth === 16);

            this._lastRaw = {
                width,
                height,
                data: imageData.data,
                channels: 4, // tga-js always outputs RGBA
                bitDepth: 8,
                maxValue: 255,
                originalBitDepth,
                originalIsGrey,
                hasAlpha,
                originalImageData: imageData
            };

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;

            // Logical channel count for format info (alpha only if actually present)
            const logicalChannels = originalIsGrey ? 1 : (hasAlpha ? 4 : 3);

            if (this._isInitialLoad) {
                this._postFormatInfo(width, height, logicalChannels, originalBitDepth);
                this._pendingRenderData = true;
                return { canvas, imageData: new ImageData(width, height) };
            }

            this._postFormatInfo(width, height, logicalChannels, originalBitDepth);
            const processedImageData = this._renderToImageData();
            if (this.vscode) {
                this.vscode.postMessage({ type: 'refresh-status' });
            }
            return { canvas, imageData: processedImageData };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to process TGA image: ${msg}`);
        }
    }

    _renderToImageData() {
        if (!this._lastRaw) return new ImageData(1, 1);

        const { width, height, data, channels, originalImageData } = this._lastRaw;
        const settings = this.settingsManager.settings;
        const isIdentity = NormalizationHelper.isIdentityTransformation(settings);
        const isGammaMode = settings.normalization?.gammaMode || false;
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
    renderTgaWithSettings() {
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
        const { width, height, data, originalBitDepth, originalIsGrey, hasAlpha } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';

        const pixelIdx = y * width + x;
        const dataIdx = pixelIdx * 4; // tga-js stores RGBA
        const settings = this.settingsManager.settings;

        if (dataIdx < 0 || dataIdx + 3 >= data.length) return '';

        const r = data[dataIdx];
        const g = data[dataIdx + 1];
        const b = data[dataIdx + 2];
        const a = data[dataIdx + 3];

        if (originalIsGrey) {
            // r == g == b == grey value
            if (hasAlpha) {
                return `${r} α:${(a / 255).toFixed(2)}`;
            }
            return r.toString();
        }

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
     * @param {any} settings
     * @returns {{r:number,g:number,b:number}}
     */
    _getNanColor(settings) {
        // TGA is always integer — NaN cannot occur. Kept for interface consistency.
        return settings.nanColor === 'fuchsia' ? { r: 255, g: 0, b: 255 } : { r: 0, g: 0, b: 0 };
    }

    /**
     * @param {number} width
     * @param {number} height
     * @param {number} channels
     * @param {number} bitDepth
     */
    _postFormatInfo(width, height, channels, bitDepth) {
        if (!this.vscode) return;
        this.vscode.postMessage({
            type: 'formatInfo',
            value: {
                width,
                height,
                compression: 'None/RLE',
                predictor: 1,
                photometricInterpretation: channels >= 3 ? 2 : 1,
                planarConfig: 1,
                samplesPerPixel: channels,
                bitsPerSample: bitDepth,
                sampleFormat: 1,
                formatLabel: `TGA (${bitDepth}-bit)`,
                formatType: 'tga',
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
