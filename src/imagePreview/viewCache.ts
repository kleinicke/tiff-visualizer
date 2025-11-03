import * as vscode from 'vscode';
import type { ImageSettings, ImageFormatType } from './appStateManager';
import type { MaskFilterSettings } from './imageSettings';

/**
 * Represents a cached view of an image with all its state
 */
export interface CachedImageView {
	resourceUri: vscode.Uri;
	format: ImageFormatType | undefined;
	renderedWithSettings: ImageSettings;
	maskFilters: MaskFilterSettings[];
	zoomState: { scale: any; x: number; y: number } | undefined;
	comparisonState: { peerUris: string[]; isShowingPeer: boolean } | undefined;
	timestamp: number; // For LRU tracking
}

/**
 * LRU cache for image views within a preview window
 * Keeps up to MAX_CACHED_IMAGES (5) images in memory
 */
export class ViewCache {
	private static readonly MAX_CACHED_IMAGES = 5;

	private _cache: Map<string, CachedImageView> = new Map();

	/**
	 * Get a cached view by resource URI
	 */
	public get(resourceUri: vscode.Uri): CachedImageView | undefined {
		const key = resourceUri.toString();
		const cached = this._cache.get(key);

		if (cached) {
			// Update timestamp for LRU tracking
			cached.timestamp = Date.now();
		}

		return cached;
	}

	/**
	 * Check if a cached view exists and its settings match current settings
	 */
	public isValid(
		resourceUri: vscode.Uri,
		currentSettings: ImageSettings,
		currentFormat: ImageFormatType | undefined
	): boolean {
		const cached = this._cache.get(resourceUri.toString());

		if (!cached) {
			return false;
		}

		// If format changed, cache is invalid (image type changed)
		if (cached.format !== currentFormat) {
			return false;
		}

		// If settings for this format changed, cache is invalid (need to re-render)
		return this._settingsMatch(cached.renderedWithSettings, currentSettings);
	}

	/**
	 * Cache a view
	 */
	public set(
		resourceUri: vscode.Uri,
		format: ImageFormatType | undefined,
		currentSettings: ImageSettings,
		maskFilters: MaskFilterSettings[],
		zoomState: { scale: any; x: number; y: number } | undefined,
		comparisonState: { peerUris: string[]; isShowingPeer: boolean } | undefined
	): void {
		const key = resourceUri.toString();

		// Remove oldest item if cache is full
		if (this._cache.size >= ViewCache.MAX_CACHED_IMAGES && !this._cache.has(key)) {
			this._evictOldest();
		}

		const cachedView: CachedImageView = {
			resourceUri,
			format,
			renderedWithSettings: this._deepCopySettings(currentSettings),
			maskFilters: [...maskFilters],
			zoomState,
			comparisonState,
			timestamp: Date.now()
		};

		this._cache.set(key, cachedView);
	}

	/**
	 * Invalidate all cached views of a specific format
	 */
	public invalidateFormat(format: ImageFormatType | undefined): void {
		const keysToDelete: string[] = [];

		for (const [key, cached] of this._cache) {
			if (cached.format === format) {
				keysToDelete.push(key);
			}
		}

		for (const key of keysToDelete) {
			this._cache.delete(key);
		}
	}

	/**
	 * Clear all cached views
	 */
	public clear(): void {
		this._cache.clear();
	}

	/**
	 * Get cache size for debugging
	 */
	public get size(): number {
		return this._cache.size;
	}

	/**
	 * Evict the least recently used item
	 */
	private _evictOldest(): void {
		let oldestKey: string | undefined;
		let oldestTime = Infinity;

		for (const [key, cached] of this._cache) {
			if (cached.timestamp < oldestTime) {
				oldestTime = cached.timestamp;
				oldestKey = key;
			}
		}

		if (oldestKey) {
			this._cache.delete(oldestKey);
		}
	}

	/**
	 * Check if two settings objects are equal
	 */
	private _settingsMatch(cached: ImageSettings, current: ImageSettings): boolean {
		return (
			cached.normalization.min === current.normalization.min &&
			cached.normalization.max === current.normalization.max &&
			cached.normalization.autoNormalize === current.normalization.autoNormalize &&
			cached.normalization.gammaMode === current.normalization.gammaMode &&
			cached.gamma.in === current.gamma.in &&
			cached.gamma.out === current.gamma.out &&
			cached.brightness.offset === current.brightness.offset &&
			cached.rgbAs24BitGrayscale === current.rgbAs24BitGrayscale &&
			cached.scale24BitFactor === current.scale24BitFactor &&
			cached.normalizedFloatMode === current.normalizedFloatMode
		);
	}

	/**
	 * Deep copy settings object
	 */
	private _deepCopySettings(settings: ImageSettings): ImageSettings {
		return {
			normalization: { ...settings.normalization },
			gamma: { ...settings.gamma },
			brightness: { ...settings.brightness },
			rgbAs24BitGrayscale: settings.rgbAs24BitGrayscale,
			scale24BitFactor: settings.scale24BitFactor,
			normalizedFloatMode: settings.normalizedFloatMode
		};
	}
}
