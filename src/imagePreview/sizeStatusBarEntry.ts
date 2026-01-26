import * as vscode from 'vscode';
import { PreviewStatusBarEntry } from '../ownedStatusBarEntry';

interface FormatInfo {
	compression?: string;
	predictor?: number;
	photometricInterpretation?: number;
	planarConfig?: number;
	width: number;
	height: number;
	samplesPerPixel: number;
	bitsPerSample?: number;
	sampleFormat?: number;
	formatLabel?: string; // e.g., 'TIFF', 'NPY', 'PFM', 'EXR'
	dataType?: string; // e.g., 'float16', 'float32' for EXR
	isHdr?: boolean; // For EXR/HDR files
	channels?: number; // Alternative to samplesPerPixel
	channelNames?: string[]; // All channel names in file (e.g., for EXR: ['R', 'G', 'B', 'A'] or ['ViewLayer.Combined.R', ...])
	displayedChannels?: string[]; // Channels actually being displayed (subset of channelNames for multi-layer EXR)
}

export class SizeStatusBarEntry extends PreviewStatusBarEntry {
	private _pixelPosition: string | undefined;
	private _formatInfo: FormatInfo | undefined;
	private _colorPickerShowModified: boolean = false;

	constructor() {
		super('status.tiffVisualizer.size', vscode.l10n.t("Image Size"), vscode.StatusBarAlignment.Right, 102 /* to the right of zoom (110) */);
		this.updateTooltip();
	}

	public show(owner: unknown, text: string) {
		this.showItem(owner, text);
		this.updateTooltip();
	}

	public showPixelPosition(owner: unknown, pixelInfo: string) {
		// pixelInfo comes as a string like "123x456 255 128 64" or "123x456 0.123"
		this._pixelPosition = pixelInfo;
		this.showItem(owner, pixelInfo);
		this.updateTooltip();
	}

	public hidePixelPosition(owner: unknown) {
		if (this._pixelPosition) {
			this._pixelPosition = undefined;
			this.hide(owner);
		}
	}

	public updateFormatInfo(formatInfo: FormatInfo) {
		this._formatInfo = formatInfo;
		this.updateTooltip();
	}

	public updateColorPickerMode(showModified: boolean) {
		this._colorPickerShowModified = showModified;
		this.updateTooltip();
	}

	public getFormattedInfo(): string {
		let info = '**Image Information**\n\n';

		if (this._formatInfo) {
			const formatInfo = this._formatInfo;
			info += `**Dimensions:** ${formatInfo.width} × ${formatInfo.height}\n\n`;
			info += `**Format:** ${formatInfo.formatLabel ?? 'TIFF'}\n\n`;

			if (formatInfo.compression) {
				info += `**Compression:** ${this.getCompressionName(formatInfo.compression)}\n\n`;
			}

			if (formatInfo.dataType) {
				info += `**Data Type:** ${formatInfo.dataType}\n\n`;
			}

			if (formatInfo.predictor && formatInfo.predictor !== 1) {
				info += `**Predictor:** ${this.getPredictorName(formatInfo.predictor)}\n\n`;
			}

			if (formatInfo.sampleFormat !== undefined) {
				info += `**Sample Format:** ${this.getSampleFormatName(formatInfo.sampleFormat)}\n\n`;
			}

			if (formatInfo.bitsPerSample !== undefined) {
				info += `**Bits per Sample:** ${formatInfo.bitsPerSample}\n\n`;
			}

			info += `**Samples per Pixel:** ${formatInfo.channels ?? formatInfo.samplesPerPixel}\n\n`;

			// Show channel names if available (for EXR and other formats with named channels)
			if (formatInfo.channelNames && formatInfo.channelNames.length > 0) {
				// Show which channels are displayed vs. available
				if (formatInfo.displayedChannels && formatInfo.displayedChannels.length > 0 &&
				    formatInfo.displayedChannels.length < formatInfo.channelNames.length) {
					// Multi-layer EXR: show displayed vs. all channels
					const displayedList = formatInfo.displayedChannels.join(', ');
					info += `**Displayed Channels:** ${displayedList}\n\n`;

					const hiddenChannels = formatInfo.channelNames.filter(
						ch => !formatInfo.displayedChannels!.includes(ch)
					);
					const hiddenList = hiddenChannels.join(', ');
					info += `**Hidden Channels:** ${hiddenList}\n\n`;
				} else {
					// Single layer or all channels displayed
					const channelList = formatInfo.channelNames.join(', ');
					info += `**Channel Names:** ${channelList}\n\n`;
				}
			}

			if (formatInfo.isHdr) {
				info += `**HDR:** Yes\n\n`;
			}

			if (formatInfo.photometricInterpretation !== undefined) {
				info += `**Color Space:** ${this.getPhotometricName(formatInfo.photometricInterpretation)}\n\n`;
			}

			if (formatInfo.planarConfig !== undefined) {
				info += `**Planar Config:** ${formatInfo.planarConfig === 1 ? 'Chunky' : 'Planar'}\n\n`;
			}
		}

		// Add color picker mode info
		info += `**Color Picker:** ${this._colorPickerShowModified ? 'Modified (gamma + exposure)' : 'Original'}\n\n`;
		info += 'Right-click on the image to toggle between original and modified values\n\n';

		if (this._pixelPosition) {
			info += `**Pixel Info:** ${this._pixelPosition}`;
		} else {
			info += 'Hover over the image to see pixel coordinates and values';
		}

		return info;
	}

	private updateTooltip() {
		const tooltip = new vscode.MarkdownString();
		tooltip.isTrusted = true;

		tooltip.appendMarkdown('**Image Information**\n\n');

		if (this._formatInfo) {
			const info = this._formatInfo;
			tooltip.appendMarkdown(`**Dimensions:** ${info.width} × ${info.height}\n\n`);
			tooltip.appendMarkdown(`**Format:** ${info.formatLabel ?? 'TIFF'}\n\n`);

			if (info.compression) {
				tooltip.appendMarkdown(`**Compression:** ${this.getCompressionName(info.compression)}\n\n`);
			}

			if (info.dataType) {
				tooltip.appendMarkdown(`**Data Type:** ${info.dataType}\n\n`);
			}

			if (info.predictor && info.predictor !== 1) {
				tooltip.appendMarkdown(`**Predictor:** ${this.getPredictorName(info.predictor)}\n\n`);
			}

			if (info.sampleFormat !== undefined) {
				tooltip.appendMarkdown(`**Sample Format:** ${this.getSampleFormatName(info.sampleFormat)}\n\n`);
			}

			if (info.bitsPerSample !== undefined) {
				tooltip.appendMarkdown(`**Bits per Sample:** ${info.bitsPerSample}\n\n`);
			}

			tooltip.appendMarkdown(`**Samples per Pixel:** ${info.channels ?? info.samplesPerPixel}\n\n`);

			// Show channel names if available (for EXR and other formats with named channels)
			if (info.channelNames && info.channelNames.length > 0) {
				// Show which channels are displayed vs. available
				if (info.displayedChannels && info.displayedChannels.length > 0 &&
				    info.displayedChannels.length < info.channelNames.length) {
					// Multi-layer EXR: show displayed vs. all channels
					const displayedList = info.displayedChannels.join(', ');
					tooltip.appendMarkdown(`**Displayed Channels:** ${displayedList}\n\n`);

					const hiddenChannels = info.channelNames.filter(
						ch => !info.displayedChannels!.includes(ch)
					);
					const hiddenList = hiddenChannels.join(', ');
					tooltip.appendMarkdown(`**Hidden Channels:** ${hiddenList}\n\n`);
				} else {
					// Single layer or all channels displayed
					const channelList = info.channelNames.join(', ');
					tooltip.appendMarkdown(`**Channel Names:** ${channelList}\n\n`);
				}
			}

			if (info.isHdr) {
				tooltip.appendMarkdown(`**HDR:** Yes\n\n`);
			}

			if (info.photometricInterpretation !== undefined) {
				tooltip.appendMarkdown(`**Color Space:** ${this.getPhotometricName(info.photometricInterpretation)}\n\n`);
			}

			if (info.planarConfig !== undefined) {
				tooltip.appendMarkdown(`**Planar Config:** ${info.planarConfig === 1 ? 'Chunky' : 'Planar'}\n\n`);
			}
		}

		// Add color picker mode info
		tooltip.appendMarkdown(`**Color Picker:** ${this._colorPickerShowModified ? 'Modified (gamma + exposure)' : 'Original'}\n\n`);
		tooltip.appendMarkdown('Right-click on the image to toggle between original and modified values\n\n');

		if (this._pixelPosition) {
			tooltip.appendMarkdown(`**Pixel Info:** ${this._pixelPosition}\n\n`);
		} else {
			tooltip.appendMarkdown('Hover over the image to see pixel coordinates and values\n\n');
		}

		// Add hint about copying
		tooltip.appendMarkdown('---\n\n');
		tooltip.appendMarkdown('*Press **Ctrl+Shift+I** (Cmd+Shift+I on Mac) to copy this information to clipboard*');

		this.entry.tooltip = tooltip;
	}

	private getCompressionName(compression: string | number): string {
		const compressionMap: { [key: string]: string } = {
			'1': 'None',
			'2': 'CCITT Group 3 1D (MH)',
			'3': 'CCITT Group 3 2D (T.4)', 
			'4': 'CCITT Group 4 (T.6)',
			'5': 'Lempel–Ziv–Welch (LZW)',
			'6': 'JPEG (old-style, obsolete)',
			'7': 'JPEG (new-style)',
			'8': 'Deflate (ZIP)',
			'32773': 'PackBits',
			'32946': 'Deflate (ZIP)'
		};
		return compressionMap[compression.toString()] || `Unknown (${compression})`;
	}

	private getPredictorName(predictor: number): string {
		const predictorMap: { [key: number]: string } = {
			1: 'None',
			2: 'Horizontal differencing',
			3: 'Floating point'
		};
		return predictorMap[predictor] || `Unknown (${predictor})`;
	}

	private getSampleFormatName(sampleFormat: number): string {
		const formatMap: { [key: number]: string } = {
			1: 'Unsigned integer',
			2: 'Signed integer', 
			3: 'IEEE floating point',
			4: 'Undefined'
		};
		return formatMap[sampleFormat] || `Unknown (${sampleFormat})`;
	}

	private getPhotometricName(photometric: number): string {
		const photometricMap: { [key: number]: string } = {
			0: 'White is zero',
			1: 'Black is zero',
			2: 'RGB',
			3: 'Palette',
			4: 'Transparency mask',
			5: 'CMYK',
			6: 'YCbCr',
			8: 'CIE L*a*b*'
		};
		return photometricMap[photometric] || `Unknown (${photometric})`;
	}
}
