import * as vscode from 'vscode';
import { AppStateManager } from './appStateManager';
import { getOutputChannel } from '../extension';

/**
 * Context object passed to all message handlers containing shared dependencies
 */
export interface HandlerContext {
	appStateManager: AppStateManager;
	preview: any; // Will be typed more specifically later
	webview: vscode.Webview;
	outputChannel: vscode.OutputChannel;
}

/**
 * Base interface for typed message handlers using the command pattern
 */
export interface MessageHandler<T = any> {
	readonly type: string;
	handle(message: T, context: HandlerContext): Promise<void> | void;
}

/**
 * Message router that dispatches messages to appropriate handlers
 */
export class TypedMessageRouter {
	private readonly handlers = new Map<string, MessageHandler>();
	private readonly context: HandlerContext;

	constructor(
		appStateManager: AppStateManager,
		preview: any,
		webview: vscode.Webview
	) {
		this.context = {
			appStateManager,
			preview,
			webview,
			outputChannel: getOutputChannel()
		};

		this.registerDefaultHandlers();
	}

	public registerHandler<T>(handler: MessageHandler<T>): void {
		this.handlers.set(handler.type, handler);
	}

	public async handle(message: any): Promise<void> {
		const handler = this.handlers.get(message.type);
		if (handler) {
			try {
				await handler.handle(message, this.context);
			} catch (error) {
				this.context.outputChannel.appendLine(
					`Error handling message ${message.type}: ${error}`
				);
				console.error(`Error handling message ${message.type}:`, error);
			}
		} else {
			this.context.outputChannel.appendLine(
				`No handler registered for message type: ${message.type}`
			);
		}
	}

	private registerDefaultHandlers(): void {
		// Register all default message handlers
		this.registerHandler(new SizeMessageHandler());
		this.registerHandler(new ZoomMessageHandler());
		this.registerHandler(new PixelFocusMessageHandler());
		this.registerHandler(new PixelBlurMessageHandler());
		this.registerHandler(new StatsMessageHandler());
		this.registerHandler(new FormatInfoMessageHandler());
		this.registerHandler(new ReadyMessageHandler());
		this.registerHandler(new ExportPngMessageHandler());
		this.registerHandler(new InitialDataMessageHandler());
	}
}

// Typed message interfaces
export interface SizeMessage {
	type: 'size';
	value: string;
}

export interface ZoomMessage {
	type: 'zoom';
	value: any;
}

export interface PixelFocusMessage {
	type: 'pixelFocus';
	value: any;
}

export interface PixelBlurMessage {
	type: 'pixelBlur';
}

export interface StatsMessage {
	type: 'stats';
	value: { min: number; max: number };
}

export interface FormatInfoMessage {
	type: 'formatInfo';
	value: any;
}

export interface ReadyMessage {
	type: 'ready';
}

export interface ExportPngMessage {
	type: 'didExportAsPng';
	payload: any;
}

export interface InitialDataMessage {
	type: 'get-initial-data';
}

// Typed message handlers
export class SizeMessageHandler implements MessageHandler<SizeMessage> {
	readonly type = 'size';

	handle(message: SizeMessage, context: HandlerContext): void {
		context.appStateManager.setImageSize(message.value);
		// Trigger status bar update through the preview
		if (context.preview.updateStatusBar) {
			context.preview.updateStatusBar();
		}
	}
}

export class ZoomMessageHandler implements MessageHandler<ZoomMessage> {
	readonly type = 'zoom';

	handle(message: ZoomMessage, context: HandlerContext): void {
		context.appStateManager.setImageZoom(message.value);
		// Trigger status bar update through the preview
		if (context.preview.updateStatusBar) {
			context.preview.updateStatusBar();
		}
	}
}

export class PixelFocusMessageHandler implements MessageHandler<PixelFocusMessage> {
	readonly type = 'pixelFocus';

	handle(message: PixelFocusMessage, context: HandlerContext): void {
		context.appStateManager.setPixelPosition(message.value);
		// Update status bar entries that care about pixel position
		if (context.preview.isPreviewActive && context.preview.isPreviewActive()) {
			// This will be refactored when we update the individual status bar entries
			if (context.preview.getSizeStatusBarEntry) {
				context.preview.getSizeStatusBarEntry().showPixelPosition(context.preview, message.value);
			}
		}
	}
}

export class PixelBlurMessageHandler implements MessageHandler<PixelBlurMessage> {
	readonly type = 'pixelBlur';

	handle(message: PixelBlurMessage, context: HandlerContext): void {
		context.appStateManager.setPixelPosition(undefined);
		// Update status bar entries
		if (context.preview.isPreviewActive && context.preview.isPreviewActive()) {
			if (context.preview.getSizeStatusBarEntry) {
				context.preview.getSizeStatusBarEntry().hidePixelPosition(context.preview);
				const imageSize = context.appStateManager.uiState.imageSize;
				if (imageSize) {
					context.preview.getSizeStatusBarEntry().show(context.preview, imageSize);
				}
			}
		}
	}
}

export class StatsMessageHandler implements MessageHandler<StatsMessage> {
	readonly type = 'stats';

	handle(message: StatsMessage, context: HandlerContext): void {
		if (context.preview.isTiff) {
			context.appStateManager.updateImageStats(message.value.min, message.value.max);
			// The AppStateManager will emit the stats changed event, which status bar entries can listen to
			if (context.preview.updateStatusBar) {
				context.preview.updateStatusBar();
			}
		}
	}
}

export class FormatInfoMessageHandler implements MessageHandler<FormatInfoMessage> {
	readonly type = 'formatInfo';

	handle(message: FormatInfoMessage, context: HandlerContext): void {
		console.log('[FormatInfoMessageHandler] Received formatInfo message:', message.value);
		context.appStateManager.setFormatInfo(message.value);

		// Set the format type for per-format settings
		if (message.value && message.value.formatType) {
			console.log('[FormatInfoMessageHandler] Setting format type:', message.value.formatType);
			context.appStateManager.setImageFormat(message.value.formatType);
		} else {
			console.log('[FormatInfoMessageHandler] WARNING: No formatType in message!');
		}

		if (context.preview.isTiff && context.preview.getSizeStatusBarEntry) {
			context.preview.getSizeStatusBarEntry().updateFormatInfo(message.value);
		}
	}
}

export class ReadyMessageHandler implements MessageHandler<ReadyMessage> {
	readonly type = 'ready';

	handle(message: ReadyMessage, context: HandlerContext): void {
		if (!context.preview.isPreviewActive || !context.preview.isPreviewActive()) {
			return;
		}
		context.webview.postMessage({
			type: 'update',
			body: {
				isTiff: context.preview.isTiff
			}
		});
	}
}

export class ExportPngMessageHandler implements MessageHandler<ExportPngMessage> {
	readonly type = 'didExportAsPng';

	handle(message: ExportPngMessage, context: HandlerContext): void {
		if (context.preview.fireExportEvent) {
			context.preview.fireExportEvent(message.payload);
		}
	}
}

export class InitialDataMessageHandler implements MessageHandler<InitialDataMessage> {
	readonly type = 'get-initial-data';

	handle(message: InitialDataMessage, context: HandlerContext): void {
		context.webview.postMessage({
			type: 'update',
			body: {
				isTiff: context.preview.isTiff
			}
		});
	}
} 