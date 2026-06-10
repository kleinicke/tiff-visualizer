// @ts-check
/**
 * LayersPanel — the in-preview DOM UI for the layer stack.
 *
 * Pure view/controller: it reads and mutates a LayerManager and calls back into
 * the host (imagePreview.js) to (a) re-composite + redraw on any change and
 * (b) request the extension to open a file picker for adding a layer.
 */

import { BLEND_MODES } from './layer-compositor.js';

export class LayersPanel {
	/**
	 * @param {import('./layer-manager.js').LayerManager} manager
	 * @param {{ onChange: () => void, onAddLayer: () => void }} callbacks
	 */
	constructor(manager, callbacks) {
		this.manager = manager;
		this.onChange = callbacks.onChange;
		this.onAddLayer = callbacks.onAddLayer;
		/** @type {HTMLElement|null} */
		this.root = null;
		/** @type {HTMLElement|null} */
		this.listEl = null;
		/** id of the layer currently armed for drag-to-move, or null */
		this.movingLayerId = null;
	}

	/** Build the panel DOM (once) and attach it to the document body. */
	mount() {
		if (this.root) { return; }
		const root = document.createElement('div');
		root.className = 'layers-panel';
		root.setAttribute('hidden', '');

		const header = document.createElement('div');
		header.className = 'layers-panel-header';

		const title = document.createElement('span');
		title.className = 'layers-panel-title';
		title.textContent = 'Layers';

		const addBtn = document.createElement('button');
		addBtn.className = 'layers-btn layers-add';
		addBtn.title = 'Add image(s) as layers';
		addBtn.textContent = '+';
		addBtn.addEventListener('click', () => this.onAddLayer());

		const closeBtn = document.createElement('button');
		closeBtn.className = 'layers-btn layers-close';
		closeBtn.title = 'Close panel';
		closeBtn.textContent = '×';
		closeBtn.addEventListener('click', () => this.hide());

		header.appendChild(title);
		header.appendChild(addBtn);
		header.appendChild(closeBtn);

		const list = document.createElement('div');
		list.className = 'layers-list';

		root.appendChild(header);
		root.appendChild(list);
		document.body.appendChild(root);

		this.root = root;
		this.listEl = list;
		this.refresh();
	}

	/** @returns {boolean} */
	isVisible() {
		return !!this.root && !this.root.hasAttribute('hidden');
	}

	toggle() {
		if (this.isVisible()) { this.hide(); } else { this.show(); }
	}

	show() {
		this.mount();
		this.root?.removeAttribute('hidden');
		this.refresh();
	}

	hide() {
		this.root?.setAttribute('hidden', '');
		this.movingLayerId = null;
	}

	/** Rebuild the layer rows from the manager state (top layer shown first). */
	refresh() {
		if (!this.listEl) { return; }
		this.listEl.textContent = '';
		const layers = this.manager.layers;
		for (let i = layers.length - 1; i >= 0; i--) {
			this.listEl.appendChild(this._buildRow(layers[i], i));
		}
	}

	/**
	 * @param {import('./layer-compositor.js').Layer} layer
	 * @param {number} index 0 = base/background.
	 * @returns {HTMLElement}
	 */
	_buildRow(layer, index) {
		const id = /** @type {string} */ (layer.id);
		const isBase = index === 0;
		const row = document.createElement('div');
		row.className = 'layer-row' + (isBase ? ' layer-row-base' : '');
		row.dataset.id = id;

		// Visibility toggle.
		const vis = document.createElement('input');
		vis.type = 'checkbox';
		vis.className = 'layer-visible';
		vis.checked = layer.visible !== false;
		vis.title = 'Toggle visibility';
		vis.addEventListener('change', () => {
			this.manager.updateLayer(id, { visible: vis.checked });
			this.onChange();
		});
		row.appendChild(vis);

		// Name + dimensions.
		const name = document.createElement('span');
		name.className = 'layer-name';
		name.textContent = `${layer.name || id} (${layer.width}×${layer.height})`;
		name.title = layer.uri || layer.name || id;
		row.appendChild(name);

		if (isBase) {
			const tag = document.createElement('span');
			tag.className = 'layer-base-tag';
			tag.textContent = 'base';
			row.appendChild(tag);
		}

		// Controls row (blend mode + opacity).
		const controls = document.createElement('div');
		controls.className = 'layer-controls';

		const blend = document.createElement('select');
		blend.className = 'layer-blend';
		blend.title = 'Blend mode';
		for (const mode of BLEND_MODES) {
			const opt = document.createElement('option');
			opt.value = mode.id;
			opt.textContent = mode.label;
			if ((layer.blendMode || 'normal') === mode.id) { opt.selected = true; }
			blend.appendChild(opt);
		}
		blend.addEventListener('change', () => {
			this.manager.updateLayer(id, { blendMode: blend.value });
			this.onChange();
		});
		controls.appendChild(blend);

		const opacity = document.createElement('input');
		opacity.type = 'range';
		opacity.className = 'layer-opacity';
		opacity.min = '0';
		opacity.max = '100';
		opacity.value = String(Math.round((layer.opacity ?? 1) * 100));
		opacity.title = 'Opacity';
		opacity.addEventListener('input', () => {
			this.manager.updateLayer(id, { opacity: Number(opacity.value) / 100 });
			this.onChange();
		});
		controls.appendChild(opacity);
		row.appendChild(controls);

		// Position controls (numeric offsets + drag-to-move arm button).
		const pos = document.createElement('div');
		pos.className = 'layer-position';

		const xIn = this._offsetInput(layer.offsetX ?? 0, (v) => {
			this.manager.updateLayer(id, { offsetX: v });
			this.onChange();
		}, 'X offset');
		const yIn = this._offsetInput(layer.offsetY ?? 0, (v) => {
			this.manager.updateLayer(id, { offsetY: v });
			this.onChange();
		}, 'Y offset');
		const xLbl = document.createElement('label');
		xLbl.className = 'layer-pos-label';
		xLbl.textContent = 'X';
		xLbl.appendChild(xIn);
		const yLbl = document.createElement('label');
		yLbl.className = 'layer-pos-label';
		yLbl.textContent = 'Y';
		yLbl.appendChild(yIn);
		pos.appendChild(xLbl);
		pos.appendChild(yLbl);

		const moveBtn = document.createElement('button');
		moveBtn.className = 'layers-btn layer-move' + (this.movingLayerId === id ? ' active' : '');
		moveBtn.textContent = '✥';
		moveBtn.title = 'Drag on the image to move this layer';
		moveBtn.addEventListener('click', () => {
			this.movingLayerId = this.movingLayerId === id ? null : id;
			this.refresh();
		});
		pos.appendChild(moveBtn);
		row.appendChild(pos);

		// Reorder + remove.
		const actions = document.createElement('div');
		actions.className = 'layer-actions';

		const up = document.createElement('button');
		up.className = 'layers-btn';
		up.textContent = '▲';
		up.title = 'Move layer up';
		up.addEventListener('click', () => {
			this.manager.reorderLayer(id, index + 1);
			this.refresh();
			this.onChange();
		});

		const down = document.createElement('button');
		down.className = 'layers-btn';
		down.textContent = '▼';
		down.title = 'Move layer down';
		down.addEventListener('click', () => {
			this.manager.reorderLayer(id, index - 1);
			this.refresh();
			this.onChange();
		});

		const remove = document.createElement('button');
		remove.className = 'layers-btn layer-remove';
		remove.textContent = '🗑';
		remove.title = 'Remove layer';
		remove.addEventListener('click', () => {
			if (this.movingLayerId === id) { this.movingLayerId = null; }
			this.manager.removeLayer(id);
			this.refresh();
			this.onChange();
		});

		actions.appendChild(up);
		actions.appendChild(down);
		actions.appendChild(remove);
		row.appendChild(actions);

		return row;
	}

	/**
	 * @param {number} value
	 * @param {(v:number)=>void} onInput
	 * @param {string} title
	 * @returns {HTMLInputElement}
	 */
	_offsetInput(value, onInput, title) {
		const input = document.createElement('input');
		input.type = 'number';
		input.className = 'layer-offset-input';
		input.value = String(value);
		input.title = title;
		input.addEventListener('change', () => {
			const v = parseInt(input.value, 10);
			if (Number.isFinite(v)) { onInput(v); }
		});
		return input;
	}
}
