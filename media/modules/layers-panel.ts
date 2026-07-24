/**
 * LayersPanel — the in-preview DOM UI for the layer stack.
 *
 * Pure view/controller: it reads and mutates a LayerManager and calls back into
 * the host (imagePreview.js) to (a) re-composite + redraw on any change and
 * (b) request the extension to open a file picker for adding a layer.
 */

import { BLEND_MODES, MASK_CONDITIONS, Layer, LayerAdjustment, composite, evaluateCurvePoints } from './layer-compositor.js';
import type { LayerManager } from './layer-manager.js';

export interface LayersPanelCallbacks {
	onChange: (options?: { interactive?: boolean }) => void;
	onBackgroundChange?: (brightness: number | null) => void;
	onVisibilityChange?: (visible: boolean) => void;
	onPersist?: () => void;
	onAddLayer?: () => void;
	onExport?: () => void;
}

export interface LayersPanelOptions {
	closable?: boolean;
}

export function blendModePatch(layer: Layer, nextMode: string): Partial<Layer> {
	const patch: Partial<Layer> = { blendMode: nextMode };
	if (nextMode === 'mask') {
		if (!layer.maskCondition) { patch.maskCondition = { op: 'gt', threshold: (layer.typeMax || 1) * 0.5 }; }
		patch.maskPreviousClipped = !!layer.clipped;
		patch.clipped = false;
	} else if (layer.blendMode === 'mask') {
		patch.clipped = layer.maskPreviousClipped ?? false;
		patch.maskPreviousClipped = undefined;
	}
	return patch;
}

export type LayerDisplayItem = { kind: 'layer'; layer: Layer; index: number; effects?: LayerDisplayItem[] };
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

const thumbnailBoundsCache = new WeakMap<object, { left: number; top: number; right: number; bottom: number }>();

function attachClippedAdjustments(items: DisplayItem[], layers: Layer[]): DisplayItem[] {
	const effectsByTarget = new Map<string, LayerDisplayItem[]>();
	for (let index = 0; index < layers.length; index++) {
		const layer = layers[index], target = layer.kind === 'adjustment' ? clippingTarget(layers, index) : undefined;
		if (!target?.id) { continue; }
		const effects = effectsByTarget.get(target.id as string) || [];
		effects.push({ kind: 'layer', layer, index }); effectsByTarget.set(target.id as string, effects);
	}
	const organize = (entries: DisplayItem[]): DisplayItem[] => {
		const output: DisplayItem[] = [];
		for (const item of entries) {
			if (item.kind === 'group') { output.push({ ...item, items: organize(item.items) }); continue; }
			if (item.layer.kind === 'adjustment' && clippingTarget(layers, item.index)) { continue; }
			const effects = item.layer.id ? effectsByTarget.get(item.layer.id as string) : undefined;
			output.push({ ...item, effects });
		}
		return output;
	};
	return organize(items);
}

export function adjustmentLabel(adjustment: LayerAdjustment | undefined): string {
	if (!adjustment) { return 'Adjustment'; }
	const labels: Record<LayerAdjustment['type'], string> = {
		levels: 'Levels', curves: 'Curves', 'hue/saturation': adjustment.type === 'hue/saturation' && adjustment.colorize && adjustment.colorizeEnabled !== false ? 'Hue/Saturation · Colorize' : 'Hue/Saturation',
		'brightness/contrast': 'Brightness/Contrast', exposure: 'Exposure', invert: 'Invert', 'channel mixer': 'Channel Mixer', 'color balance': 'Color Balance',
		'black & white': 'Black & White', threshold: 'Threshold', posterize: 'Posterize', 'gradient map': 'Gradient Map',
	};
	return labels[adjustment.type];
}

export function adjustmentSummary(adjustment: LayerAdjustment | undefined): string {
	if (!adjustment) { return 'No editable parameters'; }
	if (adjustment.type === 'levels') {
		const rgb = !Array.isArray(adjustment.rgb) ? adjustment.rgb : undefined;
		return `Input ${rgb?.shadowInput ?? 0}–${rgb?.highlightInput ?? 255} · γ ${(rgb?.midtoneInput ?? 1).toFixed(2)}`;
	}
	if (adjustment.type === 'curves') {
		const points = Array.isArray(adjustment.rgb) ? adjustment.rgb.length : 0;
		return `${points || 2} RGB control points`;
	}
	if (adjustment.type === 'hue/saturation') {
		const colorizeActive = !!adjustment.colorize && adjustment.colorizeEnabled !== false;
		const values = colorizeActive ? adjustment.colorize! : adjustment.master || {};
		return `${colorizeActive ? 'Colorize · ' : ''}H ${values.hue ?? 0}° · S ${values.saturation ?? 0} · L ${values.lightness ?? 0}`;
	}
	if (adjustment.type === 'brightness/contrast') { return `Brightness ${adjustment.brightness ?? 0} · Contrast ${adjustment.contrast ?? 0}`; }
	if (adjustment.type === 'exposure') { return `Exposure ${(adjustment.exposure ?? 0).toFixed(1)} EV · Gamma ${(adjustment.gamma ?? 1).toFixed(2)}`; }
	if (adjustment.type === 'invert') { return 'Invert RGB values'; }
	if (adjustment.type === 'channel mixer') { return adjustment.monochrome ? 'Monochrome channel mix' : 'RGB channel matrix'; }
	if (adjustment.type === 'color balance') { return adjustment.preserveLuminosity ? 'Preserve luminosity' : 'Independent channel balance'; }
	if (adjustment.type === 'black & white') { return 'Color-weighted grayscale'; }
	if (adjustment.type === 'threshold') { return `Threshold ${adjustment.level ?? 128}`; }
	if (adjustment.type === 'posterize') { return `${adjustment.levels ?? 4} levels per channel`; }
	return `${adjustment.stops?.length || 2} color stops${adjustment.reverse ? ' · reversed' : ''}`;
}

/** Find the unclipped sibling that owns a clipped node (manager order is bottom-to-top). */
export function clippingTarget(layers: Layer[], index: number): Layer | undefined {
	const layer = layers[index];
	if (!layer?.clipped) { return undefined; }
	for (let candidate = index - 1; candidate >= 0; candidate--) {
		const below = layers[candidate];
		if ((below.parentId || undefined) !== (layer.parentId || undefined)) { continue; }
		if (!below.clipped) { return below; }
	}
	return undefined;
}

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
		return attachClippedAdjustments(build(), layers);
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
	return attachClippedAdjustments(rootItems, layers);
}

export class LayersPanel {
	manager: LayerManager;
	onChange: (options?: { interactive?: boolean }) => void;
	onBackgroundChange?: (brightness: number | null) => void;
	onVisibilityChange?: (visible: boolean) => void;
	onPersist?: () => void;
	onAddLayer?: () => void;
	onExport?: () => void;
	closable: boolean;
	root: HTMLElement | null;
	listEl: HTMLElement | null;
	titleEl: HTMLElement | null;
	minimizeBtn: HTMLButtonElement | null;
	groupsBtn: HTMLButtonElement | null;
	backgroundEl: HTMLElement | null;
	backgroundSlider: HTMLInputElement | null;
	backgroundBrightness: number | null;
	themeBackgroundBrightness: number;
	/** id of the layer currently armed for drag-to-move, or null */
	movingLayerId: string | null;
	/** id of the layer that needs a second remove click */
	_pendingRemoveId: string | null;
	_pendingRemoveTimer: ReturnType<typeof setTimeout> | null;
	collapsed: boolean;
	collapsedGroups: Set<string>;
	expandedAdjustments: Set<string>;
	expandedEffectStacks: Set<string>;

	constructor(manager: LayerManager, callbacks: LayersPanelCallbacks, options: LayersPanelOptions = {}) {
		this.manager = manager;
		this.onChange = callbacks.onChange;
		this.onBackgroundChange = callbacks.onBackgroundChange;
		this.onVisibilityChange = callbacks.onVisibilityChange;
		this.onPersist = callbacks.onPersist;
		this.onAddLayer = callbacks.onAddLayer;
		this.onExport = callbacks.onExport;
		// In a dedicated Layers window the panel can't be closed (close the tab
		// instead); only the minimize control is shown.
		this.closable = options.closable !== false;
		this.root = null;
		this.listEl = null;
		this.titleEl = null;
		this.minimizeBtn = null;
		this.groupsBtn = null;
		this.backgroundEl = null;
		this.backgroundSlider = null;
		this.backgroundBrightness = null;
		this.themeBackgroundBrightness = 50;
		this.movingLayerId = null;
		this._pendingRemoveId = null;
		this._pendingRemoveTimer = null;
		this.collapsed = false;
		this.collapsedGroups = new Set();
		this.expandedAdjustments = new Set();
		this.expandedEffectStacks = new Set();
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

		const exportBtn = document.createElement('button');
		exportBtn.className = 'layers-btn layers-export';
		exportBtn.title = 'Export as PNG, ORA, XCF, KRA, or PSD';
		exportBtn.textContent = 'Export…';
		exportBtn.addEventListener('click', () => this.onExport?.());

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
		header.appendChild(exportBtn);
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
		const background = document.createElement('label');
		background.className = 'layers-background';
		const backgroundLabel = document.createElement('span');
		backgroundLabel.textContent = 'Background';
		const backgroundSlider = document.createElement('input');
		backgroundSlider.type = 'range';
		backgroundSlider.className = 'layers-background-slider';
		backgroundSlider.min = '0';
		backgroundSlider.max = '100';
		backgroundSlider.step = '1';
		backgroundSlider.dataset.defaultValue = String(this.themeBackgroundBrightness);
		backgroundSlider.value = String(this.backgroundBrightness ?? this.themeBackgroundBrightness);
		backgroundSlider.title = 'Preview background: darker to lighter while retaining the theme tint · Double-click to restore the VS Code theme background';
		backgroundSlider.addEventListener('input', () => {
			this.backgroundBrightness = Number(backgroundSlider.value);
			this.onBackgroundChange?.(this.backgroundBrightness);
		});
		// The shared range reset restores a numeric value. This control's true
		// default is instead the live VS Code theme colour, represented by null.
		backgroundSlider.addEventListener('dblclick', event => {
			event.preventDefault();
			event.stopPropagation();
			this.backgroundBrightness = null;
			backgroundSlider.value = String(this.themeBackgroundBrightness);
			this.onBackgroundChange?.(null);
		});
		background.append(backgroundLabel, backgroundSlider);
		this.backgroundEl = background;
		this.backgroundSlider = backgroundSlider;

		root.appendChild(header);
		root.appendChild(list);
		document.body.appendChild(root);

		this.root = root;
		this.listEl = list;
		window.addEventListener('keydown', event => {
			if (!this.isVisible() || event.key.toLowerCase() !== 'z' || (!event.ctrlKey && !event.metaKey) || event.altKey) { return; }
			const target = event.target as HTMLElement | null;
			// Preserve native text/number editing undo, but let the Layers
			// history shortcut work while a slider, checkbox, colour input, or
			// select still has focus after an edit.
			if (target?.matches('textarea, [contenteditable="true"], input:not([type="range"]):not([type="checkbox"]):not([type="color"])')) { return; }
			const redo = event.shiftKey;
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			// A focused custom editor owns Undo even when its local history is
			// empty; falling through would undo unrelated VS Code file actions.
			if (redo && this.manager.canRedo()) { this._redo(); }
			else if (!redo && this.manager.canUndo()) { this._undo(); }
		}, true);
		this._applyCollapsed();
		this.refresh();
	}

	_undo(): void {
		this._clearPendingRemove(false);
		if (!this.manager.undo()) { return; }
		this._afterHistoryRestore();
	}

	_redo(): void {
		this._clearPendingRemove(false);
		if (!this.manager.redo()) { return; }
		this._afterHistoryRestore();
	}

	private _afterHistoryRestore(): void {
		if (this.movingLayerId && !this.manager.layers.some(layer => layer.id === this.movingLayerId)) { this.movingLayerId = null; }
		this.refresh();
		this.onChange();
	}

	/** Keep the default thumb position aligned with the live editor theme. */
	setThemeBackgroundBrightness(brightness: number): void {
		this.themeBackgroundBrightness = Math.max(0, Math.min(100, Math.round(brightness)));
		if (!this.backgroundSlider) { return; }
		this.backgroundSlider.dataset.defaultValue = String(this.themeBackgroundBrightness);
		if (this.backgroundBrightness === null) {
			this.backgroundSlider.value = String(this.themeBackgroundBrightness);
		}
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
				if (item.kind === 'layer') {
					const effects = item.effects || [];
					fragment.appendChild(this._buildRow(item.layer, item.index, depth, false, effects));
					const ownsFilters = item.layer.kind !== 'adjustment' && !!item.layer.data;
					if (ownsFilters && this.expandedEffectStacks.has(item.layer.id as string)) {
						fragment.appendChild(this._buildFilterShelf(item.layer, depth));
						for (const effect of [...effects].reverse()) { fragment.appendChild(this._buildRow(effect.layer, effect.index, depth + 1, true)); }
					}
					continue;
				}
				fragment.appendChild(this._buildGroupRow(item, depth));
				if (!this.collapsedGroups.has(item.key)) { render(item.items, depth + 1); }
			}
		};
		render(rootItems, 0);
		this.listEl.appendChild(fragment);
		if (this.backgroundEl) { this.listEl.appendChild(this.backgroundEl); }
		this._applyCollapsed(); // keep the collapsed "(n)" count in sync
	}

	_buildFilterShelf(layer: Layer, depth: number): HTMLElement {
		const id = layer.id as string;
		const shelf = document.createElement('div'); shelf.className = 'layer-filter-shelf expanded';
		shelf.style.setProperty('--layer-depth', String(depth));
		const addFilter = document.createElement('select'); addFilter.className = 'layer-add-filter';
		addFilter.title = 'Add a non-destructive filter to this layer';
		for (const [value, label] of [
			['', '+ Add filter…'], ['levels', 'Levels'], ['curves', 'Curves'], ['hue/saturation', 'Hue/Saturation'],
			['brightness/contrast', 'Brightness/Contrast'], ['exposure', 'Exposure / Gamma'], ['invert', 'Invert'], ['channel mixer', 'Channel Mixer'],
			['color balance', 'Color Balance'], ['black & white', 'Black & White'], ['threshold', 'Threshold'], ['posterize', 'Posterize'], ['gradient map', 'Gradient Map'],
		]) {
			const option = document.createElement('option'); option.value = value; option.textContent = label; addFilter.appendChild(option);
		}
		addFilter.addEventListener('change', () => {
			if (!addFilter.value) { return; }
			const created = this.manager.addAdjustmentLayer(id, addFilter.value as LayerAdjustment['type']);
			if (created) { this.expandedAdjustments.add(created); }
			this.refresh(); this.onChange();
		});
		shelf.appendChild(addFilter);
		return shelf;
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
			this.manager.beginHistoryGroup();
			for (const layer of targetLayers) { this.manager.updateLayer(layer.id as string, { visible: next }); }
			this.manager.endHistoryGroup();
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
			this._bindContinuousHistory(opacity);
			opacity.addEventListener('input', () => { this.manager.updateLayer(group.key, { opacity: Number(opacity.value) / 100 }); this.onChange({ interactive: true }); });
			opacity.addEventListener('change', () => opacity.blur()); controls.appendChild(opacity);
			row.appendChild(controls);
		}
		return row;
	}

	_paintLayerThumbnail(canvas: HTMLCanvasElement, layer: Layer, effects: Layer[]): void {
		if (!layer.data || layer.width <= 0 || layer.height <= 0) { return; }
		const dataObject = layer.data as object;
		let bounds = thumbnailBoundsCache.get(dataObject);
		if (!bounds) {
			let left = 0, top = 0, right = layer.width, bottom = layer.height;
			if (layer.channels === 2 || layer.channels === 4) {
				left = layer.width; top = layer.height; right = 0; bottom = 0;
				for (let y = 0; y < layer.height; y++) for (let x = 0; x < layer.width; x++) {
					const alpha = Number(layer.data![(y * layer.width + x) * layer.channels + layer.channels - 1]);
					if (!(alpha > 0)) { continue; }
					left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
				}
				if (right <= left || bottom <= top) { left = 0; top = 0; right = layer.width; bottom = layer.height; }
			}
			bounds = { left, top, right, bottom }; thumbnailBoundsCache.set(dataObject, bounds);
		}
		const cropWidth = Math.max(1, bounds.right - bounds.left), cropHeight = Math.max(1, bounds.bottom - bounds.top);
		const scale = Math.min(44 / cropWidth, 44 / cropHeight);
		const width = Math.max(1, Math.round(cropWidth * scale)), height = Math.max(1, Math.round(cropHeight * scale));
		const pixels = new Uint8Array(width * height * 4), sourceMaximum = layer.typeMax || 255;
		for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
			const sourceX = Math.min(bounds.right - 1, bounds.left + Math.floor((x + 0.5) * cropWidth / width));
			const sourceY = Math.min(bounds.bottom - 1, bounds.top + Math.floor((y + 0.5) * cropHeight / height));
			const sourceOffset = (sourceY * layer.width + sourceX) * layer.channels, destination = (y * width + x) * 4;
			const value = (channel: number) => Math.max(0, Math.min(255, Math.round(Number(layer.data![sourceOffset + Math.min(channel, layer.channels - 1)]) * 255 / sourceMaximum)));
			if (layer.channels <= 2) { pixels[destination] = pixels[destination + 1] = pixels[destination + 2] = value(0); pixels[destination + 3] = layer.channels === 2 ? value(1) : 255; }
			else {
				pixels[destination] = value(0); pixels[destination + 1] = value(1); pixels[destination + 2] = value(2);
				pixels[destination + 3] = layer.channels === 4 ? value(3) : 255;
			}
		}
		const previewBase: Layer = { ...layer, data: pixels, width, height, channels: 4, typeMax: 255, offsetX: 0, offsetY: 0, opacity: 1, blendMode: 'normal', visible: true, rasterMask: undefined };
		const previewEffects: Layer[] = effects.map((effect): Layer => ({
			...effect, width: 1, height: 1, offsetX: 0, offsetY: 0, rasterMask: undefined as Layer['rasterMask'],
		}));
		const rendered = composite([previewBase, ...previewEffects], width, height);
		const context = canvas.getContext('2d'); if (!context) { return; }
		context.clearRect(0, 0, canvas.width, canvas.height);
		const image = context.createImageData(width, height);
		for (let pixel = 0; pixel < width * height; pixel++) {
			const source = pixel * rendered.channels, destination = pixel * 4;
			if (rendered.channels === 1) {
				const gray = Math.max(0, Math.min(255, Math.round(rendered.data[source])));
				image.data[destination] = image.data[destination + 1] = image.data[destination + 2] = gray; image.data[destination + 3] = 255;
			} else {
				image.data[destination] = Math.max(0, Math.min(255, Math.round(rendered.data[source])));
				image.data[destination + 1] = Math.max(0, Math.min(255, Math.round(rendered.data[source + 1])));
				image.data[destination + 2] = Math.max(0, Math.min(255, Math.round(rendered.data[source + 2])));
				image.data[destination + 3] = rendered.channels === 4 ? Math.max(0, Math.min(255, Math.round(rendered.data[source + 3]))) : 255;
			}
		}
		context.putImageData(image, Math.floor((canvas.width - width) / 2), Math.floor((canvas.height - height) / 2));
	}

	_refreshAdjustmentThumbnail(adjustmentLayer: Layer): void {
		const index = this.manager.layers.indexOf(adjustmentLayer), target = clippingTarget(this.manager.layers, index);
		if (!target?.id || !this.listEl) { return; }
		const targetIndex = this.manager.layers.indexOf(target), effects: Layer[] = [];
		for (let candidate = targetIndex + 1; candidate < this.manager.layers.length && this.manager.layers[candidate].clipped; candidate++) {
			if ((this.manager.layers[candidate].parentId || undefined) === (target.parentId || undefined)) { effects.push(this.manager.layers[candidate]); }
		}
		this.listEl.querySelectorAll<HTMLCanvasElement>('.layer-thumbnail').forEach(canvas => {
			if (canvas.dataset.layerId === target.id) { this._paintLayerThumbnail(canvas, target, effects); }
		});
	}

	_buildAdjustmentEditor(layer: Layer, id: string): HTMLElement {
		const details = document.createElement('details');
		details.className = 'layer-adjustment-editor';
		details.open = this.expandedAdjustments.has(id);
		details.addEventListener('toggle', () => {
			if (details.open) { this.expandedAdjustments.add(id); } else { this.expandedAdjustments.delete(id); }
		});
		const heading = document.createElement('summary');
		heading.className = 'layer-adjustment-summary';
		heading.textContent = adjustmentSummary(layer.adjustment);
		heading.title = 'Expand to edit this adjustment';
		details.appendChild(heading);

		const body = document.createElement('div');
		body.className = 'layer-adjustment-controls';
		details.appendChild(body);
		const commit = (adjustment: LayerAdjustment, interactive = true) => {
			this.manager.updateLayer(id, { adjustment });
			heading.textContent = adjustmentSummary(adjustment);
			this._refreshAdjustmentThumbnail(layer);
			this.onChange({ interactive });
		};

		if (layer.adjustment?.type === 'levels') {
			this._buildLevelsControls(layer, body, commit);
		} else if (layer.adjustment?.type === 'curves') {
			this._buildCurvesControls(layer, body, commit);
		} else if (layer.adjustment?.type === 'hue/saturation') {
			this._buildHueControls(layer, body, commit, () => this.refresh());
		} else if (layer.adjustment?.type === 'brightness/contrast' || layer.adjustment?.type === 'exposure') {
			this._buildToneControls(layer, body, commit);
		} else if (layer.adjustment?.type === 'channel mixer') {
			this._buildChannelMixerControls(layer, body, commit);
		} else if (layer.adjustment?.type === 'color balance') {
			this._buildColorBalanceControls(layer, body, commit);
		} else if (layer.adjustment?.type === 'black & white') {
			this._buildBlackWhiteControls(layer, body, commit);
		} else if (layer.adjustment?.type === 'threshold' || layer.adjustment?.type === 'posterize') {
			this._buildQuantizeControls(layer, body, commit);
		} else if (layer.adjustment?.type === 'gradient map') {
			this._buildGradientMapControls(layer, body, commit);
		} else if (layer.adjustment?.type === 'invert') {
			const note = document.createElement('div'); note.className = 'layer-adjustment-note'; note.textContent = 'No parameters — every RGB value is replaced by its inverse.'; body.appendChild(note);
		}
		const remove = document.createElement('button');
		remove.type = 'button';
		remove.className = 'layers-btn layer-filter-remove';
		remove.textContent = '×';
		remove.setAttribute('aria-label', 'Remove filter');
		remove.title = 'Remove this filter (can be undone)';
		remove.addEventListener('click', () => {
			this.expandedAdjustments.delete(id);
			this.manager.removeLayer(id);
			this.refresh();
			this.onChange();
		});
		body.appendChild(remove);
		return details;
	}

	_buildLevelsControls(layer: Layer, root: HTMLElement, commit: (adjustment: LayerAdjustment) => void): void {
		const channel = this._adjustmentChannelSelect();
		root.appendChild(this._labeledAdjustmentControl('Channel', channel));
		const controls = document.createElement('div');
		controls.className = 'layer-adjustment-channel-controls';
		root.appendChild(controls);
		const rebuild = () => {
			controls.textContent = '';
			const key = channel.value as 'rgb' | 'red' | 'green' | 'blue';
			const adjustment = layer.adjustment as Extract<LayerAdjustment, { type: 'levels' }>;
			const current = !Array.isArray(adjustment[key]) ? adjustment[key] as Record<string, number> | undefined : undefined;
			const update = (field: string, value: number) => {
				const latest = layer.adjustment as Extract<LayerAdjustment, { type: 'levels' }>;
				const existing = !Array.isArray(latest[key]) ? latest[key] as Record<string, number> | undefined : undefined;
				commit({ ...latest, [key]: { ...existing, [field]: value } });
			};
			controls.append(
				this._adjustmentRange('Black in', 0, 255, 1, current?.shadowInput ?? 0, 0, value => update('shadowInput', value)),
				this._adjustmentRange('Gamma', 0.1, 9.99, 0.01, current?.midtoneInput ?? 1, 1, value => update('midtoneInput', value), 2),
				this._adjustmentRange('White in', 0, 255, 1, current?.highlightInput ?? 255, 255, value => update('highlightInput', value)),
				this._adjustmentRange('Black out', 0, 255, 1, current?.shadowOutput ?? 0, 0, value => update('shadowOutput', value)),
				this._adjustmentRange('White out', 0, 255, 1, current?.highlightOutput ?? 255, 255, value => update('highlightOutput', value)),
			);
		};
		channel.addEventListener('change', rebuild);
		rebuild();
	}

	_buildCurvesControls(layer: Layer, root: HTMLElement, commit: (adjustment: LayerAdjustment, interactive?: boolean) => void): void {
		const channel = this._adjustmentChannelSelect();
		root.appendChild(this._labeledAdjustmentControl('Channel', channel));
		const svgNamespace = 'http://www.w3.org/2000/svg';
		const graph = document.createElementNS(svgNamespace, 'svg');
		graph.classList.add('layer-curve-graph'); graph.setAttribute('viewBox', '0 0 255 255');
		graph.setAttribute('role', 'img'); graph.setAttribute('aria-label', 'Editable tone curve');
		root.appendChild(graph);
		const pointsLabel = document.createElement('label');
		pointsLabel.className = 'layer-adjustment-field layer-adjustment-points';
		const caption = document.createElement('span'); caption.textContent = 'Points';
		const input = document.createElement('input'); input.type = 'text'; input.className = 'layer-adjustment-points-input';
		input.title = 'Comma-separated input:output control points, for example 0:0, 128:160, 255:255';
		const currentPoints = () => {
			const adjustment = layer.adjustment as Extract<LayerAdjustment, { type: 'curves' }>;
			const value = adjustment[channel.value as 'rgb' | 'red' | 'green' | 'blue'];
			return Array.isArray(value) && value.length ? value.map(point => ({ ...point })).sort((a, b) => a.input - b.input)
				: [{ input: 0, output: 0 }, { input: 255, output: 255 }];
		};
		const commitPoints = (points: { input: number; output: number }[], interactive = true) => {
			const adjustment = layer.adjustment as Extract<LayerAdjustment, { type: 'curves' }>;
			commit({ ...adjustment, [channel.value]: points }, interactive);
			render();
		};
		const pointerValue = (event: PointerEvent | MouseEvent) => {
			const bounds = graph.getBoundingClientRect();
			return {
				input: Math.max(0, Math.min(255, Math.round((event.clientX - bounds.left) / Math.max(1, bounds.width) * 255))),
				output: Math.max(0, Math.min(255, Math.round(255 - (event.clientY - bounds.top) / Math.max(1, bounds.height) * 255))),
			};
		};
		const render = () => {
			const points = currentPoints();
			input.value = points.map(point => `${point.input}:${point.output}`).join(', ');
			input.classList.remove('invalid');
			graph.textContent = '';
			const graphTitle = document.createElementNS(svgNamespace, 'title');
			graphTitle.textContent = 'Drag points · Double-click empty space to add · Double-click a point to remove'; graph.appendChild(graphTitle);
			const background = document.createElementNS(svgNamespace, 'rect');
			background.setAttribute('width', '255'); background.setAttribute('height', '255'); background.classList.add('layer-curve-background');
			graph.appendChild(background);
			for (const position of [63.75, 127.5, 191.25]) {
				for (const vertical of [true, false]) {
					const line = document.createElementNS(svgNamespace, 'line'); line.classList.add('layer-curve-grid');
					line.setAttribute('x1', String(vertical ? position : 0)); line.setAttribute('x2', String(vertical ? position : 255));
					line.setAttribute('y1', String(vertical ? 0 : position)); line.setAttribute('y2', String(vertical ? 255 : position)); graph.appendChild(line);
				}
			}
			const identity = document.createElementNS(svgNamespace, 'line'); identity.classList.add('layer-curve-identity');
			identity.setAttribute('x1', '0'); identity.setAttribute('y1', '255'); identity.setAttribute('x2', '255'); identity.setAttribute('y2', '0'); graph.appendChild(identity);
			const curve = document.createElementNS(svgNamespace, 'path'); curve.classList.add('layer-curve-path', `layer-curve-${channel.value}`);
			let path = '';
			for (let curveInput = 0; curveInput <= 255; curveInput = Math.min(255, curveInput + 2)) {
				const output = evaluateCurvePoints(points, curveInput);
				path += `${curveInput ? ' L' : 'M'} ${curveInput} ${255 - output}`;
				if (curveInput === 255) { break; }
			}
			curve.setAttribute('d', path); graph.appendChild(curve);
			points.forEach((point, pointIndex) => {
				const circle = document.createElementNS(svgNamespace, 'circle'); circle.classList.add('layer-curve-point', `layer-curve-${channel.value}`);
				circle.setAttribute('cx', String(point.input)); circle.setAttribute('cy', String(255 - point.output)); circle.setAttribute('r', '5');
				circle.setAttribute('tabindex', '0'); circle.setAttribute('aria-label', `Input ${point.input}, output ${point.output}`);
				circle.addEventListener('pointerdown', pointerDown => {
					pointerDown.preventDefault(); pointerDown.stopPropagation();
					this.manager.beginHistoryGroup();
					const move = (moveEvent: PointerEvent) => {
						const next = pointerValue(moveEvent), latest = currentPoints();
						const minimum = pointIndex === 0 ? 0 : latest[pointIndex - 1].input + 1;
						const maximum = pointIndex === latest.length - 1 ? 255 : latest[pointIndex + 1].input - 1;
						latest[pointIndex] = { input: Math.max(minimum, Math.min(maximum, next.input)), output: next.output };
						commitPoints(latest);
					};
					const up = () => {
						window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
						this.manager.endHistoryGroup(); this._applyCollapsed();
					};
					window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
				});
				circle.addEventListener('dblclick', doubleClick => {
					doubleClick.preventDefault(); doubleClick.stopPropagation();
					if (points.length <= 2) { return; }
					commitPoints(points.filter((_, index) => index !== pointIndex), false);
				});
				graph.appendChild(circle);
			});
		};
		graph.addEventListener('dblclick', event => {
			if ((event.target as Element).classList.contains('layer-curve-point')) { return; }
			const next = pointerValue(event), points = currentPoints();
			if (points.some(point => point.input === next.input)) { return; }
			points.push(next); points.sort((a, b) => a.input - b.input); commitPoints(points, false);
		});
		input.addEventListener('change', () => {
			const points = input.value.split(',').map(pair => pair.trim().split(':').map(Number))
				.filter(pair => pair.length === 2 && pair.every(Number.isFinite))
				.map(([pointInput, output]) => ({ input: Math.max(0, Math.min(255, pointInput)), output: Math.max(0, Math.min(255, output)) }))
				.sort((a, b) => a.input - b.input);
			if (points.length < 2) { input.classList.add('invalid'); return; }
			const adjustment = layer.adjustment as Extract<LayerAdjustment, { type: 'curves' }>;
			commit({ ...adjustment, [channel.value]: points }, false);
			render();
		});
		channel.addEventListener('change', render);
		pointsLabel.append(caption, input); root.appendChild(pointsLabel); render();
	}

	_buildHueControls(layer: Layer, root: HTMLElement, commit: (adjustment: LayerAdjustment) => void, refresh: () => void): void {
		const adjustment = layer.adjustment as Extract<LayerAdjustment, { type: 'hue/saturation' }>;
		const colorizeActive = !!adjustment.colorize && adjustment.colorizeEnabled !== false;
		const colorizeLabel = document.createElement('label'); colorizeLabel.className = 'layer-adjustment-colorize';
		colorizeLabel.title = 'Colorize assigns a hue and saturation to every pixel, including neutral grayscale. Off: rotate colors that already exist.';
		const colorize = document.createElement('input'); colorize.type = 'checkbox'; colorize.checked = colorizeActive;
		colorizeLabel.append(colorize, ' Colorize'); root.appendChild(colorizeLabel);
		colorize.addEventListener('change', () => {
			const latest = layer.adjustment as Extract<LayerAdjustment, { type: 'hue/saturation' }>;
			commit({ ...latest, colorizeEnabled: colorize.checked, colorize: latest.colorize || { hue: 0, saturation: 100, lightness: 0 } });
			refresh();
		});

		const channel = this._adjustmentChannelSelect(true);
		if (!colorizeActive) { root.appendChild(this._labeledAdjustmentControl('Range', channel)); }
		const settingsKey = () => colorizeActive ? 'colorize' : channel.value as keyof typeof adjustment;
		const readSettings = () => {
			const latest = layer.adjustment as Extract<LayerAdjustment, { type: 'hue/saturation' }>;
			return (latest[settingsKey()] || {}) as Record<string, number>;
		};
		const controls = document.createElement('div'); controls.className = 'layer-adjustment-channel-controls'; root.appendChild(controls);
		const rebuild = () => {
			controls.textContent = '';
			const settings = readSettings();
			const update = (field: string, value: number) => {
				const latest = layer.adjustment as Extract<LayerAdjustment, { type: 'hue/saturation' }>;
				const key = colorizeActive ? 'colorize' : channel.value;
				commit({ ...latest, [key]: { ...(latest[key as keyof typeof latest] as Record<string, number> || {}), [field]: value } });
			};
			controls.append(
				this._adjustmentRange('Hue (°)', -180, 180, 1, settings.hue ?? 0, 0, value => update('hue', value), 0, '°'),
				this._adjustmentRange('Saturation', colorizeActive ? 0 : -100, 100, 1, settings.saturation ?? (colorizeActive ? 100 : 0), colorizeActive ? 100 : 0, value => update('saturation', value)),
				this._adjustmentRange('Lightness', -100, 100, 1, settings.lightness ?? 0, 0, value => update('lightness', value)),
			);
		};
		channel.addEventListener('change', rebuild); rebuild();
	}

	_buildToneControls(layer: Layer, root: HTMLElement, commit: (adjustment: LayerAdjustment) => void): void {
		if (layer.adjustment?.type === 'brightness/contrast') {
			const update = (field: 'brightness' | 'contrast', value: number) => commit({ ...layer.adjustment as Extract<LayerAdjustment, { type: 'brightness/contrast' }>, [field]: value });
			root.append(
				this._adjustmentRange('Brightness', -100, 100, 1, layer.adjustment.brightness ?? 0, 0, value => update('brightness', value)),
				this._adjustmentRange('Contrast', -100, 100, 1, layer.adjustment.contrast ?? 0, 0, value => update('contrast', value)),
			);
			return;
		}
		const adjustment = layer.adjustment as Extract<LayerAdjustment, { type: 'exposure' }>;
		const update = (field: 'exposure' | 'offset' | 'gamma', value: number) => commit({ ...layer.adjustment as typeof adjustment, [field]: value });
		root.append(
			this._adjustmentRange('Exposure', -5, 5, 0.1, adjustment.exposure ?? 0, 0, value => update('exposure', value), 1, ' EV'),
			this._adjustmentRange('Offset', -0.5, 0.5, 0.01, adjustment.offset ?? 0, 0, value => update('offset', value), 2),
			this._adjustmentRange('Gamma', 0.1, 5, 0.01, adjustment.gamma ?? 1, 1, value => update('gamma', value), 2),
		);
	}

	_buildChannelMixerControls(layer: Layer, root: HTMLElement, commit: (adjustment: LayerAdjustment) => void): void {
		const adjustment = layer.adjustment as Extract<LayerAdjustment, { type: 'channel mixer' }>;
		const monochromeLabel = document.createElement('label'); monochromeLabel.className = 'layer-adjustment-colorize';
		const monochrome = document.createElement('input'); monochrome.type = 'checkbox'; monochrome.checked = !!adjustment.monochrome; monochromeLabel.append(monochrome, ' Monochrome'); root.appendChild(monochromeLabel);
		const output = document.createElement('select'); output.className = 'layer-adjustment-channel';
		for (const [value, label] of adjustment.monochrome ? [['gray', 'Gray']] : [['red', 'Red output'], ['green', 'Green output'], ['blue', 'Blue output']]) {
			const option = document.createElement('option'); option.value = value; option.textContent = label; output.appendChild(option);
		}
		root.appendChild(this._labeledAdjustmentControl('Output', output));
		const controls = document.createElement('div'); controls.className = 'layer-adjustment-channel-controls'; root.appendChild(controls);
		const rebuild = () => {
			controls.textContent = '';
			const latest = layer.adjustment as Extract<LayerAdjustment, { type: 'channel mixer' }>, key = output.value as 'red' | 'green' | 'blue' | 'gray';
			const defaults = key === 'red' ? { red: 100, green: 0, blue: 0, constant: 0 } : key === 'green' ? { red: 0, green: 100, blue: 0, constant: 0 }
				: key === 'blue' ? { red: 0, green: 0, blue: 100, constant: 0 } : { red: 40, green: 40, blue: 20, constant: 0 };
			const values = latest[key] || defaults;
			const update = (field: 'red' | 'green' | 'blue' | 'constant', value: number) => {
				const current = layer.adjustment as Extract<LayerAdjustment, { type: 'channel mixer' }>;
				commit({ ...current, [key]: { ...(current[key] || defaults), [field]: value } });
			};
			for (const field of ['red', 'green', 'blue', 'constant'] as const) controls.appendChild(this._adjustmentRange(field[0].toUpperCase() + field.slice(1), -200, 200, 1, values[field] ?? defaults[field], defaults[field], value => update(field, value), 0, '%'));
		};
		monochrome.addEventListener('change', () => { commit({ ...layer.adjustment as typeof adjustment, monochrome: monochrome.checked }); this.refresh(); });
		output.addEventListener('change', rebuild); rebuild();
	}

	_buildColorBalanceControls(layer: Layer, root: HTMLElement, commit: (adjustment: LayerAdjustment) => void): void {
		const adjustment = layer.adjustment as Extract<LayerAdjustment, { type: 'color balance' }>;
		const range = document.createElement('select'); range.className = 'layer-adjustment-channel';
		for (const value of ['shadows', 'midtones', 'highlights']) { const option = document.createElement('option'); option.value = value; option.textContent = value[0].toUpperCase() + value.slice(1); range.appendChild(option); }
		root.appendChild(this._labeledAdjustmentControl('Range', range));
		const preserveLabel = document.createElement('label'); preserveLabel.className = 'layer-adjustment-colorize';
		const preserve = document.createElement('input'); preserve.type = 'checkbox'; preserve.checked = adjustment.preserveLuminosity !== false; preserveLabel.append(preserve, ' Preserve luminosity'); root.appendChild(preserveLabel);
		const controls = document.createElement('div'); controls.className = 'layer-adjustment-channel-controls'; root.appendChild(controls);
		const rebuild = () => {
			controls.textContent = ''; const key = range.value as 'shadows' | 'midtones' | 'highlights';
			const values = (layer.adjustment as typeof adjustment)[key] || {};
			const update = (field: 'cyanRed' | 'magentaGreen' | 'yellowBlue', value: number) => {
				const latest = layer.adjustment as typeof adjustment; commit({ ...latest, [key]: { ...(latest[key] || {}), [field]: value } });
			};
			controls.append(
				this._adjustmentRange('Cyan ↔ Red', -100, 100, 1, values.cyanRed ?? 0, 0, value => update('cyanRed', value)),
				this._adjustmentRange('Magenta ↔ Green', -100, 100, 1, values.magentaGreen ?? 0, 0, value => update('magentaGreen', value)),
				this._adjustmentRange('Yellow ↔ Blue', -100, 100, 1, values.yellowBlue ?? 0, 0, value => update('yellowBlue', value)),
			);
		};
		preserve.addEventListener('change', () => commit({ ...layer.adjustment as typeof adjustment, preserveLuminosity: preserve.checked }));
		range.addEventListener('change', rebuild); rebuild();
	}

	_buildBlackWhiteControls(layer: Layer, root: HTMLElement, commit: (adjustment: LayerAdjustment) => void): void {
		const defaults = { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 };
		for (const field of Object.keys(defaults) as (keyof typeof defaults)[]) {
			const adjustment = layer.adjustment as Extract<LayerAdjustment, { type: 'black & white' }>;
			root.appendChild(this._adjustmentRange(field[0].toUpperCase() + field.slice(1), -200, 300, 1, adjustment[field] ?? defaults[field], defaults[field], value => {
				commit({ ...layer.adjustment as typeof adjustment, [field]: value });
			}, 0, '%'));
		}
	}

	_buildQuantizeControls(layer: Layer, root: HTMLElement, commit: (adjustment: LayerAdjustment) => void): void {
		if (layer.adjustment?.type === 'threshold') {
			root.appendChild(this._adjustmentRange('Threshold', 0, 255, 1, layer.adjustment.level ?? 128, 128, value => commit({ ...layer.adjustment as Extract<LayerAdjustment, { type: 'threshold' }>, level: value })));
		} else {
			const adjustment = layer.adjustment as Extract<LayerAdjustment, { type: 'posterize' }>;
			root.appendChild(this._adjustmentRange('Levels', 2, 32, 1, adjustment.levels ?? 4, 4, value => commit({ ...layer.adjustment as typeof adjustment, levels: value })));
		}
	}

	_buildGradientMapControls(layer: Layer, root: HTMLElement, commit: (adjustment: LayerAdjustment) => void): void {
		const adjustment = layer.adjustment as Extract<LayerAdjustment, { type: 'gradient map' }>;
		const stops = adjustment.stops?.length ? adjustment.stops : [{ position: 0, color: { r: 0, g: 0, b: 0 } }, { position: 1, color: { r: 255, g: 255, b: 255 } }];
		const toHex = (color: { r: number; g: number; b: number }) => `#${[color.r, color.g, color.b].map(value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`;
		const fromHex = (value: string) => ({ r: parseInt(value.slice(1, 3), 16), g: parseInt(value.slice(3, 5), 16), b: parseInt(value.slice(5, 7), 16) });
		const colors = document.createElement('div'); colors.className = 'layer-gradient-colors';
		for (const [label, index] of [['Dark', 0], ['Light', stops.length - 1]] as [string, number][]) {
			const input = document.createElement('input'); input.type = 'color'; input.value = toHex(stops[index].color); input.title = `${label} gradient color`;
			this._bindContinuousHistory(input);
			const field = this._labeledAdjustmentControl(label, input); colors.appendChild(field);
			input.addEventListener('input', () => { const latest = layer.adjustment as typeof adjustment, next = [...(latest.stops || stops)]; next[index] = { ...next[index], color: fromHex(input.value) }; commit({ ...latest, stops: next }); });
		}
		const reverseLabel = document.createElement('label'); reverseLabel.className = 'layer-adjustment-colorize';
		const reverse = document.createElement('input'); reverse.type = 'checkbox'; reverse.checked = !!adjustment.reverse; reverseLabel.append(reverse, ' Reverse');
		reverse.addEventListener('change', () => commit({ ...layer.adjustment as typeof adjustment, reverse: reverse.checked }));
		root.append(colors, reverseLabel);
	}

	_adjustmentChannelSelect(hueRanges = false): HTMLSelectElement {
		const select = document.createElement('select'); select.className = 'layer-adjustment-channel';
		const entries = hueRanges
			? [['master', 'Master'], ['reds', 'Reds'], ['yellows', 'Yellows'], ['greens', 'Greens'], ['cyans', 'Cyans'], ['blues', 'Blues'], ['magentas', 'Magentas']]
			: [['rgb', 'RGB'], ['red', 'Red'], ['green', 'Green'], ['blue', 'Blue']];
		for (const [value, label] of entries) { const option = document.createElement('option'); option.value = value; option.textContent = label; select.appendChild(option); }
		return select;
	}

	_labeledAdjustmentControl(label: string, control: HTMLElement): HTMLElement {
		const field = document.createElement('label'); field.className = 'layer-adjustment-field';
		const caption = document.createElement('span'); caption.textContent = label; field.append(caption, control); return field;
	}

	_bindContinuousHistory(control: HTMLElement): void {
		let active = false;
		const begin = () => {
			if (active) { return; }
			active = true;
			this.manager.beginHistoryGroup();
		};
		const end = () => {
			if (!active) { return; }
			active = false;
			this.manager.endHistoryGroup();
			this._applyCollapsed();
		};
		control.addEventListener('pointerdown', begin);
		control.addEventListener('keydown', begin);
		control.addEventListener('input', begin);
		control.addEventListener('change', end);
		control.addEventListener('blur', end);
	}

	_adjustmentRange(label: string, min: number, max: number, step: number, value: number, defaultValue: number, onInput: (value: number) => void, decimals = 0, suffix = ''): HTMLElement {
		const field = document.createElement('label'); field.className = 'layer-adjustment-range';
		const caption = document.createElement('span'); caption.textContent = label;
		const input = document.createElement('input'); input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
		input.value = String(value); input.dataset.defaultValue = String(defaultValue); input.title = `${label} · Double-click to reset`;
		const output = document.createElement('output'); output.textContent = `${Number(value).toFixed(decimals)}${suffix}`;
		this._bindContinuousHistory(input);
		input.addEventListener('input', () => { const next = Number(input.value); output.textContent = `${next.toFixed(decimals)}${suffix}`; onInput(next); });
		field.append(caption, input, output); return field;
	}

	_openFilterCopyMenu(layer: Layer, id: string, anchor: HTMLButtonElement): void {
		document.querySelector('.layer-filter-copy-menu')?.remove();
		const menu = document.createElement('div');
		menu.className = 'custom-context-menu layer-filter-copy-menu';
		menu.setAttribute('role', 'menu');
		const currentTarget = clippingTarget(this.manager.layers, this.manager.layers.indexOf(layer));
		for (const candidate of [...this.manager.layers].reverse()) {
			if (candidate.kind === 'adjustment' || !candidate.data || !candidate.id) { continue; }
			const item = document.createElement('button');
			item.type = 'button';
			item.className = 'context-menu-item';
			item.setAttribute('role', 'menuitem');
			item.textContent = `Copy filter to “${candidate.name || candidate.id}”${candidate === currentTarget ? ' (duplicate here)' : ''}`;
			item.addEventListener('click', event => {
				event.stopPropagation();
				const targetId = candidate.id as string;
				const created = this.manager.copyAdjustmentLayer(id, targetId);
				document.removeEventListener('pointerdown', close);
				menu.remove();
				if (!created) { return; }
				this.expandedEffectStacks.add(targetId);
				this.expandedAdjustments.add(created);
				this.refresh();
				this.onChange();
			});
			menu.appendChild(item);
		}
		document.body.appendChild(menu);
		const bounds = anchor.getBoundingClientRect();
		const menuBounds = menu.getBoundingClientRect();
		menu.style.left = `${Math.max(4, Math.min(window.innerWidth - menuBounds.width - 4, bounds.right - menuBounds.width))}px`;
		menu.style.top = `${Math.max(4, Math.min(window.innerHeight - menuBounds.height - 4, bounds.bottom + 2))}px`;
		const close = (event: PointerEvent) => {
			if (menu.contains(event.target as Node) || event.target === anchor) { return; }
			menu.remove();
			document.removeEventListener('pointerdown', close);
		};
		document.addEventListener('pointerdown', close);
	}

	/**
	 * @param index 0 = base/background.
	 */
	_buildRow(layer: Layer, index: number, depth = 0, nestedEffect = false, ownedEffects: LayerDisplayItem[] = []): HTMLElement {
		const id = layer.id as string;
		const isBase = index === 0 && !this.manager.documentExpanded;
		const isAdjustment = layer.kind === 'adjustment' && !!layer.adjustment;
		const target = clippingTarget(this.manager.layers, index);
		const row = document.createElement('div');
		row.className = 'layer-row' + (isBase ? ' layer-row-base' : '') + (isAdjustment ? ' layer-row-adjustment' : '') + (layer.clipped ? ' layer-row-clipped' : '') + (nestedEffect ? ' layer-row-filter-child' : '');
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
		if (!isAdjustment && layer.data) {
			const thumbnail = document.createElement('canvas'); thumbnail.className = 'layer-thumbnail';
			thumbnail.width = 48; thumbnail.height = 48; thumbnail.dataset.layerId = id;
			thumbnail.title = 'Layer content with its filters applied';
			titleLine.appendChild(thumbnail);
			this._paintLayerThumbnail(thumbnail, layer, ownedEffects.map(effect => effect.layer));
		}
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

		if (isAdjustment) {
			const typeBadge = document.createElement('span');
			typeBadge.className = 'layer-adjustment-badge';
			typeBadge.textContent = adjustmentLabel(layer.adjustment);
			typeBadge.title = 'Non-destructive adjustment layer';
			titleLine.appendChild(typeBadge);
		} else {
			const dimensions = document.createElement('span');
			dimensions.className = 'layer-dimensions';
			dimensions.textContent = `${layer.width}×${layer.height}`;
			titleLine.appendChild(dimensions);
		}

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
			this.manager.updateLayer(id, blendModePatch(layer, blend.value));
			this.refresh(); // show/hide the mask condition row
			this.onChange();
		});
		if (!isAdjustment) { controls.appendChild(blend); }

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
		this._bindContinuousHistory(opacity);
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
		if (isAdjustment) {
			const strength = document.createElement('span');
			strength.className = 'layer-adjustment-strength-label';
			strength.textContent = 'Strength';
			controls.appendChild(strength);
		}
		controls.appendChild(opacity);
		controls.appendChild(opacityValue);
		row.appendChild(controls);

		const clippingLabel = document.createElement('label');
		clippingLabel.className = 'layer-clipping';
		const clipping = document.createElement('input'); clipping.type = 'checkbox'; clipping.checked = !!layer.clipped;
		clipping.title = target ? `Applied only to “${target.name || target.id}”` : 'Clip this layer to the nearest unclipped layer below';
		clipping.addEventListener('change', () => { this.manager.updateLayer(id, { clipped: clipping.checked }); this.refresh(); this.onChange(); });
		clippingLabel.appendChild(clipping); clippingLabel.append(layer.clipped ? ' Clipped' : ' Clip');
		let maskBadge: HTMLSpanElement | null = null;
		if (layer.rasterMask) {
			maskBadge = document.createElement('span'); maskBadge.className = 'layer-mask-badge';
			maskBadge.textContent = 'mask'; maskBadge.title = `${layer.rasterMask.width}×${layer.rasterMask.height} raster mask`;
		}

		if (isAdjustment) {
			if (!nestedEffect) {
				const scope = document.createElement('div'); scope.className = 'layer-adjustment-scope';
				const scopeText = document.createElement('span'); scopeText.className = 'layer-adjustment-target';
				scopeText.textContent = layer.clipped ? target ? `Applied to “${target.name || target.id}”` : 'Clipped, but no base layer was found' : 'Applied to the composite below';
				scope.append(scopeText, clippingLabel); if (maskBadge) { scope.appendChild(maskBadge); maskBadge = null; } row.appendChild(scope);
			}
			row.appendChild(this._buildAdjustmentEditor(layer, id));
		}

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
		if (!isAdjustment && layer.blendMode !== 'mask') { pos.appendChild(clippingLabel); }
		if (maskBadge) { pos.appendChild(maskBadge); }
		if (!isAdjustment) { row.appendChild(pos); }

		// Reorder + remove.
		const actions = document.createElement('div');
		actions.className = 'layer-actions';
		if (!nestedEffect && !isAdjustment && layer.data) {
			const filtersExpanded = this.expandedEffectStacks.has(id);
			const filterToggle = document.createElement('button'); filterToggle.type = 'button';
			filterToggle.className = 'layers-btn layer-filter-toggle-inline';
			filterToggle.textContent = `${filtersExpanded ? '▾' : '▸'} Filters${ownedEffects.length ? ` (${ownedEffects.length})` : ''}`;
			filterToggle.title = filtersExpanded ? 'Hide filters applied to this layer' : 'Show and add filters for this layer';
			filterToggle.addEventListener('click', () => {
				if (filtersExpanded) { this.expandedEffectStacks.delete(id); } else { this.expandedEffectStacks.add(id); }
				this.refresh();
			});
			actions.appendChild(filterToggle);
		}

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

		let duplicate: HTMLButtonElement | null = null;
		if (!nestedEffect && !isAdjustment && layer.data) {
			duplicate = document.createElement('button');
			duplicate.className = 'layers-btn';
			duplicate.textContent = '⧉';
			duplicate.title = 'Duplicate this layer with all attached filters';
			duplicate.setAttribute('aria-label', 'Duplicate layer with filters');
			duplicate.addEventListener('click', () => {
				const copyId = this.manager.duplicateLayerWithAdjustments(id);
				if (copyId && this.expandedEffectStacks.has(id)) { this.expandedEffectStacks.add(copyId); }
				this.refresh();
				this.onChange();
			});
		} else if (isAdjustment && layer.adjustment) {
			duplicate = document.createElement('button');
			duplicate.className = 'layers-btn';
			duplicate.textContent = '⧉';
			duplicate.title = 'Copy this filter to an image layer';
			duplicate.setAttribute('aria-label', 'Copy filter to layer');
			duplicate.addEventListener('click', event => {
				event.stopPropagation();
				this._openFilterCopyMenu(layer, id, duplicate as HTMLButtonElement);
			});
		}

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

		if (duplicate) { actions.appendChild(duplicate); }
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
		const cond = layer.maskCondition || { op: 'gt', threshold: (layer.typeMax || 1) * 0.5 };
		const row = document.createElement('div');
		row.className = 'layer-mask';

		const label = document.createElement('span');
		label.className = 'layer-mask-label';
		label.textContent = 'Show layer where mask is';
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
		thr.min = '0'; thr.max = String(layer.typeMax || 1);
		thr.className = 'layer-mask-threshold';
		thr.value = String(cond.threshold ?? (layer.typeMax || 1) * 0.5);
		thr.title = 'Threshold';
		const meta = MASK_CONDITIONS.find(c => c.id === cond.op);
		if (meta && !meta.needsThreshold) { thr.style.display = 'none'; }
		row.appendChild(thr);
		this._bindContinuousHistory(thr);

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
