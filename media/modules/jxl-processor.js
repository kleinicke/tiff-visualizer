// @ts-check
"use strict";

import decode, { init as initJXLDecode } from '@jsquash/jxl/decode';
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';

/**
 * JPEG XL (JXL) Processor for TIFF Visualizer
 */
export class JxlProcessor {
    constructor(settingsManager, vscode) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        this._lastRaw = null;
        this._pendingRenderData = null;
        this._isInitialLoad = true;
        this._cachedStats = undefined;
        this._isWasmLoaded = false;
    }

    async ensureWasmLoaded(baseUri) {
        if (!this._isWasmLoaded) {
            const wasmUrl = `${baseUri}/wasm/jxl_dec.wasm`;
            const wasmResponse = await fetch(wasmUrl);
            const wasmBuffer = await wasmResponse.arrayBuffer();
            await initJXLDecode(wasmBuffer);
            this._isWasmLoaded = true;
        }
    }

    async processJxl(src, baseUri) {
        try {
            this._cachedStats = undefined;
            await this.ensureWasmLoaded(baseUri);

            const response = await fetch(src);
            const arrayBuffer = await response.arrayBuffer();

            // Decode returns an ImageData object with RGB values
            const decoded = await decode(arrayBuffer);

            const width = decoded.width;
            const height = decoded.height;
            const channels = 4; // jxl returns standard ImageData which is RGBA

            this._lastRaw = {
                width: width,
                height: height,
                data: decoded.data,
                channels: channels,
                bitDepth: 8, // jSquash/jxl decodes standard 8-bit SDR limits
                maxValue: 255,
                originalImageData: decoded
            };

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;

            if (this._isInitialLoad) {
                this._postFormatInfo(width, height, channels, 8);
                this._pendingRenderData = true;
                const placeholderImageData = new ImageData(width, height);
                return { canvas, imageData: placeholderImageData };
            }

            this._postFormatInfo(width, height, channels, 8);
            const processedImageData = this._renderToImageData();
            
            if (this.vscode) {
                this.vscode.postMessage({ type: 'refresh-status' });
            }
            return { canvas, imageData: processedImageData };
        } catch (error) {
            console.error('JXL processing failed:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to process JXL image: ${errorMessage}`);
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

    renderJxlWithSettings() {
        if (!this._lastRaw) return null;
        return this._renderToImageData();
    }

    getColorAtPixel(x, y, naturalWidth, naturalHeight) {
        if (!this._lastRaw) return '';
        const { width, height, data } = this._lastRaw;
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
                return scaledValue; // usually these are full alpha SDR
            }

            return `${r.toString().padStart(3, '0')} ${g.toString().padStart(3, '0')} ${b.toString().padStart(3, '0')} α:${(a / 255).toFixed(2)}`;
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
                compression: 'Brotli/JXL', // Actually jxl has its own
                predictor: 1,
                photometricInterpretation: channels >= 3 ? 2 : 1,
                planarConfig: 1,
                samplesPerPixel: channels,
                bitsPerSample: bitDepth,
                sampleFormat: 1,
                formatLabel: `JXL (${bitDepth}-bit SDR)`,
                formatType: 'jxl',
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
