import * as vscode from 'vscode';
import { ImagePreview } from './imagePreview';
import { PreviewState } from '../mediaPreview';
import { SizeStatusBarEntry } from './sizeStatusBarEntry';

export interface MessageHandler {
	handle(message: any, preview: ImagePreview): void;
}

export class MessageRouter {
	private readonly handlers = new Map<string, MessageHandler>();

	constructor(
		private readonly sizeStatusBarEntry: SizeStatusBarEntry,
		private readonly preview: ImagePreview
	) {
		this.registerHandlers();
	}

	private registerHandlers(): void {
		this.handlers.set('size', new SizeMessageHandler());
		this.handlers.set('zoom', new ZoomMessageHandler());
		this.handlers.set('pixelFocus', new PixelFocusMessageHandler(this.sizeStatusBarEntry));
		this.handlers.set('pixelBlur', new PixelBlurMessageHandler(this.sizeStatusBarEntry));
		this.handlers.set('isFloat', new IsFloatMessageHandler());
		this.handlers.set('stats', new StatsMessageHandler());
		this.handlers.set('formatInfo', new FormatInfoMessageHandler());
		this.handlers.set('ready', new ReadyMessageHandler());
		this.handlers.set('didExportAsPng', new ExportPngMessageHandler());
		this.handlers.set('get-initial-data', new InitialDataMessageHandler());
		this.handlers.set('mask-filter-request', new MaskFilterRequestMessageHandler());
		this.handlers.set('refresh-status', new RefreshStatusMessageHandler());
	}

	public handle(message: any): void {
		const handler = this.handlers.get(message.type);
		if (handler) {
			handler.handle(message, this.preview);
		}
	}
}

class SizeMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		preview.setImageSize(message.value);
		preview.updateStatusBar();
	}
}

class ZoomMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		preview.setImageZoom(message.value);
		preview.updateStatusBar();
	}
}

class PixelFocusMessageHandler implements MessageHandler {
	constructor(private readonly sizeStatusBarEntry: SizeStatusBarEntry) {}

	handle(message: any, preview: ImagePreview): void {
		if (preview.isPreviewActive()) {
			this.sizeStatusBarEntry.showPixelPosition(preview, message.value);
		}
	}
}

class PixelBlurMessageHandler implements MessageHandler {
	constructor(private readonly sizeStatusBarEntry: SizeStatusBarEntry) {}

	handle(message: any, preview: ImagePreview): void {
		if (preview.isPreviewActive()) {
			this.sizeStatusBarEntry.hidePixelPosition(preview);
			this.sizeStatusBarEntry.show(preview, preview.getImageSize() || '');
		}
	}
}

class IsFloatMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		const outputChannel = vscode.window.createOutputChannel('TIFF Visualizer Debug');
		outputChannel.appendLine(`TIFF Visualizer: Received isFloat message: ${JSON.stringify(message)}`);
		
		if (message.value !== undefined) {
			outputChannel.appendLine(`TIFF Visualizer: Setting isFloat to: ${message.value}`);
			preview.setIsFloat(message.value);
			
			outputChannel.appendLine('TIFF Visualizer: Updating status bar after isFloat change');
			preview.updateStatusBar();
			outputChannel.appendLine('TIFF Visualizer: Status bar update complete');
		} else {
			outputChannel.appendLine('TIFF Visualizer: Warning - isFloat message missing value');
		}
	}
}

class StatsMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		// Update stats for any image sending stats (TIFF and non-TIFF float sources)
		preview.getManager().settingsManager.updateImageStats(message.value.min, message.value.max);
		preview.getNormalizationStatusBarEntry().updateImageStats(message.value.min, message.value.max);
		preview.updateStatusBar();
	}
}

class FormatInfoMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		// Accept format info from any source (TIFF and non-TIFF processors)
		preview.getSizeStatusBarEntry().updateFormatInfo(message.value);
	}
}

class ReadyMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		if (!preview.isPreviewActive()) {
			return;
		}
		preview.getWebview().postMessage({
			type: 'update',
			body: {
				isTiff: preview.isTiff
			}
		});
	}
}

class ExportPngMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		preview.fireExportEvent(message.payload);
	}
}

class InitialDataMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		preview.getWebview().postMessage({
			type: 'update',
			body: {
				isTiff: preview.isTiff
			}
		});
	}
}

class MaskFilterRequestMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		if (preview.isPreviewActive()) {
			const maskSettings = preview.getManager().settingsManager.getMaskFilterSettings();
			preview.getWebview().postMessage({
				type: 'mask-filter-settings',
				settings: maskSettings
			});
		}
	}
} 

class RefreshStatusMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		preview.updateStatusBar();
	}
}