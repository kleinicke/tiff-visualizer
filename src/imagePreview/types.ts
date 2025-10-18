import * as vscode from 'vscode';
import { ImageSettingsManager } from './imageSettings';
import { AppStateManager } from './appStateManager';

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
	updateAllPreviews(): void;
}

export interface IImagePreview {
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
	resetZoom(): void;
	exportAsPng(): Promise<string | undefined>;
	startComparison(peerUri: vscode.Uri): void;
	updateStatusBar(): void;
	addToImageCollection(uri: vscode.Uri): Promise<void>;
	getManager(): IImagePreviewManager;
} 