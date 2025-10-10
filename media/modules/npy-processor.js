// @ts-check
"use strict";

/**
 * NPY/NPZ Processor for TIFF Visualizer
 * Parses NumPy .npy and .npz files and renders them to ImageData
 */
export class NpyProcessor {
    constructor(settingsManager, vscode) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        this._lastRaw = null; // { width, height, data: Float32Array }
    }

    async processNpy(src) {
        const response = await fetch(src);
        const buffer = await response.arrayBuffer();
        const view = new DataView(buffer);

        // NPZ (ZIP) signature 0x04034b50
        if (buffer.byteLength >= 4 && view.getUint32(0, true) === 0x04034b50) {
            const { data, width, height } = this._parseNpz(buffer);
            this._lastRaw = { width, height, data };
            this._postFormatInfo(width, height, 'NPY');
            const imageData = this._toImageDataFloat(data, width, height);
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            // Force status refresh so normalization UI appears immediately
            this.vscode.postMessage({ type: 'refresh-status' });
            return { canvas, imageData };
        }

        const { data, width, height } = this._parseNpy(buffer);
        this._lastRaw = { width, height, data };
        this._postFormatInfo(width, height, 'NPY');
        const imageData = this._toImageDataFloat(data, width, height);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        // Force status refresh so normalization UI appears immediately
        this.vscode.postMessage({ type: 'refresh-status' });
        return { canvas, imageData };
    }

    _parseNpy(arrayBuffer) {
        const view = new DataView(arrayBuffer);
        // Magic '\x93NUMPY'
        const magic = new Uint8Array(arrayBuffer, 0, 6);
        const expected = [0x93, 0x4E, 0x55, 0x4D, 0x50, 0x59];
        for (let i = 0; i < 6; i++) {
            if (magic[i] !== expected[i]) {
                throw new Error('Invalid NPY file');
            }
        }
        const major = view.getUint8(6);
        const minor = view.getUint8(7);
        if (major !== 1 && major !== 2) {
            throw new Error(`Unsupported NPY version ${major}.${minor}`);
        }
        const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
        const headerStart = major === 1 ? 10 : 12;
        const headerBytes = new Uint8Array(arrayBuffer, headerStart, headerLen);
        const header = new TextDecoder('latin1').decode(headerBytes);
        const shapeMatch = header.match(/'shape':\s*\(([^)]+)\)/);
        if (!shapeMatch) throw new Error('NPY missing shape');
        const dims = shapeMatch[1].split(',').map(s => s.trim()).filter(Boolean).map(s => parseInt(s, 10));
        const dtypeMatch = header.match(/'descr':\s*'([^']+)'/);
        if (!dtypeMatch) throw new Error('NPY missing dtype');
        const dtype = dtypeMatch[1];
        let height, width, channels = 1;
        if (dims.length === 2) {
            height = dims[0];
            width = dims[1];
        } else if (dims.length === 3) {
            height = dims[0];
            width = dims[1];
            channels = dims[2];
        } else {
            throw new Error(`Unsupported NPY dims ${dims.length}`);
        }
        const elems = width * height * channels;
        const off = headerStart + headerLen;
        let raw;
        if (dtype === '<f4' || dtype === '=f4') {
            raw = new Float32Array(arrayBuffer, off, elems);
        } else if (dtype === '>f4') {
            const bytes = new Uint8Array(arrayBuffer, off, elems * 4);
            raw = new Float32Array(elems);
            for (let i = 0; i < elems; i++) {
                const j = i * 4;
                const b0 = bytes[j + 3];
                const b1 = bytes[j + 2];
                const b2 = bytes[j + 1];
                const b3 = bytes[j + 0];
                raw[i] = new Float32Array(new Uint8Array([b0, b1, b2, b3]).buffer)[0];
            }
        } else if (dtype.endsWith('f8')) {
            const src = new Float64Array(arrayBuffer, off, elems);
            raw = new Float32Array(elems);
            for (let i = 0; i < elems; i++) raw[i] = src[i];
        } else {
            // Fallback for integers
            const bytes = parseInt(dtype.slice(-1), 10);
            const little = dtype.startsWith('<') || dtype.startsWith('=');
            const dv = new DataView(arrayBuffer, off);
            raw = new Float32Array(elems);
            for (let i = 0; i < elems; i++) {
                const p = i * bytes;
                let v = 0;
                if (bytes === 1) v = dtype.includes('u') ? dv.getUint8(p) : dv.getInt8(p);
                else if (bytes === 2) v = dtype.includes('u') ? dv.getUint16(p, little) : dv.getInt16(p, little);
                else if (bytes === 4) v = dtype.includes('u') ? dv.getUint32(p, little) : dv.getInt32(p, little);
                else v = Number(dtype.includes('u') ? dv.getBigUint64(p, little) : dv.getBigInt64(p, little));
                raw[i] = v;
            }
        }
        let data;
        if (channels === 1) {
            data = raw;
        } else {
            data = new Float32Array(width * height);
            for (let i = 0; i < width * height; i++) data[i] = raw[i * channels + 0];
        }
        return { data, width, height };
    }

    _parseNpz(arrayBuffer) {
        const view = new DataView(arrayBuffer);
        let offset = 0;
        const arrays = {};
        while (offset < arrayBuffer.byteLength - 4) {
            const sig = view.getUint32(offset, true);
            if (sig !== 0x04034b50) { offset++; continue; }
            const comp = view.getUint16(offset + 8, true);
            const nameLen = view.getUint16(offset + 26, true);
            const extraLen = view.getUint16(offset + 28, true);
            const compSize = view.getUint32(offset + 18, true);
            const fileName = new TextDecoder().decode(new Uint8Array(arrayBuffer, offset + 30, nameLen));
            const dataOffset = offset + 30 + nameLen + extraLen;
            if (fileName.endsWith('.npy') && comp === 0) {
                const slice = arrayBuffer.slice(dataOffset, dataOffset + compSize);
                const { data, width, height } = this._parseNpy(slice);
                arrays[fileName.replace('.npy', '')] = { data, width, height };
            }
            offset = dataOffset + compSize;
        }
        // Choose best candidate
        const keys = Object.keys(arrays);
        if (keys.length === 0) throw new Error('NPZ contains no uncompressed .npy arrays');
        let pick = keys.find(k => /depth|dispar|inv|z|range/i.test(k));
        if (!pick) pick = keys[0];
        const a = arrays[pick];
        return { data: a.data, width: a.width, height: a.height };
    }

    _toImageDataFloat(data, width, height) {
        // Compute min/max for normalization
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
            normMin = settings.normalization.min; normMax = settings.normalization.max;
        } else {
            normMin = min; normMax = max;
        }
        const range = normMax - normMin || 1;
        const out = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < width * height; i++) {
            let n = (data[i] - normMin) / range;
            n = Math.max(0, Math.min(1, n));
            // Correct order: remove input gamma → apply brightness → apply output gamma
            if (settings.normalization && settings.normalization.gammaMode) {
                const gammaIn = settings.gamma?.in ?? 1.0;
                const gammaOut = settings.gamma?.out ?? 1.0;
                const exposureStops = settings.brightness?.offset ?? 0;

                // Step 1: Remove input gamma (linearize) - raise to gammaIn power
                n = Math.pow(n, gammaIn);

                // Step 2: Apply brightness in linear space
                n = n * Math.pow(2, exposureStops);

                // Step 3: Apply output gamma - raise to 1/gammaOut power
                n = Math.pow(n, 1.0 / gammaOut);

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

    _postFormatInfo(width, height, formatLabel) {
        if (!this.vscode) return;
        this.vscode.postMessage({
            type: 'formatInfo',
            value: {
                width,
                height,
                compression: '1',
                predictor: 3,
                photometricInterpretation: undefined,
                planarConfig: 1,
                samplesPerPixel: 1,
                bitsPerSample: 32,
                sampleFormat: 3,
                formatLabel,
                formatType: 'npy' // For per-format settings
            }
        });
    }
}


