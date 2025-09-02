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
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

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
                        data: rawData, // Keep full RGBA data
                        channels: hasAlpha ? 4 : 3 
                    };
                    
                    // Determine format based on file extension
                    const format = src.toLowerCase().includes('.png') ? 'PNG' : 
                                  src.toLowerCase().includes('.jpg') || src.toLowerCase().includes('.jpeg') ? 'JPEG' : 
                                  'Image';
                    
                    this._postFormatInfo(canvas.width, canvas.height, this._lastRaw.channels, format);
                    
                    // Apply gamma correction if enabled
                    const finalImageData = this._toImageDataWithGamma(rawData, canvas.width, canvas.height);
                    
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
        
        // data is RGBA format [R,G,B,A,R,G,B,A,...]
        for (let i = 0; i < width * height; i++) {
            const srcIdx = i * 4;
            let r = data[srcIdx + 0];
            let g = data[srcIdx + 1];
            let b = data[srcIdx + 2];
            const a = data[srcIdx + 3];
            
            // Apply gamma and brightness corrections to each channel
            if (settings.gamma || settings.brightness) {
                // Process each color channel
                for (let channel = 0; channel < 3; channel++) {
                    let channelValue = channel === 0 ? r : channel === 1 ? g : b;
                    
                    // Normalize to 0-1 range
                    let normalizedValue = channelValue / 255;
                    
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
                    const correctedValue = Math.round(normalizedValue * 255);
                    
                    // Update the channel value
                    if (channel === 0) r = correctedValue;
                    else if (channel === 1) g = correctedValue;
                    else b = correctedValue;
                }
            }
            
            const outIdx = i * 4;
            out[outIdx + 0] = r;
            out[outIdx + 1] = g;
            out[outIdx + 2] = b;
            out[outIdx + 3] = a;
        }

        // Send stats to VS Code (calculate from all RGB values)
        if (this.vscode) {
            let min = Infinity, max = -Infinity;
            for (let i = 0; i < width * height; i++) {
                const srcIdx = i * 4;
                // Check RGB channels (skip alpha)
                for (let c = 0; c < 3; c++) {
                    const value = data[srcIdx + c];
                    if (value < min) min = value;
                    if (value > max) max = value;
                }
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
        
        const pixelIdx = y * width + x;
        const dataIdx = pixelIdx * 4; // RGBA format
        
        if (dataIdx >= 0 && dataIdx < data.length - 3) {
            const r = data[dataIdx + 0];
            const g = data[dataIdx + 1];
            const b = data[dataIdx + 2];
            const a = data[dataIdx + 3];
            
            // Return RGB values in the same format as other processors
            if (a < 255) {
                // For transparency, show the alpha value
                return `${r.toString().padStart(3, '0')} ${g.toString().padStart(3, '0')} ${b.toString().padStart(3, '0')} α:${(a/255).toFixed(2)}`;
            } else {
                // Standard RGB format matching other processors
                return `${r.toString().padStart(3, '0')} ${g.toString().padStart(3, '0')} ${b.toString().padStart(3, '0')}`;
            }
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