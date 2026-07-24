import { writePsdUint8Array } from 'ag-psd';
import { strToU8, zipSync } from 'fflate';
import UPNG from 'upng-js';
import type { Layer, LayerAdjustment } from './layer-compositor.js';
import { writeLayerStackAsXcf } from './xcf-writer.js';

export type LayerExportFormat = 'png' | 'ora' | 'xcf' | 'kra' | 'psd';

export interface LayerExportCompatibility {
	format: LayerExportFormat;
	label: string;
	description: string;
	detail: string;
	compatible: boolean;
}

export interface LayerDocumentWriteResult {
	data: Uint8Array;
	warnings: string[];
}

const DOCUMENT_BLEND_MODES = new Set(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'exclusion']);
const XCF_BLEND_MODES = new Set(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference']);
const KRA_FILTERS = new Set(['levels', 'hue/saturation', 'brightness/contrast', 'invert', 'color balance', 'threshold', 'posterize']);
const XCF_FILTERS = new Set(['levels', 'curves', 'hue/saturation', 'brightness/contrast', 'exposure', 'invert', 'channel mixer', 'color balance', 'black & white', 'threshold', 'posterize']);

function xml(value: unknown): string {
	return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function formatList(values: string[]): string {
	if (!values.length) { return 'none'; }
	return unique(values).join(', ');
}

function oraCompositeMode(mode: string | undefined): string {
	const value = mode || 'normal';
	return value === 'normal' ? 'svg:src-over' : `svg:${value}`;
}

export function analyzeLayerExports(layers: Layer[]): LayerExportCompatibility[] {
	const adjustments = layers.filter(layer => layer.kind === 'adjustment' && layer.adjustment).map(layer => layer.adjustment!.type);
	const hasMasks = layers.some(layer => !!layer.rasterMask);
	const hasClipping = layers.some(layer => !!layer.clipped);
	const floatLayers = layers.filter(layer => layer.data && (layer.isFloat || (layer.typeMax || 255) !== 255)).length;
	const unsupportedDocumentModes = layers.map(layer => layer.blendMode || 'normal').filter(mode => !DOCUMENT_BLEND_MODES.has(mode));
	const unsupportedXcfModes = layers.map(layer => layer.blendMode || 'normal').filter(mode => !XCF_BLEND_MODES.has(mode));
	const unsupportedKraFilters = adjustments.filter(type => !KRA_FILTERS.has(type));
	const unsupportedXcfFilters = adjustments.filter(type => !XCF_FILTERS.has(type));
	const partialXcfFilters = layers.filter(layer => {
		const adjustment = layer.adjustment;
		return adjustment?.type === 'curves'
			|| adjustment?.type === 'levels' && !Array.isArray(adjustment.rgb) && (adjustment.rgb?.midtoneInput ?? 1) !== 1
			|| adjustment?.type === 'exposure' && (adjustment.gamma ?? 1) !== 1
			|| adjustment?.type === 'hue/saturation' && adjustment.colorizeEnabled !== false && !!adjustment.colorize;
	}).map(layer => layer.name || layer.adjustment!.type);
	const common = floatLayers ? `${floatLayers} source layer${floatLayers === 1 ? '' : 's'} converted to 8-bit. ` : '';
	return [
		{ format: 'png', label: 'PNG', description: '✓ Rendered image', detail: 'Exports exactly the current rendered composition.', compatible: true },
		{
			format: 'psd', label: 'Photoshop PSD (.psd)', description: unsupportedDocumentModes.length ? '◐ Layers and filters editable; some modes approximated' : '✓ Layers and editable adjustment filters',
			detail: `${common}${unsupportedDocumentModes.length ? `Modes exported as normal: ${formatList(unsupportedDocumentModes)}.` : ''}`.trim() || 'Raster layers, groups, clipping, masks and supported adjustment layers remain editable.',
			compatible: unsupportedDocumentModes.length === 0,
		},
		{
			format: 'xcf', label: 'GIMP 3 XCF (.xcf)', description: unsupportedXcfFilters.length ? '◐ Compatible GIMP 3 effects editable; others omitted' : partialXcfFilters.length || unsupportedXcfModes.length ? '◐ Effects editable with listed approximations' : adjustments.length ? '✓ Layers and compatible GIMP 3 effects' : '✓ Raster layers and groups',
			detail: `${common}${unsupportedXcfFilters.length ? `No native effect mapping for: ${formatList(unsupportedXcfFilters)}. ` : ''}${partialXcfFilters.length ? `Partially mapped parameters: ${formatList(partialXcfFilters)}. ` : ''}${unsupportedXcfModes.length ? `Modes exported as normal: ${formatList(unsupportedXcfModes)}.` : ''}`.trim() || 'Raster layers, groups and compatible filters remain editable; masks and clipping are currently baked.',
			compatible: unsupportedXcfFilters.length === 0 && partialXcfFilters.length === 0 && unsupportedXcfModes.length === 0,
		},
		{
			format: 'kra', label: 'Krita (.kra)', description: unsupportedKraFilters.length ? '◐ Compatible filters editable; others in merged preview' : adjustments.length ? '✓ Raster layers and compatible filter masks' : '✓ Raster layers and groups',
			detail: `${common}${unsupportedKraFilters.length ? `Only the merged preview contains: ${formatList(unsupportedKraFilters)}. ` : ''}${hasMasks ? 'Raster masks are currently baked into alpha. ' : ''}${hasClipping ? 'Clipping is represented by Krita filter masks where possible and otherwise baked.' : ''}`.trim() || 'Layers, groups and supported Krita filter configurations remain editable.',
			compatible: unsupportedKraFilters.length === 0 && unsupportedDocumentModes.length === 0,
		},
		{
			format: 'ora', label: 'OpenRaster (.ora)', description: adjustments.length || hasMasks || hasClipping ? '◐ Raster structure; effects baked into merged preview' : '✓ Raster layers and groups',
			detail: `${common}${adjustments.length ? `Filters represented only by the merged preview: ${formatList(adjustments)}. ` : ''}${hasMasks ? 'Masks are baked into layer alpha. ' : ''}${hasClipping ? 'Clipping is baked into layer alpha.' : ''}`.trim() || 'Raster layers, groups, offsets, visibility, opacity and common blend modes remain editable.',
			compatible: adjustments.length === 0 && unsupportedDocumentModes.length === 0,
		},
	];
}

function encodePngPixels(data: ArrayLike<number>, width: number, height: number): Uint8Array {
	const copy = new Uint8Array(data.length);
	copy.set(data);
	// Avoid upng-js's very-small indexed-image path: its own decoder cannot
	// round-trip certain two-colour palettes. RGB/RGBA remains lossless.
	const encoded = new Uint8Array((UPNG.encode as any)([copy.buffer as ArrayBuffer], width, height, 0, [], true));
	// upng-js leaves the fixed IEND CRC as zero; write the canonical value.
	if (encoded.length >= 4) { encoded.set([0xae, 0x42, 0x60, 0x82], encoded.length - 4); }
	return encoded;
}

function encodePng(image: ImageData): Uint8Array {
	return encodePngPixels(image.data, image.width, image.height);
}

function layerRgba(layer: Layer, warnings: string[], bakeMask: boolean): Uint8ClampedArray {
	const output = new Uint8ClampedArray(layer.width * layer.height * 4);
	const max = layer.typeMax || (layer.isFloat ? 1 : 255);
	if (layer.isFloat || max !== 255) { warnings.push(`“${layer.name || 'Layer'}” was converted to 8-bit using its declared value range`); }
	for (let y = 0; y < layer.height; y++) for (let x = 0; x < layer.width; x++) {
		const source = (y * layer.width + x) * layer.channels, target = (y * layer.width + x) * 4;
		const sample = (channel: number) => {
			const value = Number(layer.data?.[source + Math.min(channel, layer.channels - 1)] ?? 0);
			return Number.isFinite(value) ? Math.max(0, Math.min(255, Math.round(value * 255 / max))) : 0;
		};
		if (layer.channels === 1) { output[target] = output[target + 1] = output[target + 2] = sample(0); }
		else { output[target] = sample(0); output[target + 1] = sample(1); output[target + 2] = sample(2); }
		let alpha = layer.channels === 4 ? sample(3) : 255;
		if (bakeMask && layer.rasterMask) {
			const mask = layer.rasterMask;
			const canvasX = x + Math.round(layer.offsetX || 0), canvasY = y + Math.round(layer.offsetY || 0);
			const mx = canvasX - Math.round(mask.offsetX ?? layer.offsetX ?? 0), my = canvasY - Math.round(mask.offsetY ?? layer.offsetY ?? 0);
			let factor = 0;
			if (mx >= 0 && my >= 0 && mx < mask.width && my < mask.height) {
				const value = Number(mask.data[(my * mask.width + mx) * Math.max(1, mask.channels || 1)]);
				factor = Math.max(0, Math.min(1, value / (mask.typeMax || 255)));
			}
			alpha = Math.round(alpha * (mask.invert ? 1 - factor : factor));
		}
		output[target + 3] = alpha;
	}
	return output;
}

function maskImageData(layer: Layer): any | undefined {
	const mask = layer.rasterMask;
	if (!mask) { return undefined; }
	const rgba = new Uint8ClampedArray(mask.width * mask.height * 4);
	for (let pixel = 0; pixel < mask.width * mask.height; pixel++) {
		let value = Number(mask.data[pixel * Math.max(1, mask.channels || 1)]) * 255 / (mask.typeMax || 255);
		if (mask.invert) { value = 255 - value; }
		rgba[pixel * 4] = rgba[pixel * 4 + 1] = rgba[pixel * 4 + 2] = Math.max(0, Math.min(255, Math.round(value)));
		rgba[pixel * 4 + 3] = 255;
	}
	const left = Math.round(mask.offsetX ?? layer.offsetX ?? 0), top = Math.round(mask.offsetY ?? layer.offsetY ?? 0);
	return { left, top, right: left + mask.width, bottom: top + mask.height, defaultColor: 0, imageData: { width: mask.width, height: mask.height, data: rgba } };
}

function psdAdjustment(value: LayerAdjustment): any {
	if (value.type === 'hue/saturation') {
		const active = value.colorizeEnabled !== false && value.colorize;
		const selected = active ? value.colorize! : (value.master || {});
		return {
			type: 'hue/saturation',
			master: active
				? { a: 256, b: selected.hue || 0, c: selected.saturation || 0, d: selected.lightness || 0, hue: 0, saturation: 0, lightness: 0 }
				: { a: 0, b: 0, c: 0, d: 0, hue: selected.hue || 0, saturation: selected.saturation || 0, lightness: selected.lightness || 0 },
		};
	}
	if (value.type === 'gradient map') {
		return {
			type: 'gradient map', name: 'Custom', gradientType: 'solid', reverse: !!value.reverse,
			colorStops: (value.stops || []).map(stop => ({ color: stop.color, location: Math.round(stop.position * 4096), midpoint: 50 })),
			opacityStops: [{ opacity: 100, location: 0, midpoint: 50 }, { opacity: 100, location: 4096, midpoint: 50 }],
		};
	}
	return JSON.parse(JSON.stringify(value));
}

function psdBlendMode(mode: string | undefined): string {
	const supported = new Set(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'exclusion', 'subtract', 'divide']);
	return supported.has(mode || 'normal') ? (mode || 'normal') : 'normal';
}

function writePsd(layers: Layer[], width: number, height: number, rendered: ImageData): LayerDocumentWriteResult {
	const warnings: string[] = [];
	// ag-psd reads and writes sibling arrays in compositing order. The manager
	// already stores bottom-to-top, including base → clipped filter sequences.
	const build = (parentId?: string): any[] => layers.filter(layer => (layer.parentId || undefined) === parentId).map(layer => {
		const common: any = {
			name: layer.name || 'Layer', hidden: layer.visible === false, opacity: layer.opacity ?? 1,
			blendMode: psdBlendMode(layer.blendMode), clipping: !!layer.clipped,
		};
		if (common.blendMode !== (layer.blendMode || 'normal')) { warnings.push(`“${common.name}” blend mode ${layer.blendMode} was exported as normal`); }
		if (layer.kind === 'group') { return { ...common, children: build(layer.id as string), opened: true }; }
		if (layer.kind === 'adjustment' && layer.adjustment) { return { ...common, adjustment: psdAdjustment(layer.adjustment), mask: maskImageData(layer) }; }
		const data = layerRgba(layer, warnings, false);
		return {
			...common, left: Math.round(layer.offsetX || 0), top: Math.round(layer.offsetY || 0),
			right: Math.round(layer.offsetX || 0) + layer.width, bottom: Math.round(layer.offsetY || 0) + layer.height,
			imageData: { width: layer.width, height: layer.height, data }, mask: maskImageData(layer),
		};
	});
	const composite = new Uint8ClampedArray(rendered.data.length); composite.set(rendered.data);
	return { data: writePsdUint8Array({ width, height, imageData: { width, height, data: composite }, children: build() } as any), warnings: unique(warnings) };
}

function alphaBakedLayer(layer: Layer, layers: Layer[], warnings: string[]): Uint8ClampedArray {
	const rgba = layerRgba(layer, warnings, true);
	if (!layer.clipped) { return rgba; }
	const index = layers.indexOf(layer);
	let base: Layer | undefined;
	for (let candidate = index - 1; candidate >= 0; candidate--) {
		if ((layers[candidate].parentId || undefined) === (layer.parentId || undefined) && !layers[candidate].clipped) { base = layers[candidate]; break; }
	}
	if (!base?.data) { return rgba; }
	const baseRgba = layerRgba(base, warnings, true);
	for (let y = 0; y < layer.height; y++) for (let x = 0; x < layer.width; x++) {
		const canvasX = x + Math.round(layer.offsetX || 0), canvasY = y + Math.round(layer.offsetY || 0);
		const bx = canvasX - Math.round(base.offsetX || 0), by = canvasY - Math.round(base.offsetY || 0);
		const factor = bx >= 0 && by >= 0 && bx < base.width && by < base.height ? baseRgba[(by * base.width + bx) * 4 + 3] / 255 : 0;
		const alpha = (y * layer.width + x) * 4 + 3; rgba[alpha] = Math.round(rgba[alpha] * factor);
	}
	warnings.push(`“${layer.name || 'Layer'}” clipping was baked into alpha`);
	return rgba;
}

function writeOra(layers: Layer[], width: number, height: number, rendered: ImageData): LayerDocumentWriteResult {
	const warnings: string[] = [];
	const files: any = {
		mimetype: [strToU8('image/openraster'), { level: 0 }],
		'mergedimage.png': encodePng(rendered),
	};
	let imageIndex = 0;
	const build = (parentId?: string): string => {
		const content: string[] = [];
		for (const layer of layers.filter(item => (item.parentId || undefined) === parentId).reverse()) {
			if (layer.kind === 'group') {
				content.push(`<stack name="${xml(layer.name || 'Group')}" visibility="${layer.visible === false ? 'hidden' : 'visible'}" opacity="${layer.opacity ?? 1}" composite-op="${xml(oraCompositeMode(layer.blendMode))}">${build(layer.id as string)}</stack>`);
			} else if (layer.kind === 'adjustment') {
				warnings.push(`“${layer.name || layer.adjustment?.type || 'Filter'}” is represented only by the merged preview in ORA`);
			} else if (layer.data) {
				const path = `data/layer-${imageIndex++}.png`;
				const data = alphaBakedLayer(layer, layers, warnings);
				files[path] = encodePngPixels(data, layer.width, layer.height);
				content.push(`<layer name="${xml(layer.name || 'Layer')}" src="${path}" x="${Math.round(layer.offsetX || 0)}" y="${Math.round(layer.offsetY || 0)}" visibility="${layer.visible === false ? 'hidden' : 'visible'}" opacity="${layer.opacity ?? 1}" composite-op="${xml(oraCompositeMode(layer.blendMode))}"/>`);
				if (layer.rasterMask) { warnings.push(`“${layer.name || 'Layer'}” mask was baked into alpha`); }
			}
		}
		return content.join('');
	};
	files['stack.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><image version="0.0.1" w="${width}" h="${height}" name="TIFF Visualizer export"><stack>${build()}</stack></image>`);
	return { data: zipSync(files, { level: 6 }), warnings: unique(warnings) };
}

function kraPaintDevice(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
	const chunks: Uint8Array[] = [];
	const tilesAcross = Math.ceil(width / 64), tilesDown = Math.ceil(height / 64);
	chunks.push(strToU8(`VERSION 2\nTILEWIDTH 64\nTILEHEIGHT 64\nPIXELSIZE 4\nDATA ${tilesAcross * tilesDown}\n`));
	for (let tileY = 0; tileY < tilesDown; tileY++) for (let tileX = 0; tileX < tilesAcross; tileX++) {
		const plane = new Uint8Array(64 * 64 * 4), planeSize = 64 * 64;
		for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
			const sx = tileX * 64 + x, sy = tileY * 64 + y, target = y * 64 + x;
			if (sx >= width || sy >= height) { continue; }
			const source = (sy * width + sx) * 4;
			plane[target] = rgba[source + 2]; plane[planeSize + target] = rgba[source + 1];
			plane[planeSize * 2 + target] = rgba[source]; plane[planeSize * 3 + target] = rgba[source + 3];
		}
		const payload = new Uint8Array(1 + plane.length); payload.set(plane, 1);
		chunks.push(strToU8(`${tileX * 64},${tileY * 64},LZF,${payload.length}\n`), payload);
	}
	const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0), output = new Uint8Array(length);
	let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
	return output;
}

function placeLayerOnCanvas(layer: Layer, rgba: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
	const output = new Uint8ClampedArray(width * height * 4);
	const offsetX = Math.round(layer.offsetX || 0), offsetY = Math.round(layer.offsetY || 0);
	for (let y = 0; y < layer.height; y++) for (let x = 0; x < layer.width; x++) {
		const targetX = x + offsetX, targetY = y + offsetY;
		if (targetX < 0 || targetY < 0 || targetX >= width || targetY >= height) { continue; }
		const source = (y * layer.width + x) * 4, target = (targetY * width + targetX) * 4;
		output.set(rgba.subarray(source, source + 4), target);
	}
	return output;
}

function clippedTarget(layers: Layer[], layer: Layer): Layer | undefined {
	if (!layer.clipped) { return undefined; }
	for (let index = layers.indexOf(layer) - 1; index >= 0; index--) {
		const candidate = layers[index];
		if ((candidate.parentId || undefined) === (layer.parentId || undefined) && !candidate.clipped) { return candidate; }
	}
	return undefined;
}

function kraFilterConfig(adjustment: LayerAdjustment): { name: string; xml: string } | undefined {
	const params: Record<string, number | boolean | string> = {};
	let name: string = adjustment.type;
	if (adjustment.type === 'levels') {
		const rgb = !Array.isArray(adjustment.rgb) ? adjustment.rgb : undefined;
		params.lightness = `${(rgb?.shadowInput ?? 0) / 255};${(rgb?.highlightInput ?? 255) / 255};${rgb?.midtoneInput ?? 1};${(rgb?.shadowOutput ?? 0) / 255};${(rgb?.highlightOutput ?? 255) / 255}`;
	} else if (adjustment.type === 'hue/saturation') {
		name = 'hsvadjustment'; const active = adjustment.colorizeEnabled !== false && adjustment.colorize;
		const values = active ? adjustment.colorize! : (adjustment.master || {});
		params.h = values.hue || 0; params.s = values.saturation || 0; params.v = values.lightness || 0; params.colorize = !!active;
	} else if (adjustment.type === 'brightness/contrast') {
		name = 'brightnesscontrast'; params.brightness = adjustment.brightness || 0; params.contrast = adjustment.contrast || 0;
	} else if (adjustment.type === 'invert') { name = 'invert'; }
	else if (adjustment.type === 'threshold') { params.threshold = adjustment.level ?? 128; }
	else if (adjustment.type === 'posterize') { params.steps = adjustment.levels ?? 4; }
	else if (adjustment.type === 'color balance') {
		name = 'colorbalance';
		for (const range of ['shadows', 'midtones', 'highlights'] as const) {
			const values = adjustment[range] || {};
			params[`${range}_cyan_red`] = values.cyanRed || 0; params[`${range}_magenta_green`] = values.magentaGreen || 0; params[`${range}_yellow_blue`] = values.yellowBlue || 0;
		}
		params.preserve_luminosity = adjustment.preserveLuminosity !== false;
	} else { return undefined; }
	return { name, xml: `<params version="1">${Object.entries(params).map(([key, value]) => `<param name="${xml(key)}">${xml(value)}</param>`).join('')}</params>` };
}

function writeKra(layers: Layer[], width: number, height: number, rendered: ImageData): LayerDocumentWriteResult {
	const warnings: string[] = [], documentName = 'TIFF Visualizer export';
	const files: any = {
		mimetype: [strToU8('application/x-krita'), { level: 0 }],
		'mergedimage.png': encodePng(rendered),
		'preview.png': encodePng(rendered),
		'documentinfo.xml': strToU8(`<?xml version="1.0"?><document-info><about><title>${xml(documentName)}</title></about></document-info>`),
	};
	let index = 0;
	const build = (parentId?: string): string => {
		const output: string[] = [];
		for (const layer of layers.filter(item => (item.parentId || undefined) === parentId).reverse()) {
			if (layer.kind === 'adjustment' && clippedTarget(layers, layer)) { continue; }
			const filename = `layer${++index}`;
			const common = `name="${xml(layer.name || 'Layer')}" filename="${filename}" visible="${layer.visible === false ? 0 : 1}" opacity="${Math.round((layer.opacity ?? 1) * 255)}" compositeop="${xml(layer.blendMode || 'normal')}"`;
			if (layer.kind === 'group') {
				output.push(`<layer ${common} nodetype="grouplayer"><layers>${build(layer.id as string)}</layers></layer>`);
			} else if (layer.kind === 'adjustment' && layer.adjustment) {
				const config = kraFilterConfig(layer.adjustment);
				if (!config) { warnings.push(`“${layer.name || layer.adjustment.type}” is represented only by the merged preview in KRA`); continue; }
				files[`${documentName}/layers/${filename}.filterconfig`] = strToU8(config.xml);
				output.push(`<layer ${common} nodetype="adjustmentlayer" filtername="${xml(config.name)}"/>`);
			} else if (layer.data) {
				const rgba = alphaBakedLayer(layer, layers, warnings);
				files[`${documentName}/layers/${filename}`] = kraPaintDevice(placeLayerOnCanvas(layer, rgba, width, height), width, height);
				files[`${documentName}/layers/${filename}.defaultpixel`] = Uint8Array.from([0, 0, 0, 0]);
				const masks: string[] = [];
				const attached = layers.filter(candidate => candidate.kind === 'adjustment' && clippedTarget(layers, candidate) === layer).reverse();
				for (const adjustmentLayer of attached) {
					const config = adjustmentLayer.adjustment && kraFilterConfig(adjustmentLayer.adjustment);
					if (!config) {
						warnings.push(`“${adjustmentLayer.name || adjustmentLayer.adjustment?.type || 'Filter'}” is represented only by the merged preview in KRA`);
						continue;
					}
					const maskFilename = `mask${++index}`;
					files[`${documentName}/layers/${maskFilename}.filterconfig`] = strToU8(config.xml);
					masks.push(`<mask name="${xml(adjustmentLayer.name || adjustmentLayer.adjustment?.type || 'Filter')}" nodetype="filtermask" filename="${maskFilename}" filtername="${xml(config.name)}" visible="${adjustmentLayer.visible === false ? 0 : 1}"/>`);
				}
				output.push(`<layer ${common} nodetype="paintlayer" x="0" y="0">${masks.length ? `<masks>${masks.join('')}</masks>` : ''}</layer>`);
				if (layer.rasterMask) { warnings.push(`“${layer.name || 'Layer'}” mask was baked into alpha in KRA export`); }
			}
		}
		return output.join('');
	};
	files['maindoc.xml'] = strToU8(`<?xml version="1.0"?><DOC><IMAGE name="${xml(documentName)}" colorspacename="RGBA" width="${width}" height="${height}"><layers>${build()}</layers></IMAGE></DOC>`);
	return { data: zipSync(files, { level: 6 }), warnings: unique(warnings) };
}

export function writeLayerDocument(format: LayerExportFormat, layers: Layer[], width: number, height: number, rendered: ImageData): LayerDocumentWriteResult {
	if (!width || !height) { throw new Error('Layer canvas has no dimensions'); }
	if (format === 'png') { return { data: encodePng(rendered), warnings: [] }; }
	if (format === 'ora') { return writeOra(layers, width, height, rendered); }
	if (format === 'kra') { return writeKra(layers, width, height, rendered); }
	if (format === 'psd') { return writePsd(layers, width, height, rendered); }
	if (format === 'xcf') { return writeLayerStackAsXcf(layers, width, height); }
	throw new Error(`Unsupported export format: ${format}`);
}
