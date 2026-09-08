import type { Layer, LayerAdjustment } from './layer-compositor.js';

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

