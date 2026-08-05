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
		this.handlers.set('stats', new StatsMessageHandler());
		this.handlers.set('formatInfo', new FormatInfoMessageHandler());
		this.handlers.set('ready', new ReadyMessageHandler());
		this.handlers.set('didGetLayerExportCompatibility', new LayerExportCompatibilityMessageHandler());
		this.handlers.set('didExportLayerDocument', new ExportLayerDocumentMessageHandler());
		this.handlers.set('get-initial-data', new InitialDataMessageHandler());
		this.handlers.set('refresh-status', new RefreshStatusMessageHandler());
		this.handlers.set('zoomStateResponse', new ZoomStateResponseMessageHandler());
		this.handlers.set('comparisonStateResponse', new ComparisonStateResponseMessageHandler());
		this.handlers.set('toggleImage', new ToggleImageMessageHandler());
		this.handlers.set('toggleImageReverse', new ToggleImageReverseMessageHandler());
		this.handlers.set('removeFromCollection', new RemoveFromCollectionMessageHandler());
		this.handlers.set('jumpToCollectionIndex', new JumpToCollectionIndexMessageHandler());
		this.handlers.set('navigateDataset', new NavigateDatasetMessageHandler());
		this.handlers.set('registerOmeDataset', new RegisterOmeDatasetMessageHandler());
		this.handlers.set('registerDicomFrames', new RegisterDicomFramesMessageHandler());
		this.handlers.set('restorePeerImage', new RestorePeerImageMessageHandler());
		this.handlers.set('histogramVisibilityChanged', new HistogramVisibilityChangedMessageHandler());
		this.handlers.set('histogramPositionChanged', new HistogramPositionChangedMessageHandler());
		this.handlers.set('histogramScaleModeChanged', new HistogramScaleModeChangedMessageHandler());
		this.handlers.set('executeCommand', new ExecuteCommandMessageHandler());
		this.handlers.set('layerModeChanged', new LayerModeChangedMessageHandler());
		this.handlers.set('resolveLayerUris', new ResolveLayerUrisMessageHandler());
		this.handlers.set('requestInitialLayers', new RequestInitialLayersMessageHandler());
		this.handlers.set('log', new LogMessageHandler());
		this.handlers.set('positionCopied', new PositionCopiedMessageHandler());
		this.handlers.set('measureSaveText', new MeasureSaveTextMessageHandler());
		this.handlers.set('measureSaveBinary', new MeasureSaveBinaryMessageHandler());
		this.handlers.set('measureSaveSidecar', new MeasureSaveSidecarMessageHandler());
		this.handlers.set('measureRequestImport', new MeasureRequestImportMessageHandler());
		this.handlers.set('measureCheckSidecar', new MeasureCheckSidecarMessageHandler());
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


class StatsMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		if (!message.value) { return; }
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

		// Update normalization status bar with format info
		if (message.value && message.value.bitsPerSample !== undefined && message.value.sampleFormat !== undefined) {
			preview.getNormalizationStatusBarEntry().updateFormatInfo(message.value);
		}

		// Store format info in app state for access by commands
		preview.getManager().appStateManager.setFormatInfo(message.value);

		// Set the format type for per-format settings
		if (message.value && message.value.formatType) {
			preview.getManager().appStateManager.setImageFormat(message.value.formatType);
			// Track the format in this preview instance
			preview.setCurrentFormat(message.value.formatType);

			// Log format detection (only on initial load to avoid duplicate logs)
			if (message.value.isInitialLoad) {
				const output = require('../extension').getOutputChannel();
				const formatDetails = `${message.value.formatType} (${message.value.width}×${message.value.height}, ${message.value.bitsPerSample}bit)`;
				output.appendLine(`   Format detected: ${formatDetails}`);
			}
		}

		// If this is initial load, send settings back with render trigger
		if (message.value && message.value.isInitialLoad) {
			const settings = preview.getManager().appStateManager.imageSettings;
			preview.getWebview().postMessage({
				type: 'updateSettings',
				settings: settings,
				reason: 'initial-format-settings',
				isInitialRender: true  // Trigger deferred rendering
			});
		}
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

class LayerExportCompatibilityMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		preview.fireLayerExportCompatibilityEvent(Array.isArray(message.options) ? message.options : []);
	}
}

class ExportLayerDocumentMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		preview.fireLayerExportEvent({
			format: message.format,
			payload: message.payload,
			warnings: Array.isArray(message.warnings) ? message.warnings : [],
			error: message.error,
		});
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
		
		// Send global histogram state to new webview
		const histogramState = preview.getManager().appStateManager.histogramState;
		preview.getWebview().postMessage({
			type: 'restoreHistogramState',
			isVisible: histogramState.isVisible,
			position: histogramState.position,
			scaleMode: histogramState.scaleMode
		});
		// Sync status bar to reflect current global histogram visibility
		preview.syncHistogramStatusBar(histogramState.isVisible);
		preview.sendDatasetManifest();
	}
}

class RegisterDicomFramesMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		preview.registerDicomFrames(Number(message.frames || 1));
	}
}

class RefreshStatusMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		preview.updateStatusBar();
	}
}

class ZoomStateResponseMessageHandler implements MessageHandler {
	handle(_message: any, _preview: ImagePreview): void {
		// No-op: zoom state is persisted via vscode.setState in the webview and
		// recovered from there on reload, so no extension-side storage is needed.
	}
}

class ToggleImageMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		preview.toggleToNextImage();
	}
}

class ToggleImageReverseMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		preview.toggleToPreviousImage();
	}
}

class RemoveFromCollectionMessageHandler implements MessageHandler {
	handle(_message: any, preview: ImagePreview): void {
		preview.removeCurrentFromCollection();
	}
}

class JumpToCollectionIndexMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		if (typeof message.index === 'number') {
			preview.jumpToCollectionIndex(message.index);
		}
	}
}

class NavigateDatasetMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		if (typeof message.seriesIndex === 'number' && message.coordinates && typeof message.coordinates === 'object') {
			preview.navigateDataset(message.seriesIndex, message.coordinates);
		}
	}
}

class RegisterOmeDatasetMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		void preview.registerOmeDataset(message.dataset);
	}
}


class ComparisonStateResponseMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		// Store the comparison state for later restoration
		(preview as any)._currentComparisonState = message.state;
	}
}

class RestorePeerImageMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		// Add restored peer image to image collection
		const peerUri = message.peerUri;
		if (peerUri) {
			const uri = vscode.Uri.parse(peerUri);
			preview.addToImageCollection(uri);
		}
	}
}

class HistogramVisibilityChangedMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		const isVisible = message.isVisible;
		preview.updateHistogramVisibility(isVisible);
	}
}

class HistogramPositionChangedMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		if (message.position) {
			preview.getManager().appStateManager.setHistogramPosition(message.position);
		}
	}
}

class HistogramScaleModeChangedMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		if (message.mode) {
			preview.getManager().appStateManager.setHistogramScaleMode(message.mode);
		}
	}
}

class ExecuteCommandMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		if (message.command) {
			vscode.commands.executeCommand(message.command);
		}
	}
}

class LayerModeChangedMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		preview.setLayerMode(!!message.active);
	}
}

class ResolveLayerUrisMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		if (Array.isArray(message.resourceUris)) {
			preview.resolveLayerUris(message.resourceUris);
		}
	}
}

class RequestInitialLayersMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		preview.sendInitialLayers();
	}
}

class LogMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		if (message.value) {
			const output = require('../extension').getOutputChannel();
			output.appendLine(message.value);
		}
	}
}

class PositionCopiedMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		// Store the copied position in the manager for cross-webview paste
		if (message.state) {
			const manager = preview.getManager();
			if ('setCopiedPosition' in manager) {
				(manager as any).setCopiedPosition(message.state);
			}
		}
	}
}


// ---------------------------------------------------------------------------
// Measurement file I/O
// ---------------------------------------------------------------------------

/**
 * Default directory for measurement output: next to the image being measured.
 *
 * Keeping results beside the data is the point of doing this inside an editor —
 * the CSV, the ROI sidecar, and the image end up in the same folder and the
 * same commit, instead of in whatever directory a separate application happened
 * to be pointed at.
 */
function measurementDirectory(preview: ImagePreview): vscode.Uri {
	return vscode.Uri.joinPath(preview.getCurrentImage(), '..');
}

async function writeMeasurementFile(
	preview: ImagePreview,
	fileName: string,
	bytes: Uint8Array,
	options: { open?: boolean } = {},
): Promise<void> {
	const defaultUri = vscode.Uri.joinPath(measurementDirectory(preview), fileName);
	const target = await vscode.window.showSaveDialog({ defaultUri });
	if (!target) { return; }
	try {
		await vscode.workspace.fs.writeFile(target, bytes);
	} catch (error) {
		vscode.window.showErrorMessage(`Could not write ${fileName}: ${error}`);
		return;
	}
	if (options.open) {
		// Opening the result as an ordinary editor tab is what makes it
		// diffable and copyable without a detour through another application.
		//
		// Beside, and without stealing focus: replacing the image editor would
		// hide the preview, and coming back to a hidden preview re-navigates a
		// multi-image collection, which resets the measurement session the
		// export was made from. Keeping both visible avoids that entirely.
		const document = await vscode.workspace.openTextDocument(target);
		await vscode.window.showTextDocument(document, {
			preview: false,
			viewColumn: vscode.ViewColumn.Beside,
			preserveFocus: true,
		});
	} else {
		vscode.window.showInformationMessage(`Saved ${vscode.workspace.asRelativePath(target)}`);
	}
}

class MeasureSaveTextMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		const bytes = new TextEncoder().encode(String(message.content ?? ''));
		void writeMeasurementFile(preview, String(message.fileName || 'results.csv'), bytes, {
			open: message.open !== false,
		});
	}
}

class MeasureSaveBinaryMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		// The webview cannot transfer a typed array, so bytes arrive as a plain
		// number array and are rebuilt here.
		const bytes = Uint8Array.from(Array.isArray(message.bytes) ? message.bytes : []);
		void writeMeasurementFile(preview, String(message.fileName || 'export.bin'), bytes);
	}
}

/**
 * Save the ROI sidecar next to the image, without a dialog.
 *
 * The path is derived from the image name (`image.tif.rois.json`) precisely so
 * that reopening the image can find it again; prompting for a location every
 * time would break that convention and make the file just another loose export.
 */
class MeasureSaveSidecarMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		const image = preview.getCurrentImage();
		const target = image.with({ path: `${image.path}.rois.json` });
		const bytes = new TextEncoder().encode(String(message.content ?? ''));
		void (async () => {
			try {
				await vscode.workspace.fs.writeFile(target, bytes);
				preview.getWebview().postMessage({
					type: 'measureHint',
					text: `Saved ${vscode.workspace.asRelativePath(target)}`,
				});
			} catch (error) {
				vscode.window.showErrorMessage(`Could not save ROIs: ${error}`);
			}
		})();
	}
}

class MeasureRequestImportMessageHandler implements MessageHandler {
	handle(message: any, preview: ImagePreview): void {
		const kind = message.kind === 'imagej' ? 'imagej' : 'sidecar';
		void (async () => {
			const image = preview.getCurrentImage();
			// Offer the conventional sidecar first, so the common case is one
			// click rather than a directory hunt.
			const defaultUri = kind === 'sidecar'
				? image.with({ path: `${image.path}.rois.json` })
				: vscode.Uri.joinPath(measurementDirectory(preview), 'RoiSet.zip');
			const picked = await vscode.window.showOpenDialog({
				defaultUri,
				canSelectMany: false,
				openLabel: kind === 'imagej' ? 'Import ROIs' : 'Load ROIs',
				filters: kind === 'imagej'
					? { 'ImageJ ROIs': ['roi', 'zip'] }
					: { 'ROI sidecar': ['json'] },
			});
			if (!picked || picked.length === 0) { return; }
			try {
				const bytes = await vscode.workspace.fs.readFile(picked[0]);
				preview.getWebview().postMessage({
					type: 'measureImportResult',
					kind,
					fileName: picked[0].path.split('/').pop() || '',
					bytes: Array.from(bytes),
				});
			} catch (error) {
				vscode.window.showErrorMessage(`Could not read the ROI file: ${error}`);
			}
		})();
	}
}

/**
 * Look for `image.tif.rois.json` beside the image and offer it to the webview.
 *
 * Silence when there is nothing to load: an image without a sidecar must not
 * produce a message, an error, or a prompt. The webview decides whether to apply
 * what comes back — it will not overwrite ROIs the user is working on.
 */
class MeasureCheckSidecarMessageHandler implements MessageHandler {
	handle(_message: any, preview: ImagePreview): void {
		void (async () => {
			const image = preview.getCurrentImage();
			const sidecar = image.with({ path: `${image.path}.rois.json` });
			let bytes: Uint8Array;
			try {
				bytes = await vscode.workspace.fs.readFile(sidecar);
			} catch {
				// No sidecar. This is the common case and is not a problem.
				return;
			}
			preview.getWebview().postMessage({
				type: 'measureImportResult',
				kind: 'sidecar',
				automatic: true,
				fileName: sidecar.path.split('/').pop() || '',
				bytes: Array.from(bytes),
			});
		})();
	}
}
