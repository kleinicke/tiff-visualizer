/**
 * LayersPanel — the in-preview DOM UI for the layer stack.
 *
 * Pure view/controller: it reads and mutates a LayerManager and calls back into
 * the host (imagePreview.js) to (a) re-composite + redraw on any change and
 * (b) request the extension to open a file picker for adding a layer.
 */

import { BLEND_MODES, MASK_CONDITIONS, Layer, LayerAdjustment, evaluateCurvePoints } from './layer-compositor.js';
import type { LayerManager } from './layer-manager.js';

export interface LayersPanelCallbacks {
	onChange: (options?: { interactive?: boolean }) => void;
	onBackgroundChange?: (brightness: number | null) => void;
	onVisibilityChange?: (visible: boolean) => void;
	onPersist?: () => void;
	onAddLayer?: () => void;
	onExportPng?: () => void;
	onExportXcf?: () => void;
}

export interface LayersPanelOptions {
	closable?: boolean;
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
	if (adjustment.type === 'levels') { return 'Levels'; }
	if (adjustment.type === 'curves') { return 'Curves'; }
	return adjustment.colorize && adjustment.colorizeEnabled !== false ? 'Hue/Saturation · Colorize' : 'Hue/Saturation';
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
	const colorizeActive = !!adjustment.colorize && adjustment.colorizeEnabled !== false;
	const values = colorizeActive ? adjustment.colorize! : adjustment.master || {};
	return `${colorizeActive ? 'Colorize · ' : ''}H ${values.hue ?? 0}° · S ${values.saturation ?? 0} · L ${values.lightness ?? 0}`;
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
	onExportPng?: () => void;
	onExportXcf?: () => void;
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
		this.onExportPng = callbacks.onExportPng;
		this.onExportXcf = callbacks.onExportXcf;
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
		exportBtn.className = 'layers-btn layers-export-png';
		exportBtn.title = 'Export the current rendered composition as PNG';
		exportBtn.textContent = 'PNG';
		exportBtn.addEventListener('click', () => this.onExportPng?.());
		const exportXcfBtn = document.createElement('button');
		exportXcfBtn.className = 'layers-btn layers-export-xcf';
		exportXcfBtn.title = 'Save a new layered XCF (limited 8-bit interchange export)';
		exportXcfBtn.textContent = 'XCF';
		exportXcfBtn.addEventListener('click', () => this.onExportXcf?.());

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
		header.appendChild(exportXcfBtn);
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
		this._applyCollapsed();
		this.refresh();
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
					fragment.appendChild(this._buildRow(item.layer, item.index, depth));
					const ownsFilters = item.layer.kind !== 'adjustment' && !!item.layer.data;
					if (ownsFilters) { fragment.appendChild(this._buildFilterShelf(item.layer, item.effects || [], depth)); }
					if (ownsFilters && this.expandedEffectStacks.has(item.layer.id as string)) {
						for (const effect of [...(item.effects || [])].reverse()) { fragment.appendChild(this._buildRow(effect.layer, effect.index, depth + 1, true)); }
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

	_buildFilterShelf(layer: Layer, effects: LayerDisplayItem[], depth: number): HTMLElement {
		const id = layer.id as string, expanded = this.expandedEffectStacks.has(id);
		const shelf = document.createElement('div'); shelf.className = 'layer-filter-shelf' + (expanded ? ' expanded' : '');
		shelf.style.setProperty('--layer-depth', String(depth));
		const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'layer-filter-shelf-toggle';
		toggle.textContent = `${expanded ? '▾' : '▸'} Filters${effects.length ? ` (${effects.length})` : ''}`;
		toggle.title = expanded ? 'Hide filters applied to this layer' : 'Show filters applied to this layer';
		toggle.addEventListener('click', () => {
			if (expanded) { this.expandedEffectStacks.delete(id); } else { this.expandedEffectStacks.add(id); }
			this.refresh();
		});
		shelf.appendChild(toggle);
		if (expanded) {
			const addFilter = document.createElement('select'); addFilter.className = 'layer-add-filter';
			addFilter.title = 'Add a non-destructive filter to this layer';
			for (const [value, label] of [['', '+ Add filter…'], ['levels', 'Levels'], ['curves', 'Curves'], ['hue/saturation', 'Hue/Saturation']]) {
				const option = document.createElement('option'); option.value = value; option.textContent = label; addFilter.appendChild(option);
			}
			addFilter.addEventListener('change', () => {
				if (!addFilter.value) { return; }
				const created = this.manager.addAdjustmentLayer(id, addFilter.value as LayerAdjustment['type']);
				if (created) { this.expandedAdjustments.add(created); }
				this.refresh(); this.onChange();
			});
			shelf.appendChild(addFilter);
		}
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
			layer.adjustment = adjustment;
			this.manager.updateLayer(id, { adjustment });
			heading.textContent = adjustmentSummary(adjustment);
			this.onChange({ interactive });
		};

		if (layer.adjustment?.type === 'levels') {
			this._buildLevelsControls(layer, body, commit);
		} else if (layer.adjustment?.type === 'curves') {
			this._buildCurvesControls(layer, body, commit);
		} else if (layer.adjustment?.type === 'hue/saturation') {
			this._buildHueControls(layer, body, commit, () => this.refresh());
		}
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
					const move = (moveEvent: PointerEvent) => {
						const next = pointerValue(moveEvent), latest = currentPoints();
						const minimum = pointIndex === 0 ? 0 : latest[pointIndex - 1].input + 1;
						const maximum = pointIndex === latest.length - 1 ? 255 : latest[pointIndex + 1].input - 1;
						latest[pointIndex] = { input: Math.max(minimum, Math.min(maximum, next.input)), output: next.output };
						commitPoints(latest);
					};
					const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
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

	_adjustmentRange(label: string, min: number, max: number, step: number, value: number, defaultValue: number, onInput: (value: number) => void, decimals = 0, suffix = ''): HTMLElement {
		const field = document.createElement('label'); field.className = 'layer-adjustment-range';
		const caption = document.createElement('span'); caption.textContent = label;
		const input = document.createElement('input'); input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
		input.value = String(value); input.dataset.defaultValue = String(defaultValue); input.title = `${label} · Double-click to reset`;
		const output = document.createElement('output'); output.textContent = `${Number(value).toFixed(decimals)}${suffix}`;
		input.addEventListener('input', () => { const next = Number(input.value); output.textContent = `${next.toFixed(decimals)}${suffix}`; onInput(next); });
		field.append(caption, input, output); return field;
	}

	/**
	 * @param index 0 = base/background.
	 */
	_buildRow(layer: Layer, index: number, depth = 0, nestedEffect = false): HTMLElement {
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
			const patch: Partial<Layer> = { blendMode: blend.value };
			if (blend.value === 'mask' && !layer.maskCondition) {
				patch.maskCondition = { op: 'gt', threshold: 0.5 };
			}
			this.manager.updateLayer(id, patch);
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
			const scope = document.createElement('div');
			scope.className = 'layer-adjustment-scope';
			const scopeText = document.createElement('span');
			scopeText.className = 'layer-adjustment-target';
			scopeText.textContent = layer.clipped
				? target ? `↳ Applied to “${target.name || target.id}”` : '↳ Clipped, but no base layer was found'
				: '↓ Applied to the composite below';
			scopeText.title = layer.clipped
				? target ? `This adjustment is evaluated on ${target.name || target.id} before that layer is blended` : 'Move this adjustment directly above a raster or group base'
				: 'This adjustment changes all visible content below it in the current group';
			scope.appendChild(scopeText);
			if (!nestedEffect) { scope.appendChild(clippingLabel); }
			if (maskBadge) { scope.appendChild(maskBadge); maskBadge = null; }
			row.appendChild(scope);
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
		if (!isAdjustment) { pos.appendChild(clippingLabel); }
		if (maskBadge) { pos.appendChild(maskBadge); }
		if (!isAdjustment) { row.appendChild(pos); }

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
