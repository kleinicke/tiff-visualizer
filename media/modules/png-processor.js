// @ts-check
"use strict";

/**
 * PNG Processor for TIFF Visualizer
 * Supports PNG and JPEG files with gamma correction and pixel inspection
 */
export class PngProcessor {
    constructor(settingsManager, vscode) {
        this.settingsManager = settingsManager;
        this.vscode = vscode;
        this._lastRaw = null; // { width, height, data: Uint8ClampedArray, channels }
    }

    async processPng(src) {
        // Load the image to get pixel data
        const image = new Image();
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        if (!ctx) {
            throw new Error('Could not get canvas context');
        }

        return new Promise((resolve, reject) => {
            image.onload = () => {
                try {
                    canvas.width = image.naturalWidth;
                    canvas.height = image.naturalHeight;
                    
                    // Draw the image to canvas to extract pixel data
                    ctx.drawImage(image, 0, 0);
                    
                    // Get the raw pixel data
                    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const rawData = imageData.data; // Uint8ClampedArray [R,G,B,A,R,G,B,A,...]
                    
                    // Convert to grayscale for display consistency with other processors
                    const pixelCount = canvas.width * canvas.height;
                    const grayscaleData = new Uint8ClampedArray(pixelCount);
                    
                    for (let i = 0; i < pixelCount; i++) {
                        const r = rawData[i * 4 + 0];
                        const g = rawData[i * 4 + 1];
                        const b = rawData[i * 4 + 2];
                        // Standard luminance formula
                        grayscaleData[i] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
                    }
                    
                    // Determine if image has alpha channel
                    let hasAlpha = false;
                    for (let i = 3; i < rawData.length; i += 4) {
                        if (rawData[i] < 255) {
                            hasAlpha = true;
                            break;
                        }
                    }
                    
                    this._lastRaw = { 
                        width: canvas.width, 
                        height: canvas.height, 
                        data: grayscaleData, 
                        channels: hasAlpha ? 4 : 3 
                    };
                    
                    // Determine format based on file extension
                    const format = src.toLowerCase().includes('.png') ? 'PNG' : 
                                  src.toLowerCase().includes('.jpg') || src.toLowerCase().includes('.jpeg') ? 'JPEG' : 
                                  'Image';
                    
                    this._postFormatInfo(canvas.width, canvas.height, this._lastRaw.channels, format);
                    
                    // Apply gamma correction if enabled
                    const finalImageData = this._toImageDataWithGamma(grayscaleData, canvas.width, canvas.height);
                    
                    // Force status refresh
                    this.vscode.postMessage({ type: 'refresh-status' });
                    
                    resolve({ canvas, imageData: finalImageData });
                } catch (error) {
                    reject(error);
                }
            };
            
            image.onerror = () => {
                reject(new Error('Failed to load image'));
            };
            
            image.src = src;
        });
    }

    _toImageDataWithGamma(data, width, height) {
        const settings = this.settingsManager.settings;
        const out = new Uint8ClampedArray(width * height * 4);
        
        for (let i = 0; i < width * height; i++) {
            let pixelValue = data[i];
            
            // Apply gamma and brightness corrections
            if (settings.gamma || settings.brightness) {
                // Normalize to 0-1 range
                let normalizedValue = pixelValue / 255;
                
                // Apply gamma correction
                if (settings.gamma) {
                    const gi = settings.gamma.in ?? 1.0;
                    const go = settings.gamma.out ?? 1.0;
                    normalizedValue = Math.pow(normalizedValue, gi / go);
                }
                
                // Apply brightness adjustment
                if (settings.brightness) {
                    const stops = settings.brightness.offset ?? 0;
                    normalizedValue = normalizedValue * Math.pow(2, stops);
                }
                
                // Clamp and convert back to 0-255
                normalizedValue = Math.max(0, Math.min(1, normalizedValue));
                pixelValue = Math.round(normalizedValue * 255);
            }
            
            const p = i * 4;
            out[p] = pixelValue;     // R
            out[p + 1] = pixelValue; // G
            out[p + 2] = pixelValue; // B
            out[p + 3] = 255;        // A
        }

        // Send stats to VS Code
        if (this.vscode) {
            let min = Infinity, max = -Infinity;
            for (let i = 0; i < data.length; i++) {
                const value = data[i];
                if (value < min) min = value;
                if (value > max) max = value;
            }
            // Mark as non-float but enable basic gamma controls
            this.vscode.postMessage({ type: 'isFloat', value: false });
            this.vscode.postMessage({ type: 'stats', value: { min, max } });
        }

        return new ImageData(out, width, height);
    }

    /**
     * Re-render PNG with current settings (for real-time updates)
     */
    renderPngWithSettings() {
        if (!this._lastRaw) return null;
        const { width, height, data } = this._lastRaw;
        return this._toImageDataWithGamma(data, width, height);
    }

    getColorAtPixel(x, y, naturalWidth, naturalHeight) {
        if (!this._lastRaw) return '';
        const { width, height, data } = this._lastRaw;
        if (width !== naturalWidth || height !== naturalHeight) return '';
        
        const idx = y * width + x;
        if (idx >= 0 && idx < data.length) {
            return data[idx].toString();
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
                compression: formatLabel === 'PNG' ? 'Deflate' : 'JPEG',
                predictor: 1,
                photometricInterpretation: channels === 4 ? 2 : channels === 3 ? 2 : 1,
                planarConfig: 1,
                samplesPerPixel: channels,
                bitsPerSample: 8,
                sampleFormat: 1, // Unsigned integer
                formatLabel
            }
        });
    }
}