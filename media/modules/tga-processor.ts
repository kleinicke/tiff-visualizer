"use strict";
import TgaLoader from 'tga-js';
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';
import type { SettingsManager, ImageSettings } from './settings-manager.js';
import type { Stats } from './types.js';

type VsCodeApi = { postMessage: (msg: any) => any };

/**
 * Targa (TGA) Processor for TIFF Visualizer.
 * Uses tga-js to decode TGA files. tga-js always decodes to 4-channel RGBA
 * regardless of the source bit depth, so we track the original bit depth and
 * whether the source actually has an alpha channel to display correct pixel
 * values and alpha visibility.
 */
export class TgaProcessor {
    settingsManager: SettingsManager;
    vscode: VsCodeApi;
    _lastRaw: {
        width: number;
        height: number;
        data: Uint8ClampedArray;
        channels: number;
        bitDepth: number;
        maxValue: number;
        originalBitDepth: number;
        originalIsGrey: boolean;
        hasAlpha: boolean;
        originalImageData: ImageData;
    } | null;
    _pendingRenderData: boolean | null;
    _isInitialLoad: boolean;
    _cachedStats: Stats | undefined;
    loadSignal: AbortSignal | undefined;

    constructor(settingsManager: SettingsManager, vscode: VsCodeApi) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        this._lastRaw = null;
        this._pendingRenderData = null;
        this._isInitialLoad = true;
        this._cachedStats = undefined;
        this.loadSignal = undefined; // Set before each load; aborts the fetch when a newer image switch supersedes it
    }

    async processTga(src: string) {
        const loadSignal = this.loadSignal;
        try {
            this._cachedStats = undefined;

            const response = await fetch(src, { signal: loadSignal });
            const arrayBuffer = await response.arrayBuffer();
            if (loadSignal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }

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

    _renderToImageData(): ImageData {
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

    renderTgaWithSettings(): ImageData | null {
        if (!this._lastRaw) return null;
        return this._renderToImageData();
    }

    getColorAtPixel(x: number, y: number, naturalWidth: number, naturalHeight: number): string {
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

    _getNanColor(settings: ImageSettings): { r: number; g: number; b: number } {
        // TGA is always integer — NaN cannot occur. Kept for interface consistency.
        return settings.nanColor === 'fuchsia' ? { r: 255, g: 0, b: 255 } : { r: 0, g: 0, b: 0 };
    }

    _postFormatInfo(width: number, height: number, channels: number, bitDepth: number) {
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

    performDeferredRender(): ImageData | null {
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
