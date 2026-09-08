import { openContextMenu, type MenuItem } from '../../ui/context-menu';
/**
 * LayersPanel — the in-preview DOM UI for the layer stack.
 *
 * Pure view/controller: it reads and mutates a LayerManager and calls back into
 * the host (imagePreview.js) to (a) re-composite + redraw on any change and
 * (b) request the extension to open a file picker for adding a layer.
 */

import { BLEND_MODES, MASK_CONDITIONS, Layer, LayerAdjustment, composite, evaluateCurvePoints } from './layer-compositor.js';
import type { LayerManager } from './layer-manager.js';
import type { LayerCompositorBackend, LayerCompositorBackendSelection } from './layer-compositor-worker-client.js';

export interface LayersPanelCallbacks {
	onChange: (options?: { interactive?: boolean; settled?: boolean }) => void;
	onBackgroundChange?: (brightness: number | null) => void;
	onVisibilityChange?: (visible: boolean) => void;
	onPersist?: () => void;
	onAddLayer?: () => void;
	onExport?: () => void;
	onCompositorBackendChange?: (backend: LayerCompositorBackendSelection) => void;
}

export interface LayersPanelOptions {
	closable?: boolean;
}

export { blendModePatch, adjustmentLabel, adjustmentSummary, clippingTarget, buildLayerDisplayTree } from './layer-panel-model.js';
import { adjustmentSummary, clippingTarget, buildLayerDisplayTree, type DisplayItem, type LayerDisplayItem, type GroupDisplayItem } from './layer-panel-model.js';
import Layers from '../../ui/components/Layers.svelte';
import { mountView } from '../../ui/mount.js';
const thumbnailBoundsCache = new WeakMap<object, { left: number; top: number; right: number; bottom: number }>();
export interface LayersModel { host: LayersPanel; tree: DisplayItem[]; revision: number; }
export class LayersPanel {
  private view: ReturnType<typeof mountView<LayersModel>> | null = null;
  private revision = 0;
	manager: LayerManager;
	onChange: (options?: { interactive?: boolean; settled?: boolean }) => void;
	onBackgroundChange?: (brightness: number | null) => void;
	onVisibilityChange?: (visible: boolean) => void;
	onPersist?: () => void;
	onAddLayer?: () => void;
	onExport?: () => void;
	onCompositorBackendChange?: (backend: LayerCompositorBackendSelection) => void;
	closable: boolean;
	root: HTMLElement | null;
	listEl: HTMLElement | null;
	titleEl: HTMLElement | null;
	minimizeBtn: HTMLButtonElement | null;
	groupsBtn: HTMLButtonElement | null;
	backgroundEl: HTMLElement | null;
	backgroundSlider: HTMLInputElement | null;
	backgroundBrightness: number | null;
	compositorBackend: LayerCompositorBackendSelection;
	resolvedCompositorBackend: LayerCompositorBackend = 'javascript';
	compositorSelect: HTMLSelectElement | null;
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
		this.onCompositorBackendChange = callbacks.onCompositorBackendChange;
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
		this.compositorBackend = 'auto';
		this.compositorSelect = null;
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
    this.view = mountView(Layers, { host: this, tree: buildLayerDisplayTree(this.manager.layers), revision: this.revision });

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

	setCompositorBackend(backend: LayerCompositorBackendSelection): void {
		this.compositorBackend = backend;
		if (this.compositorSelect) { this.compositorSelect.value = backend; }
	}

	setResolvedCompositorBackend(backend: LayerCompositorBackend): void {
		this.resolvedCompositorBackend = backend;
		const option = this.compositorSelect?.querySelector<HTMLOptionElement>('option[value="auto"]');
		if (option) {
			const labels: Record<LayerCompositorBackend, string> = {
				webgpu: 'WebGPU', gpu: 'WebGL', wasm: 'Wasm', javascript: 'JS',
			};
			option.textContent = `Auto (${labels[backend]})`;
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
			this.titleEl.textContent = `${n} layer${n === 1 ? '' : 's'}`;
		}
		if (this.groupsBtn) { this.groupsBtn.disabled = !this.manager.layers.some(layer => layer.kind === 'group' || layer.groupPath?.length); }
	}

	/** Rebuild the layer rows from the manager state (top layer shown first). */
  refresh(): void {
    if (!this.view) return;
    this.view.update({ host: this, tree: buildLayerDisplayTree(this.manager.layers), revision: ++this.revision });
    this._applyCollapsed();
  }
  toggleGroups(): void {
    const keys: string[] = [];
    const collect = (items: DisplayItem[]) => { for (const item of items) if (item.kind === 'group') { keys.push(item.key); collect(item.items); } };
    collect(buildLayerDisplayTree(this.manager.layers));
    if (this.collapsedGroups.size) this.collapsedGroups.clear();
    else for (const key of keys) this.collapsedGroups.add(key);
    this.refresh(); this.onPersist?.();
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

	_bindContinuousHistory(control: HTMLElement, onEnd?: () => void): void {
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
			onEnd?.();
		};
		control.addEventListener('pointerdown', begin);
		control.addEventListener('keydown', begin);
		control.addEventListener('input', begin);
		control.addEventListener('change', end);
		control.addEventListener('blur', end);
	}

	_openFilterCopyMenu(layer: Layer, id: string, anchor: HTMLButtonElement): void {
		const currentTarget = clippingTarget(this.manager.layers, this.manager.layers.indexOf(layer));
		const items: MenuItem[] = [...this.manager.layers].reverse()
			.filter(candidate => candidate.kind !== 'adjustment' && candidate.data && candidate.id)
			.map(candidate => ({
				label: `Copy filter to “${candidate.name || candidate.id}”${candidate === currentTarget ? ' (duplicate here)' : ''}`,
				action: () => {
					const targetId = candidate.id as string;
					const created = this.manager.copyAdjustmentLayer(id, targetId);
					if (!created) return;
					this.expandedEffectStacks.add(targetId);
					this.expandedAdjustments.add(created);
					this.refresh();
					this.onChange();
				},
			}));
		const bounds = anchor.getBoundingClientRect();
		openContextMenu(items, bounds.right, bounds.bottom + 2, 'layer-filter-copy-menu', true);
	}

	/**
	 * Show only the selected layer and redraw the composite.
	 */
	_showOnlyLayer(id: string): void {
		this.manager.showOnlyLayer(id);
		this.refresh();
		this.onChange();
	}

}
