// @ts-check
"use strict";

/**
 * Settings Manager Module
 * Handles application settings and configuration
 */
export class SettingsManager {
	constructor() {
		this._settings = this._loadSettings();
		this._constants = {
			PIXELATION_THRESHOLD: 3,
			SCALE_PINCH_FACTOR: 0.075,
			MAX_SCALE: 200,
			MIN_SCALE: 0.1,
			ZOOM_LEVELS: [
				0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1,
				1.5, 2, 3, 5, 7, 10, 15, 20, 30, 50, 70, 100, 200
			]
		};
		this._isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
	}

	/**
	 * Load settings from the DOM
	 * @private
	 */
	_loadSettings() {
		const element = document.getElementById('image-preview-settings');
		if (element) {
			const data = element.getAttribute('data-settings');
			if (data) {
				return JSON.parse(data);
			}
		}
		throw new Error('Could not load settings');
	}

	/**
	 * Get application settings
	 */
	get settings() {
		return this._settings;
	}

	/**
	 * Get application constants
	 */
	get constants() {
		return this._constants;
	}

	/**
	 * Check if running on Mac
	 */
	get isMac() {
		return this._isMac;
	}

	/**
	 * Update settings from new data (for real-time updates)
	 * @param {Object} newSettings - New settings object
	 */
	updateSettings(newSettings) {
		this._settings = { ...this._settings, ...newSettings };
	}
} 