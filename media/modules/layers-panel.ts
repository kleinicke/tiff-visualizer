/**
 * LayersPanel — the in-preview DOM UI for the layer stack.
 *
 * Pure view/controller: it reads and mutates a LayerManager and calls back into
 * the host (imagePreview.js) to (a) re-composite + redraw on any change and
 * (b) request the extension to open a file picker for adding a layer.
 */

import { BLEND_MODES, MASK_CONDITIONS, Layer } from './layer-compositor.js';
import type { LayerManager } from './layer-manager.js';

export interface LayersPanelCallbacks {
	onChange: (options?: { interactive?: boolean }) => void;
	onVisibilityChange?: (visible: boolean) => void;
	onPersist?: () => void;
	onAddLayer?: () => void;
}

export interface LayersPanelOptions {
	closable?: boolean;
}

export type LayerDisplayItem = { kind: 'layer'; layer: Layer; index: number };
export type GroupDisplayItem = {
	kind: 'group';
	key: string;
	name: string;
	path: string[];
	items: DisplayItem[];
	layers: Layer[];
	group?: Layer;
};
export type DisplayItem = LayerDisplayItem | GroupDisplayItem;

/** Build the visual hierarchy while keeping the manager's compositing stack flat. */
export function buildLayerDisplayTree(layers: Layer[]): DisplayItem[] {
	if (layers.some(layer => layer.kind === 'group')) {
		const build = (parentId?: string, path: string[] = []): DisplayItem[] => layers
			.map((layer, index) => ({ layer, index }))
			.filter(item => (item.layer.parentId || undefined) === parentId)
			.reverse()
			.map(({ layer, index }) => {
				if (layer.kind !== 'group') { return { kind: 'layer', layer, index } as LayerDisplayItem; }
				const groupPath = [...path, layer.name || 'Group'];
				const items = build(layer.id, groupPath);
				const descendants: Layer[] = [];
				const collect = (children: DisplayItem[]) => children.forEach(child => {
					if (child.kind === 'layer') { descendants.push(child.layer); }
					else { if (child.group) { descendants.push(child.group); } collect(child.items); }
				});
				collect(items);
				return { kind: 'group', key: layer.id as string, name: layer.name || 'Group', path: groupPath, items, layers: descendants, group: layer } as GroupDisplayItem;
			});
		return build();
	}
	const rootItems: DisplayItem[] = [];
	const groups = new Map<string, GroupDisplayItem>();
	for (let i = layers.length - 1; i >= 0; i--) {
		const layer = layers[i];
		let items = rootItems;
		const path = layer.groupPath || [];
		const ids = layer.groupIds || [];
		for (let depth = 0; depth < path.length; depth++) {
			const key = ids[depth] || `group:${path.slice(0, depth + 1).join('/')}`;
			let group = groups.get(key);
			if (!group) {
				group = { kind: 'group', key, name: path[depth], path: path.slice(0, depth + 1), items: [], layers: [] };
				groups.set(key, group);
				items.push(group);
			}
			group.layers.push(layer);
			items = group.items;
		}
		items.push({ kind: 'layer', layer, index: i });
	}
	return rootItems;
}

export class LayersPanel {
	manager: LayerManager;
	onChange: (options?: { interactive?: boolean }) => void;
	onVisibilityChange?: (visible: boolean) => void;
	onPersist?: () => void;
	onAddLayer?: () => void;
	closable: boolean;
	root: HTMLElement | null;
	listEl: HTMLElement | null;
	titleEl: HTMLElement | null;
	minimizeBtn: HTMLButtonElement | null;
	groupsBtn: HTMLButtonElement | null;
	/** id of the layer currently armed for drag-to-move, or null */
	movingLayerId: string | null;
	/** id of the layer that needs a second remove click */
	_pendingRemoveId: string | null;
	_pendingRemoveTimer: ReturnType<typeof setTimeout> | null;
	collapsed: boolean;
	collapsedGroups: Set<string>;

	constructor(manager: LayerManager, callbacks: LayersPanelCallbacks, options: LayersPanelOptions = {}) {
		this.manager = manager;
		this.onChange = callbacks.onChange;
		this.onVisibilityChange = callbacks.onVisibilityChange;
		this.onPersist = callbacks.onPersist;
		this.onAddLayer = callbacks.onAddLayer;
		// In a dedicated Layers window the panel can't be closed (close the tab
		// instead); only the minimize control is shown.
		this.closable = options.closable !== false;
		this.root = null;
		this.listEl = null;
		this.titleEl = null;
		this.minimizeBtn = null;
		this.groupsBtn = null;
		this.movingLayerId = null;
		this._pendingRemoveId = null;
		this._pendingRemoveTimer = null;
		this.collapsed = false;
		this.collapsedGroups = new Set();
	}

	_clearPendingRemove(refresh = false): void {
		if (this._pendingRemoveTimer) {
			clearTimeout(this._pendingRemoveTimer);
			this._pendingRemoveTimer = null;
		}
		this._pendingRemoveId = null;
		if (refresh) { this.refresh(); }
	}

	/** Build the panel DOM (once) and attach it to the document body. */
	mount(): void {
		if (this.root) { return; }
		const root = document.createElement('div');
		root.className = 'layers-panel';
		root.setAttribute('hidden', '');

		const header = document.createElement('div');
		header.className = 'layers-panel-header';

		const title = document.createElement('span');
		title.className = 'layers-panel-title';
		title.textContent = 'Layers';
		this.titleEl = title;

		const addBtn = document.createElement('button');
		addBtn.className = 'layers-btn layers-add';
		addBtn.title = 'Add image(s) as layers';
		addBtn.textContent = '+';
		addBtn.addEventListener('click', () => this.onAddLayer?.());

		const minimizeBtn = document.createElement('button');
		minimizeBtn.className = 'layers-btn layers-minimize';
		minimizeBtn.title = 'Minimize / expand panel';
		minimizeBtn.textContent = '–';
		minimizeBtn.addEventListener('click', () => this.toggleCollapsed());
		this.minimizeBtn = minimizeBtn;

		const groupsBtn = document.createElement('button');
		groupsBtn.className = 'layers-btn layers-groups';
		groupsBtn.title = 'Collapse or expand all document groups';
		groupsBtn.textContent = '▦';
		groupsBtn.addEventListener('click', () => {
			const ids: string[] = [];
			const collect = (items: DisplayItem[]) => {
				for (const item of items) {
					if (item.kind !== 'group') { continue; }
					ids.push(item.key);
					collect(item.items);
				}
			};
			collect(buildLayerDisplayTree(this.manager.layers));
			if (this.collapsedGroups.size) { this.collapsedGroups.clear(); }
			else { for (const id of ids) { this.collapsedGroups.add(id); } }
			this.refresh(); this.onPersist?.();
		});
		this.groupsBtn = groupsBtn;

		header.appendChild(title);
		header.appendChild(addBtn);
		header.appendChild(groupsBtn);
		header.appendChild(minimizeBtn);
		if (this.closable) {
			const closeBtn = document.createElement('button');
			closeBtn.className = 'layers-btn layers-close';
			closeBtn.title = 'Close panel';
			closeBtn.textContent = '×';
			closeBtn.addEventListener('click', () => this.hide());
			header.appendChild(closeBtn);
		}

		const list = document.createElement('div');
		list.className = 'layers-list';

		root.appendChild(header);
		root.appendChild(list);
		document.body.appendChild(root);

		this.root = root;
		this.listEl = list;
		this._applyCollapsed();
		this.refresh();
	}

	isVisible(): boolean {
		return !!this.root && !this.root.hasAttribute('hidden');
	}

	toggle(): void {
		if (this.isVisible()) { this.hide(); } else { this.show(); }
	}

	show(options: { notify?: boolean } = {}): void {
		const wasVisible = this.isVisible();
		this.mount();
		this.root?.removeAttribute('hidden');
		this.refresh();
		if (!wasVisible && options.notify !== false) {
			this.onVisibilityChange?.(true);
		}
	}

	hide(): void {
		this.root?.setAttribute('hidden', '');
		this.movingLayerId = null;
		this.onVisibilityChange?.(false);
	}

	/** Collapse the panel to just its header (or expand it again). */
	toggleCollapsed(): void {
		this.collapsed = !this.collapsed;
		this._applyCollapsed();
		this.onPersist?.();
	}

	_applyCollapsed(): void {
		if (!this.root) { return; }
		this.root.classList.toggle('layers-panel--collapsed', this.collapsed);
		if (this.minimizeBtn) {
			this.minimizeBtn.textContent = this.collapsed ? '▸' : '–';
		}
		if (this.titleEl) {
			const n = this.manager.layers.length;
			this.titleEl.textContent = this.collapsed ? `Layers (${n})` : `Layers · ${n}`;
		}
		if (this.groupsBtn) { this.groupsBtn.disabled = !this.manager.layers.some(layer => layer.kind === 'group' || layer.groupPath?.length); }
	}

	/** Rebuild the layer rows from the manager state (top layer shown first). */
	refresh(): void {
		if (!this.listEl) { return; }
		this.listEl.textContent = '';
		const layers = this.manager.layers;
		const rootItems = buildLayerDisplayTree(layers);
		const fragment = document.createDocumentFragment();
		const render = (items: DisplayItem[], depth: number) => {
			for (const item of items) {
				if (item.kind === 'layer') { fragment.appendChild(this._buildRow(item.layer, item.index, depth)); continue; }
				fragment.appendChild(this._buildGroupRow(item, depth));
				if (!this.collapsedGroups.has(item.key)) { render(item.items, depth + 1); }
			}
		};
		render(rootItems, 0);
		this.listEl.appendChild(fragment);
		this._applyCollapsed(); // keep the collapsed "(n)" count in sync
	}

	_buildGroupRow(group: GroupDisplayItem, depth: number): HTMLElement {
		const row = document.createElement('div');
		row.className = 'layer-group-row';
		row.style.setProperty('--layer-depth', String(depth));
		row.title = group.path.join(' / ');

		const toggle = document.createElement('button');
		toggle.className = 'layer-group-toggle';
		toggle.textContent = this.collapsedGroups.has(group.key) ? '▸' : '▾';
		toggle.title = this.collapsedGroups.has(group.key) ? 'Expand group' : 'Collapse group';
		toggle.addEventListener('click', event => {
			event.stopPropagation();
			if (this.collapsedGroups.has(group.key)) { this.collapsedGroups.delete(group.key); }
			else { this.collapsedGroups.add(group.key); }
			this.refresh();
			this.onPersist?.();
		});
		row.appendChild(toggle);

		const targetLayers = group.group ? [group.group] : group.layers;
		const visibleCount = targetLayers.filter(layer => layer.visible !== false).length;
		const visibility = document.createElement('input');
		visibility.type = 'checkbox';
		visibility.className = 'layer-visible layer-group-visible';
		visibility.checked = visibleCount === targetLayers.length;
		visibility.indeterminate = visibleCount > 0 && visibleCount < targetLayers.length;
		visibility.title = 'Toggle all layers in this group (Shift-click to solo; Shift-click again to show all)';
		visibility.addEventListener('click', event => {
			if (!event.shiftKey) { return; }
			event.preventDefault(); event.stopPropagation();
			const ids = new Set([...(group.group ? [group.group] : []), ...group.layers].map(layer => layer.id as string));
			this.manager.toggleSoloLayers(ids);
			this.refresh(); this.onChange();
		});
		visibility.addEventListener('change', () => {
			const next = visibleCount !== targetLayers.length;
			for (const layer of targetLayers) { layer.visible = next; }
			this.refresh(); this.onChange();
		});
		row.appendChild(visibility);

		const name = document.createElement('span');
		name.className = 'layer-group-name';
		name.textContent = group.name;
		name.addEventListener('click', () => toggle.click());
		row.appendChild(name);

		const count = document.createElement('span');
		count.className = 'layer-group-count';
		count.textContent = String(group.layers.filter(layer => layer.kind !== 'group').length);
		row.appendChild(count);
		if (group.group) {
			const controls = document.createElement('div'); controls.className = 'layer-group-controls';
			const blend = document.createElement('select');
			blend.className = 'layer-blend layer-group-blend'; blend.title = 'Group blend mode';
			for (const mode of BLEND_MODES.filter(mode => !mode.mask)) {
				const option = document.createElement('option'); option.value = mode.id; option.textContent = mode.label;
				option.selected = (group.group.blendMode || 'normal') === mode.id; blend.appendChild(option);
			}
			blend.addEventListener('change', () => { this.manager.updateLayer(group.key, { blendMode: blend.value }); this.onChange(); });
			controls.appendChild(blend);
			const opacity = document.createElement('input'); opacity.type = 'range'; opacity.className = 'layer-opacity layer-group-opacity';
			opacity.min = '0'; opacity.max = '100'; opacity.dataset.defaultValue = '100'; opacity.value = String(Math.round((group.group.opacity ?? 1) * 100));
			opacity.title = 'Group opacity · Double-click to reset to 100%';
			opacity.addEventListener('input', () => { this.manager.updateLayer(group.key, { opacity: Number(opacity.value) / 100 }); this.onChange({ interactive: true }); });
			opacity.addEventListener('change', () => opacity.blur()); controls.appendChild(opacity);
			row.appendChild(controls);
		}
		return row;
	}

	/**
	 * @param index 0 = base/background.
	 */
	_buildRow(layer: Layer, index: number, depth = 0): HTMLElement {
		const id = layer.id as string;
		const isBase = index === 0 && !this.manager.documentExpanded;
		const row = document.createElement('div');
		row.className = 'layer-row' + (isBase ? ' layer-row-base' : '');
		row.dataset.id = id;
		row.style.setProperty('--layer-depth', String(depth));

		// Visibility toggle.
		const vis = document.createElement('input');
		vis.type = 'checkbox';
		vis.className = 'layer-visible';
		vis.checked = layer.visible !== false;
		vis.title = 'Toggle visibility (Shift-click to solo; Shift-click again to show all)';
		vis.addEventListener('click', (event) => {
			if (!event.shiftKey) { return; }
			event.preventDefault();
			event.stopPropagation();
			this._showOnlyLayer(id);
		});
		vis.addEventListener('change', () => {
			this.manager.updateLayer(id, { visible: vis.checked });
			this.onChange();
		});
		row.appendChild(vis);

		// Name, dimensions, and source-document compatibility.
		const titleLine = document.createElement('div');
		titleLine.className = 'layer-title-line';
		const name = document.createElement('span');
		name.className = 'layer-name';
		name.textContent = layer.name || id;
		name.title = `${layer.uri || layer.name || id}\nDouble-click to rename · Shift-click to show only`;
		name.addEventListener('dblclick', event => {
			event.preventDefault(); event.stopPropagation();
			const input = document.createElement('input');
			input.className = 'layer-name-input';
			input.value = layer.name || id;
			name.replaceWith(input);
			input.focus(); input.select();
			let committed = false;
			const commit = () => {
				if (committed) { return; }
				committed = true;
				const value = input.value.trim();
				if (value && value !== layer.name) {
					this.manager.updateLayer(id, { name: value });
					this.onPersist?.();
				}
				this.refresh();
			};
			input.addEventListener('blur', commit);
			input.addEventListener('keydown', keyEvent => {
				if (keyEvent.key === 'Enter') { input.blur(); }
				else if (keyEvent.key === 'Escape') { committed = true; this.refresh(); }
			});
		});
		titleLine.appendChild(name);

		const dimensions = document.createElement('span');
		dimensions.className = 'layer-dimensions';
		dimensions.textContent = `${layer.width}×${layer.height}`;
		titleLine.appendChild(dimensions);

		if (layer.sourceSupport && layer.sourceSupport !== 'native') {
			const badge = document.createElement('span');
			badge.className = `layer-support-badge layer-support-${layer.sourceSupport}`;
			badge.textContent = layer.sourceSupport === 'approximate' ? '≈' : layer.sourceSupport === 'cached-raster' ? 'cached' : layer.sourceSupport;
			badge.title = `Source compatibility: ${layer.sourceSupport}${layer.sourceBlendMode ? ` · ${layer.sourceBlendMode}` : ''}`;
			titleLine.appendChild(badge);
		} else if (this.manager.documentExpanded) {
			const badge = document.createElement('span');
			badge.className = 'layer-support-badge layer-support-native';
			badge.textContent = 'native';
			badge.title = 'This source layer is represented natively';
			titleLine.appendChild(badge);
		}
		row.appendChild(titleLine);

		row.addEventListener('click', (event) => {
			if (!event.shiftKey) { return; }
			const target = event.target as HTMLElement;
			if (target !== vis && target.closest('button, select, input')) { return; }
			event.preventDefault();
			this._showOnlyLayer(id);
		});

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
			const patch: Partial<Layer> = { blendMode: blend.value };
			if (blend.value === 'mask' && !layer.maskCondition) {
				patch.maskCondition = { op: 'gt', threshold: 0.5 };
			}
			this.manager.updateLayer(id, patch);
			this.refresh(); // show/hide the mask condition row
			this.onChange();
		});
		controls.appendChild(blend);

		const opacity = document.createElement('input');
		opacity.type = 'range';
		opacity.className = 'layer-opacity';
		opacity.min = '0';
		opacity.max = '100';
		opacity.dataset.defaultValue = '100';
		opacity.value = String(Math.round((layer.opacity ?? 1) * 100));
		opacity.title = 'Opacity · Double-click to reset to 100%';
		opacity.disabled = layer.blendMode === 'mask';
		const opacityValue = document.createElement('span');
		opacityValue.className = 'layer-opacity-value';
		opacityValue.textContent = `${opacity.value}%`;
		opacity.addEventListener('input', () => {
			this.manager.updateLayer(id, { opacity: Number(opacity.value) / 100 });
			opacityValue.textContent = `${opacity.value}%`;
			this.onChange({ interactive: true });
		});
		opacity.addEventListener('change', () => {
			this.manager.updateLayer(id, { opacity: Number(opacity.value) / 100 });
			this.onChange({ interactive: true });
			opacity.blur();
		});
		opacity.addEventListener('pointerup', () => opacity.blur());
		controls.appendChild(opacity);
		controls.appendChild(opacityValue);
		const clippingLabel = document.createElement('label');
		clippingLabel.className = 'layer-clipping';
		const clipping = document.createElement('input'); clipping.type = 'checkbox'; clipping.checked = !!layer.clipped;
		clipping.title = 'Clip this layer to the alpha of the nearest unclipped layer below';
		clipping.addEventListener('change', () => { this.manager.updateLayer(id, { clipped: clipping.checked }); this.onChange(); });
		clippingLabel.appendChild(clipping); clippingLabel.append(' Clip'); controls.appendChild(clippingLabel);
		if (layer.rasterMask) {
			const maskBadge = document.createElement('span'); maskBadge.className = 'layer-mask-badge';
			maskBadge.textContent = 'mask'; maskBadge.title = `${layer.rasterMask.width}×${layer.rasterMask.height} raster mask`;
			controls.appendChild(maskBadge);
		}
		row.appendChild(controls);

		// Mask condition row (only when this layer is a mask).
		if (layer.blendMode === 'mask') {
			row.appendChild(this._buildMaskRow(layer, id));
		}

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
		const pendingRemove = this._pendingRemoveId === id;
		remove.textContent = pendingRemove ? 'again' : '🗑';
		remove.title = pendingRemove ? 'Click again to remove this layer' : 'Remove layer';
		remove.classList.toggle('pending', pendingRemove);
		remove.addEventListener('click', () => {
			if (this._pendingRemoveId !== id) {
				this._clearPendingRemove(false);
				this._pendingRemoveId = id;
				remove.textContent = 'again';
				remove.title = 'Click again to remove this layer';
				remove.classList.add('pending');
				this._pendingRemoveTimer = setTimeout(() => {
					this._clearPendingRemove(true);
				}, 1600);
				return;
			}
			this._clearPendingRemove(false);
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
	 * Show only the selected layer and redraw the composite.
	 */
	_showOnlyLayer(id: string): void {
		this.manager.showOnlyLayer(id);
		this.refresh();
		this.onChange();
	}

	/**
	 * Build the mask condition row: "keep where  [op] [threshold]".
	 */
	_buildMaskRow(layer: Layer, id: string): HTMLElement {
		const cond = layer.maskCondition || { op: 'gt', threshold: 0.5 };
		const row = document.createElement('div');
		row.className = 'layer-mask';

		const label = document.createElement('span');
		label.className = 'layer-mask-label';
		label.textContent = 'keep where';
		row.appendChild(label);

		const opSel = document.createElement('select');
		opSel.className = 'layer-mask-op';
		opSel.title = 'Mask condition';
		for (const c of MASK_CONDITIONS) {
			const opt = document.createElement('option');
			opt.value = c.id;
			opt.textContent = c.label;
			if (cond.op === c.id) { opt.selected = true; }
			opSel.appendChild(opt);
		}
		row.appendChild(opSel);

		const thr = document.createElement('input');
		thr.type = 'number';
		thr.step = 'any';
		thr.className = 'layer-mask-threshold';
		thr.value = String(cond.threshold ?? 0.5);
		thr.title = 'Threshold';
		const meta = MASK_CONDITIONS.find(c => c.id === cond.op);
		if (meta && !meta.needsThreshold) { thr.style.display = 'none'; }
		row.appendChild(thr);

		const readCond = () => ({ op: opSel.value, threshold: parseFloat(thr.value) });
		opSel.addEventListener('change', () => {
			this.manager.updateLayer(id, { maskCondition: readCond() });
			this.refresh(); // show/hide threshold for is-finite / is-NaN
			this.onChange();
		});
		thr.addEventListener('input', () => {
			this.manager.updateLayer(id, { maskCondition: readCond() });
			this.onChange();
		});

		return row;
	}

	_offsetInput(value: number, onInput: (v: number) => void, title: string): HTMLInputElement {
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
