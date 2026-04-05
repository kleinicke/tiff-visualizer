// @ts-check
"use strict";

/**
 * Overlay Panel Module
 * Manages the floating UI panel for overlay image controls.
 * Handles DOM creation, user interaction, drag-to-reorder, and emits state changes.
 */
export class OverlayPanel {
	/**
	 * @param {HTMLElement} container - Parent element to append the panel to
	 * @param {Object} vscode - VS Code API object for posting messages
	 */
	constructor(container, vscode) {
		/** @type {HTMLElement} */
		this._container = container;
		this._vscode = vscode;

		/** @type {Array<{uri: string, filename: string, enabled: boolean}>} */
		this._images = [];
		/** @type {string} */
		this._mode = 'subtract';
		/** @type {string} */
		this._colormap = 'original';
		/** @type {boolean} */
		this._includeNegative = false;
		/** @type {boolean} */
		this._showLegend = false;
		/** @type {{threshold: number, filterHigher: boolean}} */
		this._maskOptions = { threshold: 0.5, filterHigher: true };

		/** @type {Array<Function>} */
		this._stateChangeCallbacks = [];

		/** @type {HTMLElement|null} */
		this._panelElement = null;

		/** @type {number} */
		this._dragStartIndex = -1;

		this._createPanel();
	}

	/**
	 * Create the panel DOM structure
	 * @private
	 */
	_createPanel() {
		const panel = document.createElement('div');
		panel.className = 'overlay-panel overlay-panel-hidden';

		panel.innerHTML = `
			<div class="overlay-panel-header">
				<span class="overlay-panel-title">Overlay Images</span>
				<button class="overlay-panel-close" title="Close overlay panel">×</button>
			</div>
			<div class="overlay-panel-body">
				<div class="overlay-mode-row">
					<label>Mode:</label>
					<select class="overlay-mode-select">
						<option value="subtract">Subtract (A − B)</option>
						<option value="add">Add (A + B)</option>
						<option value="multiply">Multiply (A × B)</option>
						<option value="difference">Difference |A − B|</option>
						<option value="mask">Mask</option>
					</select>
				</div>
				<div class="overlay-image-list"></div>
				<button class="overlay-add-btn" title="Add another overlay image">+ Add Image</button>
				<div class="overlay-separator"></div>
				<div class="overlay-colormap-row">
					<label>Colormap:</label>
					<select class="overlay-colormap-select">
						<option value="original">Original (keep range)</option>
						<option value="scaled">Auto-scaled</option>
						<option value="gray">Gray</option>
						<option value="viridis">Viridis</option>
						<option value="plasma">Plasma</option>
						<option value="inferno">Inferno</option>
						<option value="magma">Magma</option>
						<option value="jet">Jet</option>
						<option value="hot">Hot</option>
						<option value="cool">Cool</option>
						<option value="turbo">Turbo</option>
					</select>
				</div>
				<label class="overlay-checkbox">
					<input type="checkbox" class="overlay-include-negative"/>
					Include negative values
				</label>
				<label class="overlay-checkbox">
					<input type="checkbox" class="overlay-show-legend"/>
					Show colormap legend
				</label>
				<div class="overlay-mask-options overlay-mask-options-hidden">
					<div class="overlay-separator"></div>
					<div class="overlay-mask-row">
						<label>Threshold:</label>
						<input type="number" class="overlay-mask-threshold" value="0.5" step="0.1" min="0"/>
					</div>
					<div class="overlay-mask-row">
						<label>Filter:</label>
						<select class="overlay-mask-filter-select">
							<option value="higher">Higher than threshold</option>
							<option value="lower">Lower than threshold</option>
						</select>
					</div>
				</div>
			</div>
		`;

		this._panelElement = panel;
		this._container.appendChild(panel);
		this._attachEventListeners();
	}

	/**
	 * Attach event listeners to panel elements
	 * @private
	 */
	_attachEventListeners() {
		if (!this._panelElement) return;

		// Close button
		const closeBtn = this._panelElement.querySelector('.overlay-panel-close');
		if (closeBtn) {
			closeBtn.addEventListener('click', () => this.hide());
		}

		// Mode select
		const modeSelect = /** @type {HTMLSelectElement} */ (this._panelElement.querySelector('.overlay-mode-select'));
		if (modeSelect) {
			modeSelect.addEventListener('change', () => {
				this._mode = modeSelect.value;
				this._updateMaskOptionsVisibility();
				this._emitStateChange();
			});
		}

		// Add image button
		const addBtn = this._panelElement.querySelector('.overlay-add-btn');
		if (addBtn) {
			addBtn.addEventListener('click', () => {
				// Ask extension to show file picker
				this._vscode.postMessage({
					type: 'executeCommand',
					command: 'tiffVisualizer.overlayAddImage'
				});
			});
		}

		// Colormap select
		const colormapSelect = /** @type {HTMLSelectElement} */ (this._panelElement.querySelector('.overlay-colormap-select'));
		if (colormapSelect) {
			colormapSelect.addEventListener('change', () => {
				this._colormap = colormapSelect.value;
				this._emitStateChange();
			});
		}

		// Include negative checkbox
		const negativeCheckbox = /** @type {HTMLInputElement} */ (this._panelElement.querySelector('.overlay-include-negative'));
		if (negativeCheckbox) {
			negativeCheckbox.addEventListener('change', () => {
				this._includeNegative = negativeCheckbox.checked;
				this._emitStateChange();
			});
		}

		// Show legend checkbox
		const legendCheckbox = /** @type {HTMLInputElement} */ (this._panelElement.querySelector('.overlay-show-legend'));
		if (legendCheckbox) {
			legendCheckbox.addEventListener('change', () => {
				this._showLegend = legendCheckbox.checked;
				this._emitStateChange();
			});
		}

		// Mask threshold
		const thresholdInput = /** @type {HTMLInputElement} */ (this._panelElement.querySelector('.overlay-mask-threshold'));
		if (thresholdInput) {
			thresholdInput.addEventListener('change', () => {
				this._maskOptions.threshold = parseFloat(thresholdInput.value) || 0.5;
				this._emitStateChange();
			});
		}

		// Mask filter direction
		const filterSelect = /** @type {HTMLSelectElement} */ (this._panelElement.querySelector('.overlay-mask-filter-select'));
		if (filterSelect) {
			filterSelect.addEventListener('change', () => {
				this._maskOptions.filterHigher = filterSelect.value === 'higher';
				this._emitStateChange();
			});
		}

		// Prevent context menu on the panel itself
		this._panelElement.addEventListener('contextmenu', (e) => {
			e.stopPropagation();
		});
	}

	/**
	 * Show/hide mask options based on selected mode
	 * @private
	 */
	_updateMaskOptionsVisibility() {
		if (!this._panelElement) return;
		const maskOptions = this._panelElement.querySelector('.overlay-mask-options');
		if (maskOptions) {
			maskOptions.classList.toggle('overlay-mask-options-hidden', this._mode !== 'mask');
		}
	}

	/**
	 * Render the image list DOM
	 * @private
	 */
	_renderImageList() {
		if (!this._panelElement) return;
		const list = this._panelElement.querySelector('.overlay-image-list');
		if (!list) return;

		list.innerHTML = '';

		this._images.forEach((img, index) => {
			const entry = document.createElement('div');
			entry.className = 'overlay-image-entry';
			entry.draggable = true;
			entry.dataset.index = String(index);

			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.checked = img.enabled;
			checkbox.className = 'overlay-image-checkbox';
			checkbox.addEventListener('change', () => {
				this._images[index].enabled = checkbox.checked;
				this._emitStateChange();
			});

			const label = document.createElement('span');
			label.className = 'overlay-image-filename';
			label.textContent = img.filename;
			label.title = img.uri;

			const dragHandle = document.createElement('span');
			dragHandle.className = 'overlay-drag-handle';
			dragHandle.textContent = '↕';
			dragHandle.title = 'Drag to reorder';

			const removeBtn = document.createElement('button');
			removeBtn.className = 'overlay-remove-btn';
			removeBtn.textContent = '×';
			removeBtn.title = 'Remove this overlay';
			removeBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.removeImage(index);
			});

			entry.appendChild(checkbox);
			entry.appendChild(label);
			entry.appendChild(dragHandle);
			entry.appendChild(removeBtn);

			// Drag events for reordering
			entry.addEventListener('dragstart', (e) => {
				this._dragStartIndex = index;
				entry.classList.add('dragging');
				if (e.dataTransfer) {
					e.dataTransfer.effectAllowed = 'move';
				}
			});

			entry.addEventListener('dragend', () => {
				entry.classList.remove('dragging');
				// Remove all drag-over classes
				list.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
			});

			entry.addEventListener('dragover', (e) => {
				e.preventDefault();
				if (e.dataTransfer) {
					e.dataTransfer.dropEffect = 'move';
				}
				entry.classList.add('drag-over');
			});

			entry.addEventListener('dragleave', () => {
				entry.classList.remove('drag-over');
			});

			entry.addEventListener('drop', (e) => {
				e.preventDefault();
				entry.classList.remove('drag-over');
				const targetIndex = index;
				if (this._dragStartIndex !== -1 && this._dragStartIndex !== targetIndex) {
					this._reorderImages(this._dragStartIndex, targetIndex);
				}
				this._dragStartIndex = -1;
			});

			list.appendChild(entry);
		});
	}

	/**
	 * Reorder images by moving an item from one index to another
	 * @private
	 */
	_reorderImages(fromIndex, toIndex) {
		const [moved] = this._images.splice(fromIndex, 1);
		this._images.splice(toIndex, 0, moved);
		this._renderImageList();
		this._emitStateChange();
	}

	/**
	 * Emit state change to all registered callbacks
	 * @private
	 */
	_emitStateChange() {
		const state = this.getState();
		for (const callback of this._stateChangeCallbacks) {
			callback(state);
		}
	}

	// --- Public API ---

	/**
	 * Show the overlay panel
	 */
	show() {
		if (this._panelElement) {
			this._panelElement.classList.remove('overlay-panel-hidden');
		}
	}

	/**
	 * Hide the overlay panel and signal revert to original
	 */
	hide() {
		if (this._panelElement) {
			this._panelElement.classList.add('overlay-panel-hidden');
		}
		this._emitStateChange();
	}

	/**
	 * Whether the panel is currently visible
	 * @returns {boolean}
	 */
	isVisible() {
		return this._panelElement ? !this._panelElement.classList.contains('overlay-panel-hidden') : false;
	}

	/**
	 * Add an overlay image to the list
	 * @param {string} filename - Display name
	 * @param {string} uri - Image URI
	 */
	addImage(filename, uri) {
		this._images.push({ uri, filename, enabled: true });
		this._renderImageList();
		this.show();
		this._emitStateChange();
	}

	/**
	 * Remove an overlay image from the list
	 * @param {number} index
	 */
	removeImage(index) {
		if (index >= 0 && index < this._images.length) {
			this._images.splice(index, 1);
			this._renderImageList();
			if (this._images.length === 0) {
				this.hide();
			}
			this._emitStateChange();
		}
	}

	/**
	 * Get the current state of the overlay panel
	 * @returns {{
	 *   visible: boolean,
	 *   images: Array<{uri: string, filename: string, enabled: boolean}>,
	 *   mode: string,
	 *   colormap: string,
	 *   includeNegative: boolean,
	 *   showLegend: boolean,
	 *   maskOptions: {threshold: number, filterHigher: boolean}
	 * }}
	 */
	getState() {
		return {
			visible: this.isVisible(),
			images: [...this._images],
			mode: this._mode,
			colormap: this._colormap,
			includeNegative: this._includeNegative,
			showLegend: this._showLegend,
			maskOptions: { ...this._maskOptions }
		};
	}

	/**
	 * Register a callback for state changes
	 * @param {Function} callback
	 */
	onStateChange(callback) {
		this._stateChangeCallbacks.push(callback);
	}

	/**
	 * Destroy the panel and clean up
	 */
	destroy() {
		if (this._panelElement) {
			this._panelElement.remove();
			this._panelElement = null;
		}
		this._stateChangeCallbacks = [];
		this._images = [];
	}
}
