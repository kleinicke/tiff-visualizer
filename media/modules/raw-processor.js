// @ts-check
"use strict";

import LibRaw from 'libraw-wasm';
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';

export class RawProcessor {
    constructor(settingsManager, vscode) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        this._lastRaw = null;
        this._pendingRenderData = null;
        this._isInitialLoad = true;
        this._cachedStats = undefined;
        this._libRaw = null;
    }

    async ensureWasmLoaded(baseUri) {
        if (!this._libRaw) {
            // Need a worker? We'll load the LibRaw instance without a worker if possible,
            // or we just instantiate it. `libraw-wasm` automatically resolves to 'dist/' mostly.
            // We just use it directly, knowing that `libraw-wasm` worker.js needs to be fetchable.
            this._libRaw = new LibRaw();
        }
    }

    async processRaw(src, baseUri) {
        try {
            this._cachedStats = undefined;
            await this.ensureWasmLoaded(baseUri);

            const response = await fetch(src);
            const arrayBuffer = await response.arrayBuffer();

            // libraw-wasm open API
            // using default settings
            const settings = {};
            await this._libRaw.open(new Uint8Array(arrayBuffer), settings);

            const meta = await this._libRaw.metadata();
            const width = meta.width;
            const height = meta.height;
            // fetch RGB or RGBA array from libraw
            const rawImageData = await this._libRaw.imageData();
            const channels = Math.round(rawImageData.length / (width * height));

            this._lastRaw = {
                width: width,
                height: height,
                data: rawImageData,
                channels: channels,
                bitDepth: 8, // mostly standard 8-bit SDR output from imageData()
                maxValue: 255
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
            console.error('RAW processing failed:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to process RAW image: ${errorMessage}`);
        }
    }

    _renderToImageData() {
        if (!this._lastRaw) return new ImageData(1, 1);

        const { width, height, data, channels } = this._lastRaw;
        const settings = this.settingsManager.settings;
        const isFloat = false;

        const isIdentity = NormalizationHelper.isIdentityTransformation(settings);
        const isGammaMode = settings.normalization?.gammaMode || false;
        const rgbAs24BitMode = settings.rgbAs24BitGrayscale && channels >= 3;

        // Fast path for identity settings
        if (isGammaMode && isIdentity && !rgbAs24BitMode) {
            const clampedData = new Uint8ClampedArray(data.buffer || data);
            return new ImageData(clampedData, width, height);
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

    renderRawWithSettings() {
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
                return scaledValue;
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
                compression: 'Camera RAW',
                predictor: 1,
                photometricInterpretation: channels >= 3 ? 2 : 1,
                planarConfig: 1,
                samplesPerPixel: channels,
                bitsPerSample: bitDepth,
                sampleFormat: 1,
                formatLabel: `RAW (${bitDepth}-bit)`,
                formatType: 'raw',
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
