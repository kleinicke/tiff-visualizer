// @ts-check
"use strict";
import TgaLoader from 'tga-js';
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';

/**
 * Targa (TGA) Processor for TIFF Visualizer
 * Uses tga-js to decode TGA files
 */
export class TgaProcessor {
    constructor(settingsManager, vscode) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        this._lastRaw = null;
        this._pendingRenderData = null;
        this._isInitialLoad = true;
        this._cachedStats = undefined;
    }

    async processTga(src) {
        try {
            this._cachedStats = undefined;

            const response = await fetch(src);
            const arrayBuffer = await response.arrayBuffer();

            const tga = new TgaLoader();
            tga.load(new Uint8Array(arrayBuffer));

            const width = tga.header.width;
            const height = tga.header.height;
            const bitDepth = tga.header.pixelDepth;
            const isGrey = tga.header.isGreyColor;

            // tga.js decodes into a standard 4-channel RGBA array
            const imageData = new ImageData(width, height);
            tga.getImageData(imageData);

            // Representing true channels based on bitDepth, but data is padded to 4 channels by tga-js.
            // Pixel inspector works seamlessly if we declare it as 4 channels, because data is RGBA interleaved.
            this._lastRaw = {
                width: width,
                height: height,
                data: imageData.data,
                channels: 4,
                bitDepth: 8, // The decoded data bounds are 0-255 per channel
                maxValue: 255,
                originalImageData: imageData,
                originalBitDepth: bitDepth,
                originalIsGrey: isGrey
            };

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;

            if (this._isInitialLoad) {
                this._postFormatInfo(width, height, isGrey ? 1 : (bitDepth === 32 ? 4 : 3), bitDepth);
                this._pendingRenderData = true;
                const placeholderImageData = new ImageData(width, height);
                return { canvas, imageData: placeholderImageData };
            }

            this._postFormatInfo(width, height, isGrey ? 1 : (bitDepth === 32 ? 4 : 3), bitDepth);
            const processedImageData = this._renderToImageData();
            
            if (this.vscode) {
                this.vscode.postMessage({ type: 'refresh-status' });
            }
            return { canvas, imageData: processedImageData };
        } catch (error) {
            console.error('TGA processing failed:', error);
            throw new Error(`Failed to process TGA image: ${error.message}`);
        }
    }

    _renderToImageData() {
        if (!this._lastRaw) return new ImageData(1, 1);

        const { width, height, data, channels, originalImageData } = this._lastRaw;
        const settings = this.settingsManager.settings;
        const isFloat = false;

        const isIdentity = NormalizationHelper.isIdentityTransformation(settings);
        const isGammaMode = settings.normalization?.gammaMode || false;
        const rgbAs24BitMode = settings.rgbAs24BitGrayscale && channels >= 3;

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
            isFloat,
            stats,
            settings,
            options
        );
    }

    renderTgaWithSettings() {
        if (!this._lastRaw) return null;
        return this._renderToImageData();
    }

    getColorAtPixel(x, y, naturalWidth, naturalHeight) {
        if (!this._lastRaw) return '';
        const { width, height, data, originalBitDepth, originalIsGrey } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';

        const pixelIdx = y * width + x;
        const dataIdx = pixelIdx * 4;
        const settings = this.settingsManager.settings;

        if (dataIdx >= 0 && dataIdx + 3 < data.length) {
            const r = data[dataIdx];
            const g = data[dataIdx + 1];
            const b = data[dataIdx + 2];
            const a = data[dataIdx + 3];

            if (originalIsGrey) {
                return originalBitDepth === 8 ? r.toString() : `${r} α:${(a / 255).toFixed(2)}`;
            }

            if (settings.rgbAs24BitGrayscale) {
                const combined24bit = (r << 16) | (g << 8) | b;
                const scaleFactor = settings.scale24BitFactor || 1000;
                const scaledValue = (combined24bit / scaleFactor).toFixed(3);
                return originalBitDepth === 32 ? `${scaledValue} α:${(a / 255).toFixed(2)}` : scaledValue;
            }

            if (originalBitDepth === 32) {
                return `${r.toString().padStart(3, '0')} ${g.toString().padStart(3, '0')} ${b.toString().padStart(3, '0')} α:${(a / 255).toFixed(2)}`;
            } else {
                return `${r.toString().padStart(3, '0')} ${g.toString().padStart(3, '0')} ${b.toString().padStart(3, '0')}`;
            }
        }
        return '';
    }

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

    performDeferredRender() {
        if (!this._pendingRenderData || !this._lastRaw) {
            return null;
        }

        this._pendingRenderData = null;
        this._isInitialLoad = false;

        const imageData = this._renderToImageData();
        this.vscode.postMessage({ type: 'refresh-status' });

        return imageData;
    }
}
