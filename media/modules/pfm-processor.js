// @ts-check
"use strict";

/**
 * PFM Processor for TIFF Visualizer
 * Supports grayscale (Pf) and RGB (PF) portable float map files
 */
export class PfmProcessor {
    constructor(settingsManager, vscode) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        this._lastRaw = null; // { width, height, data: Float32Array }
    }

    async processPfm(src) {
        const response = await fetch(src);
        const buffer = await response.arrayBuffer();
        const { width, height, channels, data } = this._parsePfm(buffer);
        // For visualization, convert to grayscale if RGB by luminance
        let gray;
        if (channels === 1) {
            gray = data;
        } else {
            gray = new Float32Array(width * height);
            for (let i = 0; i < width * height; i++) {
                const r = data[i * 3 + 0];
                const g = data[i * 3 + 1];
                const b = data[i * 3 + 2];
                gray[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            }
        }
        this._lastRaw = { width, height, data: gray };
        this._postFormatInfo(width, height, channels, 'PFM');
        const imageData = this._toImageDataFloat(gray, width, height);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        // Force status refresh so normalization UI appears immediately
        this.vscode.postMessage({ type: 'refresh-status' });
        return { canvas, imageData };
    }

    _parsePfm(arrayBuffer) {
        const text = new TextDecoder('ascii').decode(arrayBuffer);
        // Read header lines
        const lines = text.split(/\n/);
        let idx = 0;
        while (idx < lines.length && lines[idx].trim() === '') idx++;
        const type = lines[idx++].trim();
        if (type !== 'PF' && type !== 'Pf') throw new Error('Invalid PFM magic');
        // Skip comments
        while (idx < lines.length && lines[idx].trim().startsWith('#')) idx++;
        const dims = lines[idx++].trim().split(/\s+/).map(n => parseInt(n, 10));
        const width = dims[0];
        const height = dims[1];
        const scale = parseFloat(lines[idx++].trim());
        const littleEndian = scale < 0;
        const channels = type === 'PF' ? 3 : 1;
        // Find start byte offset of pixel data
        const headerUpTo = lines.slice(0, idx).join('\n') + '\n';
        const headerBytes = new TextEncoder().encode(headerUpTo).length;
        const bytesPerPixel = 4 * channels;
        const dv = new DataView(arrayBuffer, headerBytes);
        const pixels = width * height;
        const out = new Float32Array(pixels * channels);
        let o = 0;
        for (let i = 0; i < pixels; i++) {
            for (let c = 0; c < channels; c++) {
                const v = dv.getFloat32((i * channels + c) * 4, littleEndian);
                out[o++] = v;
            }
        }
        return { width, height, channels, data: out };
    }

    _toImageDataFloat(data, width, height) {
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < data.length; i++) {
            const v = data[i];
            if (!Number.isFinite(v)) continue;
            if (v < min) min = v;
            if (v > max) max = v;
        }
        const settings = this.settingsManager.settings;
        let normMin, normMax;
        if (settings.normalization && settings.normalization.autoNormalize) {
            normMin = min; normMax = max;
        } else if (settings.normalization && settings.normalization.gammaMode) {
            normMin = 0; normMax = 1;
        } else if (settings.normalization) {
            if (settings.normalization.min === 0 && settings.normalization.max === 1 && (min < 0 || max > 1)) {
                normMin = min; normMax = max;
            } else {
                normMin = settings.normalization.min; normMax = settings.normalization.max;
            }
        } else {
            normMin = min; normMax = max;
        }
        const range = normMax - normMin || 1;
        const out = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < width * height; i++) {
            let n = (data[i] - normMin) / range;
            n = Math.max(0, Math.min(1, n));
            if (settings.normalization && settings.normalization.gammaMode) {
                const gi = settings.gamma?.in ?? 1.0;
                const go = settings.gamma?.out ?? 1.0;
                n = Math.pow(n, gi / go);
                const stops = settings.brightness?.offset ?? 0;
                n = n * Math.pow(2, stops);
                n = Math.max(0, Math.min(1, n));
            }
            const v = Math.round(n * 255);
            const p = i * 4;
            out[p] = v; out[p + 1] = v; out[p + 2] = v; out[p + 3] = 255;
        }
        if (this.vscode) {
            this.vscode.postMessage({ type: 'isFloat', value: true });
            this.vscode.postMessage({ type: 'stats', value: { min, max } });
        }
        return new ImageData(out, width, height);
    }

    getColorAtPixel(x, y, naturalWidth, naturalHeight) {
        if (!this._lastRaw) return '';
        const { width, height, data } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';
        const idx = y * width + x;
        const value = data[idx];
        if (Number.isFinite(value)) {
            return value.toPrecision(4);
        }
        return '';
    }

    _postFormatInfo(width, height, channels, formatLabel) {
        if (!this.vscode) return;
        this.vscode.postMessage({
            type: 'formatInfo',
            value: {
                width,
                height,
                compression: '1',
                predictor: 3,
                photometricInterpretation: channels === 3 ? 2 : 1,
                planarConfig: 1,
                samplesPerPixel: channels,
                bitsPerSample: 32,
                sampleFormat: 3,
                formatLabel
            }
        });
    }
}


