"use strict";

import decode, { init as initJXLDecode } from '@jsquash/jxl/decode';
import { NormalizationHelper, ImageRenderer, ImageStatsCalculator } from './normalization-helper.js';
import type { SettingsManager, ImageSettings } from './settings-manager.js';
import type { Stats } from './types.js';

type VsCodeApi = { postMessage: (msg: any) => any };

/**
 * JPEG XL (JXL) Processor for TIFF Visualizer.
 * Uses @jsquash/jxl to decode .jxl files via WASM.
 * Decoded output is always 4-channel RGBA (8-bit SDR).
 */
export class JxlProcessor {
    settingsManager: SettingsManager;
    vscode: VsCodeApi;
    _lastRaw: {
        width: number;
        height: number;
        data: Uint8ClampedArray;
        channels: number;
        bitDepth: number;
        maxValue: number;
        hasAlpha: boolean;
        originalImageData: ImageData;
    } | null;
    _pendingRenderData: boolean | null;
    _isInitialLoad: boolean;
    _cachedStats: Stats | undefined;
    _isWasmLoaded: boolean;
    loadSignal: AbortSignal | undefined;

    constructor(settingsManager: SettingsManager, vscode: VsCodeApi) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        this._lastRaw = null;
        this._pendingRenderData = null;
        this._isInitialLoad = true;
        this._cachedStats = undefined;
        this._isWasmLoaded = false;
        this.loadSignal = undefined; // Set before each load; aborts the fetch when a newer image switch supersedes it
    }

    async ensureWasmLoaded() {
        if (this._isWasmLoaded) return;

        const configuredWasm = this.settingsManager?.settings?.jxlWasmSrc;

        const wasmCandidates = [
            configuredWasm,
            // Relative to the bundle file (media/imagePreview.bundle.js → media/wasm/jxl_dec.wasm)
            new URL('./wasm/jxl_dec.wasm', import.meta.url).href,
            new URL('../wasm/jxl_dec.wasm', import.meta.url).href,
        ].filter(Boolean);

        let lastError: unknown = null;
        for (const wasmUrl of wasmCandidates) {
            try {
                const wasmResponse = await fetch(wasmUrl as string);
                if (!wasmResponse.ok) throw new Error(`HTTP ${wasmResponse.status}`);
                const wasmBuffer = await wasmResponse.arrayBuffer();
                const wasmModule = await WebAssembly.compile(wasmBuffer);
                await initJXLDecode(wasmModule);
                this._isWasmLoaded = true;
                return;
            } catch (error) {
                lastError = error;
            }
        }

        const details = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(`Unable to initialize JXL decoder WASM (${details})`);
    }

    async processJxl(src: string) {
        const loadSignal = this.loadSignal;
        this._cachedStats = undefined;
        await this.ensureWasmLoaded();

        const response = await fetch(src, { signal: loadSignal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        if (loadSignal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }

        // @jsquash/jxl decode returns a standard ImageData (RGBA, 8-bit)
        const decoded = await decode(arrayBuffer);
        if (loadSignal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }

        const width = decoded.width;
        const height = decoded.height;
        const rawData = decoded.data;

        // Determine if the image actually uses the alpha channel
        let hasAlpha = false;
        for (let i = 3; i < rawData.length; i += 4) {
            if (rawData[i] < 255) { hasAlpha = true; break; }
        }

        this._lastRaw = {
            width,
            height,
            data: rawData,
            channels: 4, // jxl decode always returns RGBA
            bitDepth: 8,
            maxValue: 255,
            hasAlpha,
            originalImageData: decoded
        };

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const logicalChannels = hasAlpha ? 4 : 3;

        if (this._isInitialLoad) {
            this._postFormatInfo(width, height, logicalChannels, 8);
            this._pendingRenderData = true;
            return { canvas, imageData: new ImageData(width, height) };
        }

        this._postFormatInfo(width, height, logicalChannels, 8);
        const processedImageData = this._renderToImageData();
        if (this.vscode) {
            this.vscode.postMessage({ type: 'refresh-status' });
        }
        return { canvas, imageData: processedImageData };
    }

    _renderToImageData(): ImageData {
        if (!this._lastRaw) return new ImageData(1, 1);

        const { width, height, data, channels, originalImageData } = this._lastRaw;
        const settings = this.settingsManager.settings;
        const isGammaMode = settings.normalization?.gammaMode || false;
        const isIdentity = NormalizationHelper.isIdentityTransformation(settings);
        const rgbAs24BitMode = settings.rgbAs24BitGrayscale && channels >= 3;

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
            false,
            stats,
            settings,
            { rgbAs24BitGrayscale: rgbAs24BitMode, typeMax: 255 }
        );
    }

    renderJxlWithSettings(): ImageData | null {
        if (!this._lastRaw) return null;
        return this._renderToImageData();
    }

    getColorAtPixel(x: number, y: number, naturalWidth: number, naturalHeight: number): string {
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
            if (hasAlpha) return `${scaledValue} α:${(a / 255).toFixed(2)}`;
            return scaledValue;
        }

        if (hasAlpha) {
            return `${r.toString().padStart(3, '0')} ${g.toString().padStart(3, '0')} ${b.toString().padStart(3, '0')} α:${(a / 255).toFixed(2)}`;
        }
        return `${r.toString().padStart(3, '0')} ${g.toString().padStart(3, '0')} ${b.toString().padStart(3, '0')}`;
    }

    _postFormatInfo(width: number, height: number, channels: number, bitDepth: number) {
        if (!this.vscode) return;
        this.vscode.postMessage({
            type: 'formatInfo',
            value: {
                width,
                height,
                compression: 'JXL',
                predictor: 1,
                photometricInterpretation: channels >= 3 ? 2 : 1,
                planarConfig: 1,
                samplesPerPixel: channels,
                bitsPerSample: bitDepth,
                sampleFormat: 1,
                formatLabel: `JXL (internally converted to 8-bit by decoder, no matter the input`,
                formatType: 'jxl',
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
