import * as vscode from 'vscode';
import { ImageSettingsManager } from './imageSettings';
import { AppStateManager } from './appStateManager';

export type LayerExportFormat = 'png' | 'ora' | 'xcf' | 'kra' | 'psd';
export interface LayerExportOption {
	format: LayerExportFormat;
	label: string;
	description: string;
	detail: string;
	compatible: boolean;
}
export interface LayerExportResult {
	format: LayerExportFormat;
	payload?: string;
	warnings: string[];
	error?: string;
}

/**
 * What a command can ask of whichever viewer is in front. Every member is
 * optional: a viewer implements the commands that make sense for it, and a
 * command reports when the front viewer does not.
 */
export interface IViewerCommandTarget {
	toggleScaleBar?(): void;
}

/** What a viewer that is not an image preview needs from the manager: session settings and a way to become the command target. */
export interface IViewerRegistry {
	readonly settingsManager: Pick<ImageSettingsManager, 'getShowScaleBar' | 'toggleScaleBar' | 'onDidChangeSettings'>;
	registerViewer(target: IViewerCommandTarget, panel: vscode.WebviewPanel): void;
}

export interface IImagePreviewManager {
	readonly settingsManager: ImageSettingsManager;
	readonly appStateManager: AppStateManager;
	getNormalizationConfig(): any;
	getGammaConfig(): any;
	getBrightnessConfig(): any;
	setTempNormalization(min: number, max: number): void;
	setAutoNormalize(enabled: boolean): void;
	setGammaMode(enabled: boolean): void;
	setTempGamma(gammaIn: number, gammaOut: number): void;
	setTempBrightness(offset: number): void;
	setComparisonBase(uri: vscode.Uri | undefined): void;
	getComparisonBase(): vscode.Uri | undefined;
	setResourceFormatHint(uri: vscode.Uri, formatHint: string): void;
	getResourceFormatHint(uri: vscode.Uri): string | undefined;
	updateAllPreviews(): void;
	refreshActiveMode(): void;
}

export interface IImagePreview extends IViewerCommandTarget {
	readonly resource: vscode.Uri;
	readonly viewColumn: vscode.ViewColumn | undefined;
	updatePreview(): void;
	isPreviewActive(): boolean;
	setImageSize(size: string): void;
	getImageSize(): string | undefined;
	setImageZoom(zoom: any): void;
	readonly isTiff: boolean;
	zoomIn(): void;
	zoomOut(): void;
	copyImage(): void;
	requestDepthPlane(): Promise<Uint8Array>;
	resetZoom(): void;
	getLayerExportCompatibility(): Promise<LayerExportOption[] | undefined>;
	exportLayerDocument(format: LayerExportFormat): Promise<LayerExportResult | undefined>;
	startComparison(peerUri: vscode.Uri): void;
	updateStatusBar(): void;
	readonly imageCollection: readonly vscode.Uri[];
	getCurrentImage(): vscode.Uri;
	addToImageCollection(uri: vscode.Uri): Promise<boolean>;
	ensureLocalResourceRoots(uris: vscode.Uri[]): void;
	addLayerImages(uris: vscode.Uri[]): void;
	getViewMode(): 'layers' | 'collection' | 'normal';
	setLayerMode(active: boolean): void;
	resolveLayerUris(resourceUris: string[]): void;
	pastePosition(): void;
	jumpToCollectionIndex(index: number): void;
	removeCurrentFromCollection(): void;
	getManager(): IImagePreviewManager;
	toggleHistogram(): void;
	toggleMetadata(): void;
	toggleMeasure(): void;
	toggleChannels(): void;
	toggleCells(): void;
	toggleScaleBar(): void;
}
