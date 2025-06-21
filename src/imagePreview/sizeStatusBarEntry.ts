import * as vscode from 'vscode';
import { PreviewStatusBarEntry } from '../ownedStatusBarEntry';

interface FormatInfo {
	compression: string;
	predictor?: number;
	photometricInterpretation?: number;
	planarConfig?: number;
	width: number;
	height: number;
	samplesPerPixel: number;
	bitsPerSample: number;
	sampleFormat: number;
}

export class SizeStatusBarEntry extends PreviewStatusBarEntry {
	private _pixelPosition: string | undefined;
	private _formatInfo: FormatInfo | undefined;

	constructor() {
		super('status.tiffVisualizer.size', vscode.l10n.t("Image Size"), vscode.StatusBarAlignment.Right, 110 /* to the left of zoom (102) */);
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

	private updateTooltip() {
		const tooltip = new vscode.MarkdownString();
		tooltip.isTrusted = true;
		
		tooltip.appendMarkdown('**Image Information**\n\n');
		
		if (this._formatInfo) {
			const info = this._formatInfo;
			tooltip.appendMarkdown(`**Dimensions:** ${info.width} × ${info.height}\n\n`);
			tooltip.appendMarkdown(`**Format:** TIFF\n\n`);
			tooltip.appendMarkdown(`**Compression:** ${this.getCompressionName(info.compression)}\n\n`);
			
			if (info.predictor && info.predictor !== 1) {
				tooltip.appendMarkdown(`**Predictor:** ${this.getPredictorName(info.predictor)}\n\n`);
			}
			
			tooltip.appendMarkdown(`**Sample Format:** ${this.getSampleFormatName(info.sampleFormat)}\n\n`);
			tooltip.appendMarkdown(`**Bits per Sample:** ${info.bitsPerSample}\n\n`);
			tooltip.appendMarkdown(`**Samples per Pixel:** ${info.samplesPerPixel}\n\n`);
			
			if (info.photometricInterpretation !== undefined) {
				tooltip.appendMarkdown(`**Color Space:** ${this.getPhotometricName(info.photometricInterpretation)}\n\n`);
			}
			
			if (info.planarConfig !== undefined) {
				tooltip.appendMarkdown(`**Planar Config:** ${info.planarConfig === 1 ? 'Chunky' : 'Planar'}\n\n`);
			}
		}
		
		if (this._pixelPosition) {
			tooltip.appendMarkdown(`**Pixel Info:** ${this._pixelPosition}`);
		} else {
			tooltip.appendMarkdown('Hover over the image to see pixel coordinates and values');
		}
		
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
