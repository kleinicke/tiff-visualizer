import type { Layer, LayerAdjustment } from './layer-compositor.js';

export interface XcfWriteResult { data: Uint8Array; warnings: string[]; }

class Writer {
	buffer = new Uint8Array(4096);
	length = 0;
	ensure(count: number) {
		if (this.length + count <= this.buffer.length) { return; }
		let size = this.buffer.length;
		while (size < this.length + count) { size *= 2; }
		const next = new Uint8Array(size); next.set(this.buffer); this.buffer = next;
	}
	u8(value: number) { this.ensure(1); this.buffer[this.length++] = value & 255; }
	u32(value: number) { this.ensure(4); new DataView(this.buffer.buffer).setUint32(this.length, value >>> 0, false); this.length += 4; }
	i32(value: number) { this.ensure(4); new DataView(this.buffer.buffer).setInt32(this.length, value | 0, false); this.length += 4; }
	f32(value: number) { this.ensure(4); new DataView(this.buffer.buffer).setFloat32(this.length, value, false); this.length += 4; }
	u64(value: number) {
		if (!Number.isSafeInteger(value) || value < 0) { throw new Error('XCF pointer exceeds the JavaScript safe integer range'); }
		this.ensure(8); const view = new DataView(this.buffer.buffer);
		view.setUint32(this.length, Math.floor(value / 0x1_0000_0000), false);
		view.setUint32(this.length + 4, value >>> 0, false); this.length += 8;
	}
	bytes(value: ArrayLike<number>) { this.ensure(value.length); for (let i = 0; i < value.length; i++) { this.buffer[this.length++] = value[i] & 255; } }
	string(value: string) { const encoded = new TextEncoder().encode(value); this.u32(encoded.length + 1); this.bytes(encoded); this.u8(0); }
	pointer(): number { const at = this.length; this.u64(0); return at; }
	patch(at: number, value: number) {
		if (!Number.isSafeInteger(value) || value < 0) { throw new Error('XCF pointer exceeds the JavaScript safe integer range'); }
		const view = new DataView(this.buffer.buffer);
		view.setUint32(at, Math.floor(value / 0x1_0000_0000), false);
		view.setUint32(at + 4, value >>> 0, false);
	}
	finish(): Uint8Array { return this.buffer.slice(0, this.length); }
}

const XCF_MODE: Record<string, number> = { normal: 0, multiply: 3, screen: 4, overlay: 5, difference: 6, darken: 9, lighten: 10 };

function propU32(writer: Writer, type: number, value: number) { writer.u32(type); writer.u32(4); writer.u32(value); }
function propOffsets(writer: Writer, x: number, y: number) { writer.u32(15); writer.u32(8); writer.i32(x); writer.i32(y); }
function propPath(writer: Writer, path: number[]) { writer.u32(30); writer.u32(path.length * 4); for (const value of path) { writer.u32(value); } }
function endProps(writer: Writer) { writer.u32(0); writer.u32(0); }

interface OrderedNode { layer: Layer; path: number[]; clipBase?: Layer; }

function orderedNodes(layers: Layer[]): OrderedNode[] {
	const output: OrderedNode[] = [];
	const walk = (parentId?: string, parentPath: number[] = []) => {
		const siblings = layers.filter(layer => (layer.parentId || undefined) === parentId).reverse();
		for (let index = 0; index < siblings.length; index++) {
			const layer = siblings[index];
			let resolvedClipBase: Layer | undefined;
			if (layer.clipped) {
				const managerIndex = layers.indexOf(layer);
				for (let candidate = managerIndex - 1; candidate >= 0; candidate--) {
					if ((layers[candidate].parentId || undefined) === (layer.parentId || undefined) && !layers[candidate].clipped) {
						resolvedClipBase = layers[candidate]; break;
					}
				}
			}
			output.push({ layer, path: [...parentPath, index], clipBase: resolvedClipBase });
			if (layer.kind === 'group' && layer.id) { walk(layer.id, [...parentPath, index]); }
		}
	};
	walk();
	return output;
}

function sourceAlpha(layer: Layer, canvasX: number, canvasY: number): number {
	if (!layer.data) { return 0; }
	const x = canvasX - Math.round(layer.offsetX || 0), y = canvasY - Math.round(layer.offsetY || 0);
	if (x < 0 || y < 0 || x >= layer.width || y >= layer.height) { return 0; }
	const base = (y * layer.width + x) * layer.channels;
	let alpha = layer.channels === 4 ? Number(layer.data[base + 3]) / (layer.typeMax || 255) : 1;
	const mask = layer.rasterMask;
	if (mask) {
		const mx = canvasX - Math.round(mask.offsetX ?? layer.offsetX ?? 0), my = canvasY - Math.round(mask.offsetY ?? layer.offsetY ?? 0);
		let factor = 0;
		if (mx >= 0 && my >= 0 && mx < mask.width && my < mask.height) {
			factor = Number(mask.data[(my * mask.width + mx) * Math.max(1, mask.channels || 1)]) / (mask.typeMax || 255);
		}
		alpha *= mask.invert ? 1 - factor : factor;
	}
	return Math.max(0, Math.min(1, alpha));
}

function rasterRgba(layer: Layer, clipBase: Layer | undefined, warnings: string[]): Uint8Array {
	const output = new Uint8Array(layer.width * layer.height * 4);
	const max = layer.typeMax || (layer.isFloat ? 1 : 255);
	if (layer.isFloat || max !== 255) { warnings.push(`“${layer.name || 'Layer'}” was converted to 8-bit using its declared value range`); }
	if (layer.rasterMask) { warnings.push(`“${layer.name || 'Layer'}” raster mask was baked into alpha`); }
	if (layer.clipped) { warnings.push(`“${layer.name || 'Layer'}” clipping was baked into alpha`); }
	for (let y = 0; y < layer.height; y++) for (let x = 0; x < layer.width; x++) {
		const source = (y * layer.width + x) * layer.channels, destination = (y * layer.width + x) * 4;
		const read = (channel: number) => Number(layer.data?.[source + Math.min(channel, layer.channels - 1)] || 0);
		const scale = (value: number) => Math.max(0, Math.min(255, Math.round(value * 255 / max)));
		if (layer.channels === 1) { const value = scale(read(0)); output[destination] = value; output[destination + 1] = value; output[destination + 2] = value; }
		else { output[destination] = scale(read(0)); output[destination + 1] = scale(read(1)); output[destination + 2] = scale(read(2)); }
		const canvasX = x + Math.round(layer.offsetX || 0), canvasY = y + Math.round(layer.offsetY || 0);
		let alpha = sourceAlpha(layer, canvasX, canvasY);
		if (clipBase) { alpha *= sourceAlpha(clipBase, canvasX, canvasY); }
		output[destination + 3] = Math.round(alpha * 255);
	}
	return output;
}

function writeHierarchy(writer: Writer, width: number, height: number, rgba: Uint8Array) {
	const hierarchy = writer.length;
	writer.u32(width); writer.u32(height); writer.u32(4);
	const levelPointer = writer.pointer(); writer.u64(0);
	writer.patch(levelPointer, writer.length);
	writer.u32(width); writer.u32(height);
	const tilesAcross = Math.ceil(width / 64), tilesDown = Math.ceil(height / 64);
	const tilePointers: number[] = [];
	for (let i = 0; i < tilesAcross * tilesDown; i++) { tilePointers.push(writer.pointer()); }
	writer.u64(0);
	for (let tileY = 0; tileY < tilesDown; tileY++) for (let tileX = 0; tileX < tilesAcross; tileX++) {
		const tile = tileY * tilesAcross + tileX; writer.patch(tilePointers[tile], writer.length);
		const tileWidth = Math.min(64, width - tileX * 64), tileHeight = Math.min(64, height - tileY * 64);
		for (let y = 0; y < tileHeight; y++) {
			const start = (((tileY * 64 + y) * width) + tileX * 64) * 4;
			writer.bytes(rgba.subarray(start, start + tileWidth * 4));
		}
	}
	return hierarchy;
}

interface XcfEffectArgument { name: string; type: 1 | 2 | 3 | 4 | 7; value: number | boolean | string; }
interface XcfEffect {
	name: string;
	operation: string;
	args: XcfEffectArgument[];
	visible?: boolean;
	opacity?: number;
}

function effectArgument(name: string, value: number | boolean | string, type: 1 | 2 | 3 | 4 | 7 = 3): XcfEffectArgument {
	return { name, value, type };
}

function preservedAdjustment(adjustment: LayerAdjustment): XcfEffectArgument {
	return effectArgument('tiff-visualizer-adjustment', JSON.stringify(adjustment), 4);
}

function xcfEffect(layer: Layer, warnings: string[]): XcfEffect | undefined {
	const adjustment = layer.adjustment;
	if (!adjustment) { return undefined; }
	const name = layer.name || adjustment.type;
	if (adjustment.type === 'brightness/contrast') {
		return { name, operation: 'gegl:brightness-contrast', args: [effectArgument('brightness', (adjustment.brightness || 0) / 100), effectArgument('contrast', (adjustment.contrast || 0) / 100)] };
	}
	if (adjustment.type === 'exposure') {
		if ((adjustment.gamma ?? 1) !== 1) { warnings.push(`“${name}” gamma is not represented by the GIMP exposure effect`); }
		return { name, operation: 'gegl:exposure', args: [effectArgument('exposure', adjustment.exposure || 0), effectArgument('black-level', -(adjustment.offset || 0))] };
	}
	if (adjustment.type === 'invert') { return { name, operation: 'gegl:invert-gamma', args: [] }; }
	if (adjustment.type === 'threshold') { return { name, operation: 'gegl:threshold', args: [effectArgument('value', (adjustment.level ?? 128) / 255)] }; }
	if (adjustment.type === 'posterize') { return { name, operation: 'gegl:posterize', args: [effectArgument('levels', adjustment.levels ?? 4, 1)] }; }
	if (adjustment.type === 'levels') {
		const rgb = !Array.isArray(adjustment.rgb) ? adjustment.rgb : undefined;
		if ((rgb?.midtoneInput ?? 1) !== 1) { warnings.push(`“${name}” gamma/midtone is not represented by the basic GIMP levels effect mapping`); }
		return {
			name, operation: 'gegl:levels', args: [
				effectArgument('in-low', (rgb?.shadowInput ?? 0) / 255), effectArgument('in-high', (rgb?.highlightInput ?? 255) / 255),
				effectArgument('out-low', (rgb?.shadowOutput ?? 0) / 255), effectArgument('out-high', (rgb?.highlightOutput ?? 255) / 255),
			],
		};
	}
	if (adjustment.type === 'hue/saturation') {
		const active = adjustment.colorizeEnabled !== false && adjustment.colorize;
		const values = adjustment.master || {};
		if (active) { warnings.push(`“${name}” colorize is preserved for TIFF Visualizer round trips; GIMP receives the non-colorize Hue/Chroma approximation`); }
		return {
			name, operation: 'gegl:hue-chroma', args: [
				effectArgument('hue', values.hue || 0), effectArgument('chroma', values.saturation || 0),
				effectArgument('lightness', values.lightness || 0), preservedAdjustment(adjustment),
			],
		};
	}
	if (adjustment.type === 'curves') {
		// GEGL expects an object-valued GeglCurve here. Keep an identity curve
		// for GIMP and preserve our complete curve model in a namespaced string
		// argument so TIFF Visualizer can round-trip every channel and point.
		warnings.push(`“${name}” curve points are preserved for TIFF Visualizer round trips; GIMP receives an identity Contrast Curve`);
		return {
			name, operation: 'gegl:contrast-curve',
			args: [effectArgument('sampling-points', 0, 1), preservedAdjustment(adjustment)],
		};
	}
	if (adjustment.type === 'channel mixer') {
		const args: XcfEffectArgument[] = [];
		for (const [prefix, values] of Object.entries({ r: adjustment.red, g: adjustment.green, b: adjustment.blue })) {
			if (!values) { continue; }
			args.push(effectArgument(`${prefix}r-gain`, values.red / 100), effectArgument(`${prefix}g-gain`, values.green / 100), effectArgument(`${prefix}b-gain`, values.blue / 100));
		}
		return { name, operation: adjustment.monochrome ? 'gegl:mono-mixer' : 'gegl:channel-mixer', args };
	}
	if (adjustment.type === 'black & white') {
		return {
			name, operation: 'gegl:mono-mixer', args: [
				effectArgument('red', (adjustment.reds ?? 40) / 100), effectArgument('green', (adjustment.greens ?? 40) / 100), effectArgument('blue', (adjustment.blues ?? 20) / 100),
			],
		};
	}
	if (adjustment.type === 'color balance') {
		const args: XcfEffectArgument[] = [];
		for (const range of ['shadows', 'midtones', 'highlights'] as const) {
			const values = adjustment[range] || {};
			args.push(effectArgument(`${range}-cyan-red`, (values.cyanRed || 0) / 100), effectArgument(`${range}-magenta-green`, (values.magentaGreen || 0) / 100), effectArgument(`${range}-yellow-blue`, (values.yellowBlue || 0) / 100));
		}
		args.push(effectArgument('preserve-luminosity', adjustment.preserveLuminosity !== false, 2));
		return { name, operation: 'gimp:color-balance', args };
	}
	warnings.push(`“${name}” (${adjustment.type}) has no GIMP 3 effect mapping and is represented only by other flattened exports`);
	return undefined;
}

function propFilterArgument(writer: Writer, argument: XcfEffectArgument): void {
	const name = new TextEncoder().encode(argument.name);
	const encodedValue = argument.type === 4 ? new TextEncoder().encode(String(argument.value)) : undefined;
	const valueLength = encodedValue ? 4 + encodedValue.length + 1 : 4;
	const payloadLength = 4 + name.length + 1 + 4 + valueLength;
	writer.u32(45); writer.u32(payloadLength); writer.string(argument.name); writer.u32(argument.type);
	if (argument.type === 3) { writer.f32(Number(argument.value)); }
	else if (argument.type === 1) { writer.i32(Number(argument.value)); }
	else if (argument.type === 4) { writer.string(String(argument.value)); }
	else { writer.u32(argument.type === 2 ? (argument.value ? 1 : 0) : Number(argument.value)); }
}

function writeEffect(writer: Writer, effect: XcfEffect): number {
	const pointer = writer.length;
	writer.string(effect.name); writer.string(''); writer.string(effect.operation); writer.string('');
	propU32(writer, 8, effect.visible === false ? 0 : 1);
	writer.u32(33); writer.u32(4); writer.f32(Math.max(0, Math.min(1, effect.opacity ?? 1)));
	propU32(writer, 44, 1);
	for (const argument of effect.args) { propFilterArgument(writer, argument); }
	endProps(writer);
	writer.u64(0); // effect mask
	return pointer;
}

/** Write an 8-bit GIMP 3 document using XCF v22 layer-effect structures. */
export function writeLayerStackAsXcf(layers: Layer[], canvasWidth: number, canvasHeight: number): XcfWriteResult {
	if (!canvasWidth || !canvasHeight) { throw new Error('Layer canvas has no dimensions'); }
	const warnings: string[] = [];
	const nodes = orderedNodes(layers).filter(node => node.layer.kind === 'group' || !!node.layer.data);
	const effectsByTarget = new Map<string, XcfEffect[]>();
	for (let index = 0; index < layers.length; index++) {
		const layer = layers[index];
		if (layer.kind !== 'adjustment' || !layer.adjustment) { continue; }
		let target: Layer | undefined;
		if (layer.clipped) {
			for (let candidate = index - 1; candidate >= 0; candidate--) {
				if ((layers[candidate].parentId || undefined) === (layer.parentId || undefined) && !layers[candidate].clipped) { target = layers[candidate]; break; }
			}
		}
		const effect = xcfEffect(layer, warnings);
		if (!target?.id || !effect) {
			if (!layer.clipped) { warnings.push(`“${layer.name || layer.adjustment.type}” is a free adjustment layer; GIMP effects must be attached to a drawable`); }
			continue;
		}
		effect.visible = layer.visible;
		effect.opacity = layer.opacity;
		const effects = effectsByTarget.get(target.id as string) || []; effects.push(effect); effectsByTarget.set(target.id as string, effects);
	}
	const writer = new Writer(); writer.bytes(new TextEncoder().encode('gimp xcf v022\0'));
	writer.u32(canvasWidth); writer.u32(canvasHeight); writer.u32(0); writer.u32(150);
	writer.u32(17); writer.u32(1); writer.u8(0); endProps(writer); // raw tile compression
	const layerPointers = nodes.map(() => writer.pointer()); writer.u64(0); writer.u64(0);
	for (let index = 0; index < nodes.length; index++) {
		const { layer, path, clipBase } = nodes[index]; writer.patch(layerPointers[index], writer.length);
		const isGroup = layer.kind === 'group';
		writer.u32(isGroup ? canvasWidth : layer.width); writer.u32(isGroup ? canvasHeight : layer.height); writer.u32(1);
		writer.string(layer.name || (isGroup ? 'Group' : `Layer ${index + 1}`));
		propU32(writer, 6, Math.round(Math.max(0, Math.min(1, layer.opacity ?? 1)) * 255));
		propU32(writer, 8, layer.visible === false ? 0 : 1);
		propOffsets(writer, isGroup ? 0 : Math.round(layer.offsetX || 0), isGroup ? 0 : Math.round(layer.offsetY || 0));
		const mode = XCF_MODE[layer.blendMode || 'normal'];
		propU32(writer, 7, mode ?? 0);
		if (mode === undefined && (layer.blendMode || 'normal') !== 'normal') { warnings.push(`“${layer.name || 'Layer'}” blend mode ${layer.blendMode} was exported as normal`); }
		if (isGroup) { writer.u32(29); writer.u32(0); }
		propPath(writer, path); endProps(writer);
		const hierarchyPointer = writer.pointer(); writer.u64(0);
		const effects = layer.id ? (effectsByTarget.get(layer.id as string) || []) : [];
		const effectPointers = effects.map(() => writer.pointer()); writer.u64(0);
		if (!isGroup && layer.data) {
			const rgba = rasterRgba(layer, clipBase, warnings);
			const hierarchy = writeHierarchy(writer, layer.width, layer.height, rgba); writer.patch(hierarchyPointer, hierarchy);
		} else if (layer.rasterMask) { warnings.push(`Group mask on “${layer.name || 'Group'}” was not exported`); }
		for (let effectIndex = 0; effectIndex < effects.length; effectIndex++) {
			writer.patch(effectPointers[effectIndex], writeEffect(writer, effects[effectIndex]));
		}
	}
	return { data: writer.finish(), warnings: [...new Set(warnings)] };
}
