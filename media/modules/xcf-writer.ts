import type { Layer } from './layer-compositor.js';

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
	bytes(value: ArrayLike<number>) { this.ensure(value.length); for (let i = 0; i < value.length; i++) { this.buffer[this.length++] = value[i] & 255; } }
	string(value: string) { const encoded = new TextEncoder().encode(value); this.u32(encoded.length + 1); this.bytes(encoded); this.u8(0); }
	pointer(): number { const at = this.length; this.u32(0); return at; }
	patch(at: number, value: number) { new DataView(this.buffer.buffer).setUint32(at, value >>> 0, false); }
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
		let clipBase: Layer | undefined;
		for (let index = 0; index < siblings.length; index++) {
			const layer = siblings[index];
			output.push({ layer, path: [...parentPath, index], clipBase: layer.clipped ? clipBase : undefined });
			if (!layer.clipped) { clipBase = layer; }
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
	const levelPointer = writer.pointer(); writer.u32(0);
	writer.patch(levelPointer, writer.length);
	writer.u32(width); writer.u32(height);
	const tilesAcross = Math.ceil(width / 64), tilesDown = Math.ceil(height / 64);
	const tilePointers: number[] = [];
	for (let i = 0; i < tilesAcross * tilesDown; i++) { tilePointers.push(writer.pointer()); }
	writer.u32(0);
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

/** Write the editable stack as a conservative GIMP XCF v3, always to a new file. */
export function writeLayerStackAsXcf(layers: Layer[], canvasWidth: number, canvasHeight: number): XcfWriteResult {
	if (!canvasWidth || !canvasHeight) { throw new Error('Layer canvas has no dimensions'); }
	const warnings: string[] = [];
	const nodes = orderedNodes(layers).filter(node => node.layer.kind === 'group' || !!node.layer.data);
	const writer = new Writer(); writer.bytes(new TextEncoder().encode('gimp xcf v003\0'));
	writer.u32(canvasWidth); writer.u32(canvasHeight); writer.u32(0);
	writer.u32(17); writer.u32(1); writer.u8(0); endProps(writer); // raw tile compression
	const layerPointers = nodes.map(() => writer.pointer()); writer.u32(0); writer.u32(0);
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
		const hierarchyPointer = writer.pointer(); writer.u32(0);
		if (!isGroup && layer.data) {
			const rgba = rasterRgba(layer, clipBase, warnings);
			const hierarchy = writeHierarchy(writer, layer.width, layer.height, rgba); writer.patch(hierarchyPointer, hierarchy);
		} else if (layer.rasterMask) { warnings.push(`Group mask on “${layer.name || 'Group'}” was not exported`); }
	}
	return { data: writer.finish(), warnings: [...new Set(warnings)] };
}
