import { unzipSync } from 'fflate';
import { initializeCanvas, readPsd } from 'ag-psd';
import pako from 'pako';
import UPNG from 'upng-js';
import type { DecodedLayeredPreview, LayeredRasterAsset, LayerNodeKind, LayerNodeSummary, LayeredDocumentSummary, LayeredPixelArray } from './layered-document.js';
import { composite as compositeLayers, type Layer, type LayerAdjustment } from './layer-compositor.js';

const MAX_PREVIEW_PIXELS = 150_000_000;
const MAX_PREVIEW_BYTES = 600 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_PSD_MEMORY_BYTES = 768 * 1024 * 1024;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let psdCanvasInitialized = false;

function ensurePsdImageDataFactory(): void {
	if (psdCanvasInitialized) { return; }
	// readPsd(useImageData=true) only needs the ImageData factory. Supplying it
	// keeps decoding DOM-free and worker-safe, including for 8-bit RGBA data.
	initializeCanvas(
		(width: number, height: number) => ({ width, height }) as HTMLCanvasElement,
		(width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData,
	);
	psdCanvasInitialized = true;
}

function assertDimensions(width: number, height: number, bytesPerPixel = 4): void {
	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
		throw new Error(`Invalid preview dimensions: ${width}x${height}`);
	}
	const pixels = width * height;
	if (!Number.isSafeInteger(pixels) || pixels > MAX_PREVIEW_PIXELS || pixels * bytesPerPixel > MAX_PREVIEW_BYTES) {
		throw new Error(`Preview dimensions exceed the safety limit: ${width}x${height}`);
	}
}

function decodePngRgba(bytes: Uint8Array): { width: number; height: number; data: Uint8Array } {
	const encoded = new Uint8Array(bytes.byteLength);
	encoded.set(bytes);
	const png = UPNG.decode(encoded.buffer);
	assertDimensions(png.width, png.height, 4);
	const frames = UPNG.toRGBA8(png);
	if (!frames?.[0]) { throw new Error('Embedded PNG contains no decodable frame'); }
	return { width: png.width, height: png.height, data: new Uint8Array(frames[0]) };
}

function xmlAttribute(source: string, name: string): string | undefined {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = source.match(new RegExp(`\\b${escaped}\\s*=\\s*["']([^"']*)["']`, 'i'));
	return match?.[1];
}

function decodeXml(bytes: Uint8Array | undefined): string {
	if (!bytes) { return ''; }
	return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function countMatches(source: string, expression: RegExp): number {
	let count = 0;
	while (expression.exec(source)) { count++; }
	return count;
}

interface OraXmlNode {
	tag: 'stack' | 'layer';
	attrs: Record<string, string>;
	children: OraXmlNode[];
}

function decodeXmlEntity(value: string): string {
	return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, entity => {
		const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
		if (named[entity]) { return named[entity]; }
		const hex = /^&#x([0-9a-f]+);$/i.exec(entity);
		const decimal = /^&#(\d+);$/.exec(entity);
		const code = hex ? parseInt(hex[1], 16) : decimal ? parseInt(decimal[1], 10) : NaN;
		return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
	});
}

function parseXmlAttributes(source: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const expression = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
	let match: RegExpExecArray | null;
	while ((match = expression.exec(source))) { attrs[match[1]] = decodeXmlEntity(match[2] ?? match[3] ?? ''); }
	return attrs;
}

/** Minimal, worker-safe parser for the stack/layer subset defined by OpenRaster. */
function parseOraTree(xml: string): OraXmlNode[] {
	const roots: OraXmlNode[] = [];
	const stack: OraXmlNode[] = [];
	const tags = /<\s*(\/?)\s*(stack|layer)\b([^>]*?)(\/?)\s*>/gi;
	let match: RegExpExecArray | null;
	let nodeCount = 0;
	while ((match = tags.exec(xml))) {
		const closing = match[1] === '/';
		const tag = match[2].toLowerCase() as 'stack' | 'layer';
		if (closing) {
			if (tag === 'stack' && stack.length) { stack.pop(); }
			continue;
		}
		const node: OraXmlNode = { tag, attrs: parseXmlAttributes(match[3]), children: [] };
		if (++nodeCount > 100_000) { throw new Error('OpenRaster layer tree exceeds the node safety limit'); }
		const parent = stack[stack.length - 1];
		(parent ? parent.children : roots).push(node);
		if (tag === 'stack' && match[4] !== '/') {
			if (stack.length >= 4096) { throw new Error('OpenRaster group nesting exceeds the safety limit'); }
			stack.push(node);
		}
	}
	return roots.length === 1 && roots[0].tag === 'stack' && !roots[0].attrs.name ? roots[0].children : roots;
}

function oraNumber(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function oraVisible(value: string | undefined): boolean { return value !== 'hidden'; }

function oraBlendMode(value: string | undefined): string {
	if (!value || value === 'svg:src-over' || value === 'normal') { return 'normal'; }
	const normalized = value.replace(/^svg:/, '').replace(/^krita:/, '');
	const aliases: Record<string, string> = {
		'multiply': 'multiply', 'screen': 'screen', 'overlay': 'overlay',
		'darken': 'darken', 'darken-only': 'darken', 'lighten': 'lighten', 'lighten-only': 'lighten',
		'difference': 'difference', 'exclusion': 'exclusion',
	};
	return aliases[normalized] || value;
}

function editableBlendMode(value: string | undefined): string {
	return oraBlendMode(value);
}

function documentBlend8(below: number, source: number, mode: string): number {
	switch (mode) {
		case 'multiply': return below * source / 255;
		case 'screen': return 255 - (255 - below) * (255 - source) / 255;
		case 'overlay': return below <= 127.5 ? 2 * below * source / 255 : 255 - 2 * (255 - below) * (255 - source) / 255;
		case 'darken': return Math.min(below, source);
		case 'lighten': return Math.max(below, source);
		case 'difference': return Math.abs(below - source);
		case 'exclusion': return below + source - 2 * below * source / 255;
		default: return source;
	}
}

function compositeRgbaOver(destination: Uint8Array, source: Uint8Array, opacity: number, mode = 'normal'): void {
	const pixelCount = Math.min(destination.length, source.length) / 4;
	for (let pixel = 0; pixel < pixelCount; pixel++) {
		const i = pixel * 4;
		const sa = (source[i + 3] / 255) * opacity;
		if (sa <= 0) { continue; }
		const da = destination[i + 3] / 255;
		const oa = sa + da * (1 - sa);
		for (let channel = 0; channel < 3; channel++) {
			const s = source[i + channel], d = destination[i + channel], blended = documentBlend8(d, s, mode);
			destination[i + channel] = oa > 0
				? Math.round(((1 - sa) * da * d + (1 - da) * sa * s + da * sa * blended) / oa)
				: 0;
		}
		destination[i + 3] = Math.round(oa * 255);
	}
}

function placeOraLayer(canvas: Uint8Array, canvasWidth: number, canvasHeight: number, asset: LayeredRasterAsset): Uint8Array {
	const placed = new Uint8Array(canvas.length);
	for (let y = 0; y < asset.height; y++) for (let x = 0; x < asset.width; x++) {
		const dx = asset.x + x, dy = asset.y + y;
		if (dx < 0 || dy < 0 || dx >= canvasWidth || dy >= canvasHeight) { continue; }
		const source = (y * asset.width + x) * 4, destination = (dy * canvasWidth + dx) * 4;
		placed.set(asset.data.subarray(source, source + 4), destination);
	}
	return placed;
}

function compareRgba(reference: Uint8Array, reconstructed: Uint8Array) {
	let sum = 0, max = 0, differentPixels = 0;
	const pixels = Math.min(reference.length, reconstructed.length) / 4;
	for (let pixel = 0; pixel < pixels; pixel++) {
		let different = false;
		for (let channel = 0; channel < 4; channel++) {
			const difference = Math.abs(reference[pixel * 4 + channel] - reconstructed[pixel * 4 + channel]);
			sum += difference; max = Math.max(max, difference); different ||= difference > 1;
		}
		if (different) { differentPixels++; }
	}
	return {
		available: true,
		meanAbsoluteError: pixels ? sum / (pixels * 4) : 0,
		maxAbsoluteError: max,
		differentPixelRatio: pixels ? differentPixels / pixels : 0,
	};
}

function decodeOraResult(buffer: ArrayBuffer, previewName: string, decoded: { width: number; height: number; data: Uint8Array }, xml: string, declaredWidth: number, declaredHeight: number): DecodedLayeredPreview {
	const xmlRoots = parseOraTree(xml);
	const sourcePaths = new Set<string>();
	const collectPaths = (nodes: OraXmlNode[]) => nodes.forEach(node => {
		if (node.tag === 'layer' && node.attrs.src) { sourcePaths.add(node.attrs.src.replace(/\\/g, '/').replace(/^\.\//, '')); }
		collectPaths(node.children);
	});
	collectPaths(xmlRoots);
	const layerFiles = unzipSelected(buffer, name => sourcePaths.has(name));
	const assets: LayeredRasterAsset[] = [];
	const warnings: string[] = [];
	if (!xml.trim()) { warnings.push('OpenRaster stack.xml is missing; only the integrated preview is available'); }
	let nodeSequence = 0;
	const supportedBlendModes = new Set(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'exclusion']);
	const buildNodes = (nodes: OraXmlNode[], groupPath: string[] = [], groupIds: string[] = [], parentId: string | undefined = undefined, inheritedX = 0, inheritedY = 0): LayerNodeSummary[] => nodes.map(node => {
		const id = `ora-node-${nodeSequence++}`;
		const name = node.attrs.name || (node.tag === 'stack' ? 'Group' : `Layer ${nodeSequence}`);
		const x = inheritedX + Math.trunc(oraNumber(node.attrs.x, 0));
		const y = inheritedY + Math.trunc(oraNumber(node.attrs.y, 0));
		const opacity = Math.max(0, Math.min(1, oraNumber(node.attrs.opacity, 1)));
		const visible = oraVisible(node.attrs.visibility);
		const blendMode = oraBlendMode(node.attrs['composite-op']);
		const support = supportedBlendModes.has(blendMode) ? 'native' : 'approximate';
		if (!supportedBlendModes.has(blendMode)) { warnings.push(`“${name}” uses ${blendMode}; reconstruction currently approximates it as normal`); }
		const summary: LayerNodeSummary = { id, name, kind: node.tag === 'stack' ? 'group' : 'raster', support, visible, opacity, blendMode, left: x, top: y };
		if (node.tag === 'stack') {
			assets.push({ nodeId: id, name, sourcePath: '', kind: 'group', parentId, width: declaredWidth, height: declaredHeight, x: 0, y: 0, opacity, visible, blendMode, groupPath, groupIds, support });
			summary.children = buildNodes(node.children, [...groupPath, name], [...groupIds, id], id, x, y);
			return summary;
		}
		const path = (node.attrs.src || '').replace(/\\/g, '/').replace(/^\.\//, '');
		const bytes = layerFiles[path];
		if (!bytes) {
			summary.support = 'unsupported'; summary.warnings = [`Missing layer entry: ${path || '(none)'}`];
			warnings.push(`Layer “${name}” has no decodable source entry`);
			return summary;
		}
		try {
			const png = decodePngRgba(bytes);
			summary.width = png.width; summary.height = png.height;
			assets.push({ nodeId: id, name, sourcePath: path, kind: 'raster', parentId, data: png.data, width: png.width, height: png.height, x, y, opacity, visible, blendMode, groupPath, groupIds, support });
		} catch (error) {
			summary.support = 'unsupported'; summary.warnings = [error instanceof Error ? error.message : String(error)];
			warnings.push(`Layer “${name}” could not be decoded`);
		}
		return summary;
	});
	const root = buildNodes(xmlRoots);
	const assetByNode = new Map(assets.map(asset => [asset.nodeId, asset]));
	const renderNodes = (nodes: LayerNodeSummary[]): Uint8Array => {
		const output = new Uint8Array(declaredWidth * declaredHeight * 4);
		// ORA stores the visual top node first; composite bottom-to-top.
		for (const node of [...nodes].reverse()) {
			if (!node.visible || node.opacity <= 0) { continue; }
			const source = node.kind === 'group'
				? renderNodes(node.children || [])
				: (() => {
					const asset = assetByNode.get(node.id);
					return asset ? placeOraLayer(output, declaredWidth, declaredHeight, asset) : new Uint8Array(output.length);
				})();
			compositeRgbaOver(output, source, node.opacity, supportedBlendModes.has(node.blendMode || 'normal') ? node.blendMode : 'normal');
		}
		return output;
	};
	const reconstructed = renderNodes(root);
	const comparable = decoded.width === declaredWidth && decoded.height === declaredHeight;
	const rasterAssetCount = assets.filter(asset => asset.kind !== 'group' && asset.data).length;
	const reconstruction: NonNullable<LayeredDocumentSummary['reconstruction']> = rasterAssetCount === 0
		? { available: false }
		: comparable
		? compareRgba(decoded.data, reconstructed)
		: { available: true };
	if (comparable && (reconstruction.differentPixelRatio || 0) > 0.01) {
		warnings.push(`Reconstruction differs from the integrated preview in ${((reconstruction.differentPixelRatio || 0) * 100).toFixed(2)}% of pixels`);
	}
	const document: LayeredDocumentSummary = {
		format: 'ora', width: declaredWidth, height: declaredHeight, bitDepth: 8, colorMode: 'RGBA',
		previewKind: 'merged', previewIsAuthoritative: previewName === 'mergedimage.png' && comparable,
		previewWidth: decoded.width, previewHeight: decoded.height, layerCount: assets.length, root, warnings, reconstruction,
	};
	return {
		...decoded, channels: 4, bitDepth: 8, sampleFormat: 1,
		integratedData: decoded.data, ...(assets.length ? { reconstructedData: reconstructed } : {}), layerAssets: assets,
		formatLabel: 'OpenRaster integrated preview', formatType: 'ora', document,
		metadata: { container: 'ZIP', previewEntry: previewName, previewAuthoritative: document.previewIsAuthoritative, layerCount: assets.length, documentWidth: declaredWidth, documentHeight: declaredHeight, reconstructionMeanError: reconstruction.meanAbsoluteError ?? 0, reconstructionDifferentPixels: reconstruction.differentPixelRatio ?? 0 },
	};
}

interface KraXmlNode {
	attrs: Record<string, string>;
	children: KraXmlNode[];
	masks: Record<string, string>[];
}

function parseKraTree(xml: string): KraXmlNode[] {
	const roots: KraXmlNode[] = [], stack: KraXmlNode[] = [];
	const tags = /<\s*(\/?)\s*(layer|mask)\b([^>]*?)(\/?)\s*>/gi;
	let match: RegExpExecArray | null, count = 0;
	while ((match = tags.exec(xml))) {
		const closing = match[1] === '/', tag = match[2].toLowerCase();
		if (closing) { if (tag === 'layer' && stack.length) { stack.pop(); } continue; }
		if (++count > 100_000) { throw new Error('Krita layer tree exceeds the node safety limit'); }
		const attrs = parseXmlAttributes(match[3]);
		if (tag === 'mask') {
			stack[stack.length - 1]?.masks.push(attrs);
			continue;
		}
		const node: KraXmlNode = { attrs, children: [], masks: [] };
		const parent = stack[stack.length - 1];
		(parent ? parent.children : roots).push(node);
		if (match[4] !== '/') { stack.push(node); }
	}
	return roots;
}

function kraEntryPath(files: Record<string, Uint8Array>, documentName: string, filename: string, suffix = ''): string | undefined {
	const normalized = filename.replace(/\\/g, '/').replace(/^\/+/, '') + suffix;
	const candidates = [`${documentName}/layers/${normalized}`, `layers/${normalized}`];
	return candidates.find(path => !!files[path]) || Object.keys(files).find(path => path.endsWith(`/layers/${normalized}`));
}

function filterConfigParams(xml: string): Record<string, string> {
	const params: Record<string, string> = {};
	const expression = /<(?:param|property)\b([^>]*)>([\s\S]*?)<\/(?:param|property)\s*>/gi;
	let match: RegExpExecArray | null, count = 0;
	while ((match = expression.exec(xml))) {
		if (++count > 10_000) { throw new Error('Filter configuration exceeds the parameter safety limit'); }
		const name = parseXmlAttributes(match[1]).name;
		if (name) { params[name] = decodeXmlEntity(match[2].replace(/<[^>]*>/g, '').trim()); }
	}
	return params;
}

function configNumber(params: Record<string, string>, names: string[], fallback: number): number {
	for (const name of names) {
		const value = Number(params[name]);
		if (Number.isFinite(value)) { return value; }
	}
	return fallback;
}

function configBool(params: Record<string, string>, names: string[], fallback = false): boolean {
	for (const name of names) {
		if (!(name in params)) { continue; }
		return /^(?:1|true|yes|on)$/i.test(params[name]);
	}
	return fallback;
}

/** Translate the stable/common subset of Krita filter configurations. */
function kraAdjustment(filterName: string | undefined, xml: string): LayerAdjustment | undefined {
	const id = (filterName || xmlAttribute(xml, 'name') || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
	const params = filterConfigParams(xml);
	if (id === 'levels') {
		const compact = (params.lightness || '').split(';').map(Number);
		const values = compact.length >= 5 && compact.every(Number.isFinite) ? compact : [
			configNumber(params, ['blackvalue'], 0) / 255,
			configNumber(params, ['whitevalue'], 255) / 255,
			configNumber(params, ['gammavalue'], 1),
			configNumber(params, ['outblackvalue'], 0) / 255,
			configNumber(params, ['outwhitevalue'], 255) / 255,
		];
		return { type: 'levels', rgb: { shadowInput: values[0] * 255, highlightInput: values[1] * 255, midtoneInput: values[2], shadowOutput: values[3] * 255, highlightOutput: values[4] * 255 } };
	}
	if (['hsvadjustment', 'huesaturation', 'hsladjustment'].includes(id)) {
		const colorizeEnabled = configBool(params, ['colorize']);
		const values = {
			hue: configNumber(params, ['h', 'hue'], 0),
			saturation: configNumber(params, ['s', 'saturation'], colorizeEnabled ? 100 : 0),
			lightness: configNumber(params, ['v', 'l', 'lightness', 'value'], 0),
		};
		return colorizeEnabled
			? { type: 'hue/saturation', master: { hue: 0, saturation: 0, lightness: 0 }, colorize: values, colorizeEnabled: true }
			: { type: 'hue/saturation', master: values, colorize: { hue: 0, saturation: 100, lightness: 0 }, colorizeEnabled: false };
	}
	if (id === 'invert') { return { type: 'invert' }; }
	if (id === 'threshold') { return { type: 'threshold', level: configNumber(params, ['threshold', 'level', 'value'], 128) }; }
	if (id === 'posterize') { return { type: 'posterize', levels: configNumber(params, ['steps', 'levels', 'value'], 4) }; }
	if (['brightnesscontrast', 'brightnessandcontrast'].includes(id)) {
		return { type: 'brightness/contrast', brightness: configNumber(params, ['brightness'], 0), contrast: configNumber(params, ['contrast'], 0) };
	}
	if (id === 'colorbalance') {
		const range = (prefix: string) => ({
			cyanRed: configNumber(params, [`${prefix}_cyan_red`, `${prefix}CyanRed`, `cyan_red_${prefix}`], 0),
			magentaGreen: configNumber(params, [`${prefix}_magenta_green`, `${prefix}MagentaGreen`, `magenta_green_${prefix}`], 0),
			yellowBlue: configNumber(params, [`${prefix}_yellow_blue`, `${prefix}YellowBlue`, `yellow_blue_${prefix}`], 0),
		});
		return { type: 'color balance', shadows: range('shadows'), midtones: range('midtones'), highlights: range('highlights'), preserveLuminosity: configBool(params, ['preserve_luminosity', 'preserveLuminosity'], true) };
	}
	return undefined;
}

/** Standard LZF decoder used by Krita's version-2 tile stream. */
function decodeKraLzf(input: Uint8Array, expectedLength: number): Uint8Array {
	const output = new Uint8Array(expectedLength);
	let ip = 0, op = 0;
	while (ip < input.length && op < output.length) {
		const control = input[ip++];
		if (control < 32) {
			const length = control + 1;
			if (ip + length > input.length || op + length > output.length) { throw new Error('Invalid Krita LZF literal'); }
			output.set(input.subarray(ip, ip + length), op); ip += length; op += length;
			continue;
		}
		let length = control >> 5;
		let reference = op - ((control & 0x1f) << 8) - 1;
		if (length === 7) { if (ip >= input.length) { throw new Error('Invalid Krita LZF length'); } length += input[ip++]; }
		if (ip >= input.length) { throw new Error('Invalid Krita LZF back-reference'); }
		reference -= input[ip++]; length += 2;
		if (reference < 0 || op + length > output.length) { throw new Error('Invalid Krita LZF range'); }
		for (let i = 0; i < length; i++) { output[op++] = output[reference++]; }
	}
	if (op !== expectedLength) { throw new Error(`Krita LZF tile decoded to ${op} bytes instead of ${expectedLength}`); }
	return output;
}

function readAsciiLine(bytes: Uint8Array, state: { offset: number }): string {
	const start = state.offset;
	while (state.offset < bytes.length && bytes[state.offset] !== 10) { state.offset++; }
	const line = new TextDecoder('ascii').decode(bytes.subarray(start, state.offset)).replace(/\r$/, '');
	if (state.offset < bytes.length) { state.offset++; }
	return line;
}

function decodeKraPaintDevice(bytes: Uint8Array, width: number, height: number, expectedPixelSize: 1 | 4, defaultPixel?: Uint8Array): Uint8Array {
	const state = { offset: 0 };
	const versionLine = readAsciiLine(bytes, state);
	if (versionLine !== 'VERSION 2') { throw new Error(`Unsupported Krita tile stream: ${versionLine || 'missing version'}`); }
	const tileWidth = Number(readAsciiLine(bytes, state).split(/\s+/)[1]);
	const tileHeight = Number(readAsciiLine(bytes, state).split(/\s+/)[1]);
	const pixelSize = Number(readAsciiLine(bytes, state).split(/\s+/)[1]);
	const tileCount = Number(readAsciiLine(bytes, state).split(/\s+/)[1]);
	if (tileWidth !== 64 || tileHeight !== 64 || pixelSize !== expectedPixelSize || !Number.isSafeInteger(tileCount) || tileCount < 0 || tileCount > 1_000_000) {
		throw new Error(`Unsupported Krita tile geometry or pixel size (${tileWidth}x${tileHeight}, ${pixelSize} B)`);
	}
	const outputChannels = expectedPixelSize === 4 ? 4 : 1;
	const output = new Uint8Array(width * height * outputChannels);
	if (defaultPixel?.length) {
		for (let i = 0; i < width * height; i++) {
			if (expectedPixelSize === 4) {
				output[i * 4] = defaultPixel[2] || 0; output[i * 4 + 1] = defaultPixel[1] || 0;
				output[i * 4 + 2] = defaultPixel[0] || 0; output[i * 4 + 3] = defaultPixel[3] || 0;
			} else { output[i] = defaultPixel[0] || 0; }
		}
	}
	const tileBytes = tileWidth * tileHeight * pixelSize;
	for (let tile = 0; tile < tileCount; tile++) {
		const parts = readAsciiLine(bytes, state).split(',');
		if (parts.length !== 4 || parts[2] !== 'LZF') { throw new Error('Invalid Krita tile header'); }
		const tileX = Number(parts[0]), tileY = Number(parts[1]), payloadSize = Number(parts[3]);
		if (!Number.isSafeInteger(tileX) || !Number.isSafeInteger(tileY) || !Number.isSafeInteger(payloadSize) || payloadSize < 1 || state.offset + payloadSize > bytes.length) {
			throw new Error('Invalid Krita tile payload size');
		}
		const payload = bytes.subarray(state.offset, state.offset + payloadSize); state.offset += payloadSize;
		let planar: Uint8Array;
		if (payload[0] === 0) {
			if (payload.length !== tileBytes + 1) { throw new Error('Invalid raw Krita tile size'); }
			// Compression only changes how the tile bytes are encoded. Krita stores
			// both raw and LZF tiles in channel-major planes (B, G, R, A for RGBA).
			planar = payload.subarray(1);
		} else if (payload[0] === 1) {
			planar = decodeKraLzf(payload.subarray(1), tileBytes);
		} else { throw new Error(`Unsupported Krita tile compression flag: ${payload[0]}`); }
		const planeSize = tileWidth * tileHeight;
		for (let y = 0; y < tileHeight; y++) for (let x = 0; x < tileWidth; x++) {
			const dx = tileX + x, dy = tileY + y;
			if (dx < 0 || dy < 0 || dx >= width || dy >= height) { continue; }
			const sourcePixel = y * tileWidth + x, destination = (dy * width + dx) * outputChannels;
			if (pixelSize === 4) {
				// Krita's RGBA/U8 paint device stores pixels as BGRA on little-endian platforms.
				output[destination] = planar[2 * planeSize + sourcePixel]; output[destination + 1] = planar[planeSize + sourcePixel];
				output[destination + 2] = planar[sourcePixel]; output[destination + 3] = planar[3 * planeSize + sourcePixel];
			} else { output[destination] = planar[sourcePixel]; }
		}
	}
	return output;
}

function decodeKraResult(buffer: ArrayBuffer, previewName: string, decoded: { width: number; height: number; data: Uint8Array }, xml: string, declaredWidth: number, declaredHeight: number): DecodedLayeredPreview {
	const roots = parseKraTree(xml);
	const documentName = xmlAttribute(xml, 'name') || '';
	const filenames = new Set<string>();
	const collect = (nodes: KraXmlNode[]) => nodes.forEach(node => {
		if (node.attrs.filename) { filenames.add(node.attrs.filename); }
		for (const mask of node.masks) if (mask.filename) { filenames.add(mask.filename); }
		collect(node.children);
	});
	collect(roots);
	const files = unzipSelected(buffer, name => [...filenames].some(filename => {
		const base = name.endsWith(`/layers/${filename}`) || name === `layers/${filename}`;
		return base || name.endsWith(`/layers/${filename}.defaultpixel`) || name === `layers/${filename}.defaultpixel`
			|| name.endsWith(`/layers/${filename}.filterconfig`) || name === `layers/${filename}.filterconfig`
			|| name.endsWith(`/layers/${filename}.pixelselection`) || name === `layers/${filename}.pixelselection`
			|| name.endsWith(`/layers/${filename}.pixelselection.defaultpixel`) || name === `layers/${filename}.pixelselection.defaultpixel`;
	}));
	const assets: LayeredRasterAsset[] = [], warnings: string[] = [];
	let sequence = 0;
	const supportedBlendModes = new Set(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'exclusion']);
	const build = (nodes: KraXmlNode[], parentId?: string, groupPath: string[] = [], groupIds: string[] = []): LayerNodeSummary[] => nodes.map(node => {
		const attrs = node.attrs, id = attrs.uuid || `kra-node-${sequence++}`, name = attrs.name || `Layer ${sequence}`;
		const x = Math.trunc(oraNumber(attrs.x, 0)), y = Math.trunc(oraNumber(attrs.y, 0));
		const nodeType = (attrs.nodetype || '').toLowerCase();
		const kind: LayerNodeKind = nodeType === 'grouplayer' ? 'group' : nodeType === 'paintlayer' ? 'raster' : nodeType.includes('vector') ? 'vector' : nodeType === 'adjustmentlayer' ? 'adjustment' : 'unknown';
		const opacity = Math.max(0, Math.min(1, oraNumber(attrs.opacity, 255) / 255));
		const visible = attrs.visible !== '0';
		const blendMode = editableBlendMode(attrs.compositeop);
		let support: LayerNodeSummary['support'] = kind === 'group' || kind === 'raster' ? (supportedBlendModes.has(blendMode) ? 'native' : 'approximate') : 'unsupported';
		const summary: LayerNodeSummary = { id, name, kind, support, visible, opacity, blendMode, left: x, top: y };
		if (kind === 'group') {
			if (attrs.passthrough === '1') { support = 'approximate'; summary.support = support; warnings.push(`Pass-through group “${name}” is currently reconstructed as an isolated group`); }
			// KRA tile coordinates are already in document space. The XML position is
			// descriptive metadata here; applying it again to a document-sized surface
			// would shift the layer twice and clip its right and bottom edges.
			const groupAsset: LayeredRasterAsset = { nodeId: id, name, sourcePath: '', kind: 'group', parentId, width: declaredWidth, height: declaredHeight, x: 0, y: 0, opacity, visible, blendMode, groupPath, groupIds, support };
			const groupMask = node.masks.find(mask => (mask.nodetype || '').toLowerCase() === 'transparencymask' && mask.visible !== '0' && mask.filename);
			if (groupMask?.filename) {
				try {
					const maskPath = kraEntryPath(files, documentName, groupMask.filename, '.pixelselection');
					if (!maskPath) { throw new Error('missing pixel data'); }
					const defaultMaskPath = kraEntryPath(files, documentName, groupMask.filename, '.pixelselection.defaultpixel');
					groupAsset.rasterMask = { data: decodeKraPaintDevice(files[maskPath], declaredWidth, declaredHeight, 1, defaultMaskPath ? files[defaultMaskPath] : undefined), width: declaredWidth, height: declaredHeight, channels: 1, typeMax: 255, x: 0, y: 0 };
				} catch (error) { warnings.push(`Transparency mask for group “${name}” could not be decoded: ${error instanceof Error ? error.message : String(error)}`); }
			}
			assets.push(groupAsset);
			summary.children = build(node.children, id, [...groupPath, name], [...groupIds, id]);
			return summary;
		}
		if (kind === 'adjustment' && attrs.filename) {
			const configPath = kraEntryPath(files, documentName, attrs.filename, '.filterconfig');
			const adjustment = configPath ? kraAdjustment(attrs.filtername, decodeXml(files[configPath])) : undefined;
			if (adjustment) {
				summary.support = 'approximate';
				const asset: LayeredRasterAsset = {
					nodeId: id, name, sourcePath: configPath || '', kind: 'adjustment', adjustment, parentId,
					width: declaredWidth, height: declaredHeight, x: 0, y: 0, opacity, visible, blendMode,
					groupPath, groupIds, support: 'approximate',
				};
				const selectionPath = kraEntryPath(files, documentName, attrs.filename, '.pixelselection');
				if (selectionPath) {
					const defaultSelectionPath = kraEntryPath(files, documentName, attrs.filename, '.pixelselection.defaultpixel');
					asset.rasterMask = { data: decodeKraPaintDevice(files[selectionPath], declaredWidth, declaredHeight, 1, defaultSelectionPath ? files[defaultSelectionPath] : undefined), width: declaredWidth, height: declaredHeight, channels: 1, typeMax: 255, x: 0, y: 0 };
				}
				assets.push(asset);
			} else {
				summary.support = 'unsupported';
				warnings.push(`Krita adjustment layer “${name}” uses unsupported filter “${attrs.filtername || 'unknown'}”`);
			}
			return summary;
		}
		if (kind !== 'raster' || !attrs.filename) {
			warnings.push(`Krita ${nodeType || 'unknown'} node “${name}” is not an ordinary paint layer`);
			return summary;
		}
		const path = kraEntryPath(files, documentName, attrs.filename);
		try {
			if (!path) { throw new Error(`Missing paint data for ${attrs.filename}`); }
			const defaultPath = kraEntryPath(files, documentName, attrs.filename, '.defaultpixel');
			const pixels = decodeKraPaintDevice(files[path], declaredWidth, declaredHeight, 4, defaultPath ? files[defaultPath] : undefined);
			const asset: LayeredRasterAsset = { nodeId: id, name, sourcePath: path, kind: 'raster', parentId, data: pixels, width: declaredWidth, height: declaredHeight, x: 0, y: 0, opacity, visible, blendMode, groupPath, groupIds, support, clipped: attrs.alphainheritance === '1' || attrs.inheritalpha === '1' || attrs.clipping === '1' };
			const transparencyMask = node.masks.find(mask => (mask.nodetype || '').toLowerCase() === 'transparencymask' && mask.visible !== '0' && mask.filename);
			if (transparencyMask?.filename) {
				const maskPath = kraEntryPath(files, documentName, transparencyMask.filename, '.pixelselection');
				if (maskPath) {
					const defaultMaskPath = kraEntryPath(files, documentName, transparencyMask.filename, '.pixelselection.defaultpixel');
					asset.rasterMask = { data: decodeKraPaintDevice(files[maskPath], declaredWidth, declaredHeight, 1, defaultMaskPath ? files[defaultMaskPath] : undefined), width: declaredWidth, height: declaredHeight, channels: 1, typeMax: 255, x: 0, y: 0 };
				} else { warnings.push(`Transparency mask for “${name}” has no pixel data`); }
			}
			const filterAssets: LayeredRasterAsset[] = [];
			for (let maskIndex = 0; maskIndex < node.masks.length; maskIndex++) {
				const filterMask = node.masks[maskIndex];
				if ((filterMask.nodetype || '').toLowerCase() !== 'filtermask' || filterMask.visible === '0' || !filterMask.filename) { continue; }
				const configPath = kraEntryPath(files, documentName, filterMask.filename, '.filterconfig');
				const adjustment = configPath ? kraAdjustment(filterMask.filtername, decodeXml(files[configPath])) : undefined;
				if (!adjustment) {
					warnings.push(`Krita filter mask “${filterMask.name || filterMask.filename}” uses unsupported filter “${filterMask.filtername || 'unknown'}”`);
					continue;
				}
				const filterAsset: LayeredRasterAsset = {
					nodeId: filterMask.uuid || `${id}-filter-${maskIndex}`, name: filterMask.name || filterMask.filtername || `Filter ${maskIndex + 1}`,
					sourcePath: configPath || '', kind: 'adjustment', adjustment, parentId,
					width: declaredWidth, height: declaredHeight, x: 0, y: 0, opacity: 1, visible: true, blendMode: 'normal',
					groupPath, groupIds, support: 'approximate', clipped: true,
				};
				const selectionPath = kraEntryPath(files, documentName, filterMask.filename, '.pixelselection');
				if (selectionPath) {
					const defaultSelectionPath = kraEntryPath(files, documentName, filterMask.filename, '.pixelselection.defaultpixel');
					filterAsset.rasterMask = { data: decodeKraPaintDevice(files[selectionPath], declaredWidth, declaredHeight, 1, defaultSelectionPath ? files[defaultSelectionPath] : undefined), width: declaredWidth, height: declaredHeight, channels: 1, typeMax: 255, x: 0, y: 0 };
				}
				filterAssets.push(filterAsset);
			}
			// layerAssets are source-order (top-to-bottom), so attached filter
			// masks precede the paint layer they affect.
			assets.push(...filterAssets, asset);
		} catch (error) {
			support = 'unsupported'; summary.support = support;
			summary.warnings = [error instanceof Error ? error.message : String(error)];
			warnings.push(`Krita paint layer “${name}” could not be decoded: ${summary.warnings[0]}`);
		}
		return summary;
	});
	const root = build(roots);
	const document: LayeredDocumentSummary = {
		format: 'kra', width: declaredWidth, height: declaredHeight, bitDepth: 8, colorMode: xmlAttribute(xml, 'colorspacename') || 'RGBA',
		previewKind: 'merged', previewIsAuthoritative: previewName === 'mergedimage.png' && decoded.width === declaredWidth && decoded.height === declaredHeight,
		previewWidth: decoded.width, previewHeight: decoded.height, layerCount: flattenNodeCount(root), root, warnings,
	};
	return { ...decoded, channels: 4, bitDepth: 8, sampleFormat: 1, layerAssets: assets, formatLabel: 'Krita integrated preview', formatType: 'kra', document, metadata: { container: 'ZIP', previewEntry: previewName, previewAuthoritative: document.previewIsAuthoritative, layerCount: document.layerCount, editableNodeCount: assets.length, documentWidth: declaredWidth, documentHeight: declaredHeight } };
}

function unzipSelected(buffer: ArrayBuffer, wanted: (name: string) => boolean): Record<string, Uint8Array> {
	let selectedBytes = 0;
	return unzipSync(new Uint8Array(buffer), {
		filter(file) {
			const safeName = file.name.replace(/\\/g, '/');
			if (safeName.startsWith('/') || safeName.split('/').includes('..')) {
				throw new Error(`Unsafe ZIP entry path: ${file.name}`);
			}
			if (!wanted(safeName)) { return false; }
			if (file.originalSize > MAX_ZIP_ENTRY_BYTES) {
				throw new Error(`ZIP entry is too large: ${file.name}`);
			}
			selectedBytes += file.originalSize;
			if (selectedBytes > MAX_ZIP_ENTRY_BYTES) {
				throw new Error('Selected ZIP preview entries exceed the memory limit');
			}
			return true;
		},
	});
}

function archivePreviewResult(
	format: 'ora' | 'kra',
	buffer: ArrayBuffer,
): DecodedLayeredPreview {
	const wantedNames = format === 'ora'
		? new Set(['mergedimage.png', 'Thumbnails/thumbnail.png', 'stack.xml', 'mimetype'])
		: new Set(['mergedimage.png', 'preview.png', 'documentinfo.xml', 'maindoc.xml', 'mimetype']);
	const files = unzipSelected(buffer, name => wantedNames.has(name));
	const previewName = format === 'ora'
		? (files['mergedimage.png'] ? 'mergedimage.png' : 'Thumbnails/thumbnail.png')
		: (files['mergedimage.png'] ? 'mergedimage.png' : 'preview.png');
	const previewBytes = files[previewName];
	if (!previewBytes) {
		throw new Error(`${format.toUpperCase()} contains no integrated preview image`);
	}
	const decoded = decodePngRgba(previewBytes);
	const xmlName = format === 'ora' ? 'stack.xml' : 'maindoc.xml';
	const xml = decodeXml(files[xmlName]);
	const layerCount = countMatches(xml, /<layer\b/gi);
	const declaredWidth = Number(xmlAttribute(xml, 'w') || xmlAttribute(xml, 'width') || decoded.width);
	const declaredHeight = Number(xmlAttribute(xml, 'h') || xmlAttribute(xml, 'height') || decoded.height);
	const isFullSize = decoded.width === declaredWidth && decoded.height === declaredHeight;
	if (format === 'ora' && isFullSize) {
		const result = decodeOraResult(buffer, previewName, decoded, xml, declaredWidth, declaredHeight);
		const mime = decodeXml(files.mimetype).trim();
		if (mime !== 'image/openraster') {
			result.document.warnings.unshift(mime ? `Unexpected OpenRaster MIME marker: ${mime}` : 'OpenRaster MIME marker is missing');
		}
		return result;
	}
	if (format === 'kra') {
		return decodeKraResult(buffer, previewName, decoded, xml, declaredWidth, declaredHeight);
	}
	const warnings: string[] = [];
	if (format === 'ora' && !xml.trim()) { warnings.push('OpenRaster stack.xml is missing; only the integrated preview is available'); }
	if (format === 'ora') {
		const mime = decodeXml(files.mimetype).trim();
		if (mime !== 'image/openraster') { warnings.push(mime ? `Unexpected OpenRaster MIME marker: ${mime}` : 'OpenRaster MIME marker is missing'); }
	}
	if (!isFullSize) {
		warnings.push(`Embedded preview is ${decoded.width}x${decoded.height}; document canvas is ${declaredWidth}x${declaredHeight}`);
	}
	const document: LayeredDocumentSummary = {
		format,
		width: declaredWidth,
		height: declaredHeight,
		bitDepth: 8,
		colorMode: 'RGBA preview',
		previewKind: 'merged',
		previewIsAuthoritative: previewName === 'mergedimage.png' && isFullSize,
		previewWidth: decoded.width,
		previewHeight: decoded.height,
		layerCount,
		root: [],
		warnings,
	};
	return {
		...decoded,
		channels: 4,
		bitDepth: 8,
		sampleFormat: 1,
		formatLabel: format === 'ora' ? 'OpenRaster integrated preview' : 'Krita integrated preview',
		formatType: format,
		document,
		metadata: {
			container: 'ZIP',
			previewEntry: previewName,
			previewAuthoritative: document.previewIsAuthoritative,
			layerCount,
			documentWidth: declaredWidth,
			documentHeight: declaredHeight,
		},
	};
}

function psdLayerKind(layer: any): LayerNodeKind {
	if (Array.isArray(layer.children)) { return 'group'; }
	if (layer.text) { return 'text'; }
	if (layer.placedLayer || layer.linkedFile) { return 'smart-object'; }
	if (layer.vectorMask || layer.vectorFill || layer.vectorStroke) { return 'vector'; }
	if (layer.adjustment) { return 'adjustment'; }
	return 'raster';
}

function summarizePsdLayers(layers: any[] | undefined, path = 'layer'): LayerNodeSummary[] {
	if (!Array.isArray(layers)) { return []; }
	return layers.map((layer, index) => {
		const kind = psdLayerKind(layer);
		const adjustmentSupported = !!supportedPsdAdjustment(layer.adjustment);
		const children = summarizePsdLayers(layer.children, `${path}-${index}`);
		const node: LayerNodeSummary = {
			id: `${path}-${index}`,
			name: String(layer.name || `Layer ${index + 1}`),
			kind,
			support: kind === 'group' ? (layer.blendMode === 'pass through' ? 'approximate' : 'native') : kind === 'adjustment' ? (adjustmentSupported ? 'approximate' : 'unsupported') : layer.imageData?.data ? (kind === 'raster' ? 'native' : 'cached-raster') : 'unsupported',
			visible: !layer.hidden,
			opacity: Number.isFinite(layer.opacity) ? Math.max(0, Math.min(1, layer.opacity)) : 1,
			blendMode: layer.blendMode || 'normal',
			left: layer.left,
			top: layer.top,
			width: Number.isFinite(layer.right) && Number.isFinite(layer.left) ? layer.right - layer.left : undefined,
			height: Number.isFinite(layer.bottom) && Number.isFinite(layer.top) ? layer.bottom - layer.top : undefined,
		};
		if (children.length) { node.children = children; }
		return node;
	});
}

function psdMaskAsset(mask: any, layerLeft: number, layerTop: number): LayeredRasterAsset['rasterMask'] | undefined {
	if (!mask?.imageData?.data || mask.disabled) { return undefined; }
	const source = mask.imageData.data as ArrayLike<number>, pixels = mask.imageData.width * mask.imageData.height;
	const channels = Math.max(1, Math.floor(source.length / Math.max(1, pixels)));
	const data = new Uint8Array(pixels);
	for (let pixel = 0; pixel < pixels; pixel++) { data[pixel] = Number(source[pixel * channels]); }
	const relative = !!mask.positionRelativeToLayer;
	return {
		data, width: mask.imageData.width, height: mask.imageData.height, channels: 1, typeMax: 255,
		x: Math.trunc(Number(mask.left || 0) + (relative ? layerLeft : 0)),
		y: Math.trunc(Number(mask.top || 0) + (relative ? layerTop : 0)),
	};
}

function supportedPsdAdjustment(value: any): LayerAdjustment | undefined {
	if (!value || !['levels', 'curves', 'hue/saturation', 'brightness/contrast', 'exposure', 'invert', 'channel mixer', 'color balance', 'black & white', 'threshold', 'posterize', 'gradient map'].includes(value.type)) { return undefined; }
	if (value.type === 'hue/saturation' && Number(value.master?.a) === 256) {
		// Legacy PSD hue2 stores the Colorize flag as a padded byte (read by
		// ag-psd as 0x0100), followed by colorize hue/saturation/lightness in
		// the otherwise range-boundary fields b/c/d.
		return {
			...value,
			colorizeEnabled: true,
			colorize: {
				hue: Number(value.master?.b || 0),
				saturation: Number(value.master?.c || 0),
				lightness: Number(value.master?.d || 0),
			},
		} as LayerAdjustment;
	}
	if (value.type === 'gradient map') {
		const toRgb = (color: any): { r: number; g: number; b: number } => {
			if (Number.isFinite(color?.r)) { return { r: color.r, g: color.g, b: color.b }; }
			if (Number.isFinite(color?.fr)) { return { r: color.fr * 255, g: color.fg * 255, b: color.fb * 255 }; }
			if (Number.isFinite(color?.k)) { const gray = 255 - color.k; return { r: gray, g: gray, b: gray }; }
			return { r: 0, g: 0, b: 0 };
		};
		return {
			type: 'gradient map', reverse: !!value.reverse,
			stops: Array.isArray(value.colorStops) ? value.colorStops.map((stop: any) => ({
				position: Math.max(0, Math.min(1, Number(stop.location || 0) / 4096)), color: toRgb(stop.color),
			})) : undefined,
		};
	}
	return value as LayerAdjustment;
}

function buildPsdAssets(layers: any[] | undefined, warnings: string[], parentId?: string, groupPath: string[] = [], groupIds: string[] = [], path = 'psd'): LayeredRasterAsset[] {
	if (!Array.isArray(layers)) { return []; }
	const assets: LayeredRasterAsset[] = [];
	for (let index = 0; index < layers.length; index++) {
		const layer = layers[index], id = Number.isFinite(layer.id) ? `psd-${layer.id}` : `${path}-${index}`;
		const name = String(layer.name || `Layer ${index + 1}`), kind = psdLayerKind(layer);
		const opacity = Number.isFinite(layer.opacity) ? Math.max(0, Math.min(1, Number(layer.opacity))) : 1;
		const visible = !layer.hidden, blendMode = editableBlendMode(layer.blendMode);
		if (kind === 'group') {
			assets.push({ nodeId: id, name, sourcePath: '', kind: 'group', parentId, width: 1, height: 1, x: 0, y: 0, opacity, visible, blendMode, groupPath, groupIds, support: layer.blendMode === 'pass through' ? 'approximate' : 'native' });
			assets.push(...buildPsdAssets(layer.children, warnings, id, [...groupPath, name], [...groupIds, id], id));
			continue;
		}
		const left = Math.trunc(Number(layer.left || 0)), top = Math.trunc(Number(layer.top || 0));
		const effectNames = layer.effects ? Object.keys(layer.effects).filter(key => key !== 'scale') : [];
		if (effectNames.length) { warnings.push(`PSD layer effects on “${name}” (${effectNames.join(', ')}) are not reconstructed; cached pixels or the integrated preview may include them`); }
		const activeMask = layer.realMask || layer.mask;
		if (activeMask?.userMaskFeather || activeMask?.vectorMaskFeather) { warnings.push(`PSD mask feathering on “${name}” is not reconstructed`); }
		if (activeMask?.userMaskDensity !== undefined && activeMask.userMaskDensity !== 100) { warnings.push(`PSD mask density on “${name}” is approximated`); }
		const adjustment = supportedPsdAdjustment(layer.adjustment);
		if (layer.adjustment) {
			const supported = !!adjustment;
			if (!supported) { warnings.push(`PSD adjustment “${name}” (${layer.adjustment.type || 'unknown'}) is inspect-only`); }
			assets.push({ nodeId: id, name, sourcePath: '', kind: 'adjustment', adjustment, parentId, width: 1, height: 1, x: 0, y: 0, opacity, visible, blendMode, groupPath, groupIds, support: supported ? 'approximate' : 'unsupported', clipped: !!layer.clipping, rasterMask: psdMaskAsset(layer.realMask || layer.mask, left, top) });
			continue;
		}
		if (!layer.imageData?.data) { warnings.push(`PSD ${kind} layer “${name}” has no cached raster pixels`); continue; }
		const source = layer.imageData.data as ArrayLike<number>;
		const data = new Uint8Array(source.length);
		for (let offset = 0; offset < source.length; offset++) { data[offset] = Math.max(0, Math.min(255, Math.round(Number(source[offset])))); }
		assets.push({ nodeId: id, name, sourcePath: '', kind: 'raster', parentId, data, width: layer.imageData.width, height: layer.imageData.height, x: left, y: top, opacity, visible, blendMode, groupPath, groupIds, support: kind === 'raster' ? 'native' : 'cached-raster', clipped: !!layer.clipping, rasterMask: psdMaskAsset(layer.realMask || layer.mask, left, top) });
	}
	return assets;
}

function flattenNodeCount(nodes: LayerNodeSummary[]): number {
	let count = 0;
	for (const node of nodes) { count += 1 + flattenNodeCount(node.children || []); }
	return count;
}

function decodePsdPreview(buffer: ArrayBuffer, psb: boolean): DecodedLayeredPreview {
	ensurePsdImageDataFactory();
	let layerDecodeWarning = '';
	let psd: any;
	try {
		psd = readPsd(buffer, {
			useImageData: true, skipLayerImageData: false, skipThumbnail: true,
			skipLinkedFilesData: true, logMissingFeatures: false, totalMemoryLimit: MAX_PSD_MEMORY_BYTES,
		});
	} catch (error) {
		// A valid integrated preview remains useful when decoding every layer would
		// exceed the bounded memory budget or encounters an unsupported payload.
		layerDecodeWarning = `PSD editable layers were unavailable: ${error instanceof Error ? error.message : String(error)}`;
		psd = readPsd(buffer, {
			useImageData: true, skipLayerImageData: true, skipThumbnail: true,
			skipLinkedFilesData: true, logMissingFeatures: false, totalMemoryLimit: MAX_PSD_MEMORY_BYTES,
		});
	}
	if (!psd.imageData?.data) { throw new Error('PSD contains no decodable composite image'); }
	const bitDepth = Number(psd.bitsPerChannel || 8);
	assertDimensions(psd.width, psd.height, bitDepth === 32 ? 16 : bitDepth === 16 ? 8 : 4);
	const data = psd.imageData.data as LayeredPixelArray;
	const root = summarizePsdLayers(psd.children);
	const layerCount = flattenNodeCount(root);
	const colorModes: Record<number, string> = { 0: 'Bitmap', 1: 'Grayscale', 2: 'Indexed', 3: 'RGB', 4: 'CMYK', 7: 'Multichannel', 8: 'Duotone', 9: 'Lab' };
	const colorMode = colorModes[Number(psd.colorMode)] || `Mode ${psd.colorMode}`;
	const warnings: string[] = [];
	if (layerDecodeWarning) { warnings.push(layerDecodeWarning); }
	if (Number(psd.colorMode) !== 3) { warnings.push(`${colorMode} is converted to RGB by the PSD decoder; exact Photoshop color-management parity is unavailable`); }
	if (bitDepth !== 8) { warnings.push(`${bitDepth}-bit PSD layers depend on decoder conversion and may not match Photoshop exactly`); }
	const layerAssets = buildPsdAssets(psd.children, warnings);
	const document: LayeredDocumentSummary = {
		format: psb ? 'psb' : 'psd', width: psd.width, height: psd.height, bitDepth, colorMode,
		previewKind: 'integrated', previewIsAuthoritative: true,
		previewWidth: psd.width, previewHeight: psd.height,
		layerCount, root, warnings,
	};
	return {
		width: psd.width, height: psd.height, channels: 4, bitDepth,
		sampleFormat: bitDepth === 32 ? 3 : 1,
		data,
		layerAssets,
		// ag-psd exposes the PSD sibling sequence in compositing order: raster
		// bases precede their clipped adjustment layers.
		layerOrder: 'bottom-to-top',
		formatLabel: `${psb ? 'Photoshop PSB' : 'Photoshop PSD'} composite`,
		formatType: psb ? 'psb' : 'psd',
		document,
		metadata: {
			colorMode, bitDepth, layerCount, editableNodeCount: layerAssets.length,
			previewAuthoritative: true,
			decoder: 'ag-psd',
		},
	};
}

function findPngEnd(bytes: Uint8Array, start: number): number | null {
	let offset = start + 8;
	while (offset + 12 <= bytes.length) {
		const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
		if (length > MAX_PREVIEW_BYTES || offset + 12 + length > bytes.length) { return null; }
		const a = bytes[offset + 4], b = bytes[offset + 5], c = bytes[offset + 6], d = bytes[offset + 7];
		offset += 12 + length;
		if (a === 73 && b === 69 && c === 78 && d === 68) { return offset; }
	}
	return null;
}

function decodeAffinityPreview(buffer: ArrayBuffer): DecodedLayeredPreview {
	const bytes = new Uint8Array(buffer);
	if (bytes.length < 4 || bytes[0] !== 0 || bytes[1] !== 0xff || bytes[2] !== 0x4b || bytes[3] !== 0x41) {
		throw new Error('Invalid Affinity document signature');
	}
	let best: { bytes: Uint8Array; width: number; height: number } | null = null;
	for (let start = 4; start <= bytes.length - PNG_SIGNATURE.length; start++) {
		let matches = true;
		for (let i = 0; i < PNG_SIGNATURE.length; i++) {
			if (bytes[start + i] !== PNG_SIGNATURE[i]) { matches = false; break; }
		}
		if (!matches || start + 24 > bytes.length) { continue; }
		const view = new DataView(bytes.buffer, bytes.byteOffset + start + 16, 8);
		const width = view.getUint32(0, false), height = view.getUint32(4, false);
		try { assertDimensions(width, height, 4); } catch { continue; }
		const end = findPngEnd(bytes, start);
		if (!end) { continue; }
		if (!best || width * height > best.width * best.height) {
			best = { bytes: bytes.slice(start, end), width, height };
		}
		start = end - 1;
	}
	if (!best) { throw new Error('Affinity document contains no supported embedded PNG preview'); }
	const decoded = decodePngRgba(best.bytes);
	const warnings = ['Affinity document layers are proprietary and were not decoded', 'Embedded preview may be smaller or older than the document canvas'];
	const document: LayeredDocumentSummary = {
		format: 'affinity', width: decoded.width, height: decoded.height, bitDepth: 8,
		colorMode: 'Unknown (embedded RGBA preview)', previewKind: 'embedded',
		previewIsAuthoritative: false, previewWidth: decoded.width, previewHeight: decoded.height,
		layerCount: 0, root: [], warnings,
	};
	return {
		...decoded, channels: 4, bitDepth: 8, sampleFormat: 1,
		formatLabel: 'Affinity embedded preview', formatType: 'affinity', document,
		metadata: { previewAuthoritative: false, previewWidth: decoded.width, previewHeight: decoded.height, decoder: 'embedded PNG scanner' },
	};
}

class XcfReader {
	view: DataView;
	bytes: Uint8Array;
	version: number;
	pointerBytes: number;
	constructor(buffer: ArrayBuffer, version: number) {
		this.view = new DataView(buffer); this.bytes = new Uint8Array(buffer);
		this.version = version; this.pointerBytes = version >= 11 ? 8 : 4;
	}
	check(offset: number, length: number): void {
		if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.view.byteLength) {
			throw new Error('XCF structure points outside the file');
		}
	}
	u8(offset: number): number { this.check(offset, 1); return this.view.getUint8(offset); }
	u32(offset: number): number { this.check(offset, 4); return this.view.getUint32(offset, false); }
	i32(offset: number): number { this.check(offset, 4); return this.view.getInt32(offset, false); }
	f32(offset: number): number { this.check(offset, 4); return this.view.getFloat32(offset, false); }
	pointer(offset: number): number {
		if (this.pointerBytes === 4) { return this.u32(offset); }
		this.check(offset, 8);
		const value = this.view.getBigUint64(offset, false);
		if (value > BigInt(Number.MAX_SAFE_INTEGER)) { throw new Error('XCF pointer exceeds JavaScript safe integer range'); }
		return Number(value);
	}
	string(offset: number): { value: string; next: number } {
		const length = this.u32(offset); offset += 4;
		if (length === 0) { return { value: '', next: offset }; }
		this.check(offset, length);
		return { value: new TextDecoder().decode(this.bytes.subarray(offset, offset + Math.max(0, length - 1))), next: offset + length };
	}
}

interface XcfProperties {
	next: number;
	compression?: number;
	opacity?: number;
	visible?: boolean;
	offsetX?: number;
	offsetY?: number;
	mode?: number;
	group?: boolean;
	itemPath?: number[];
	colormap?: Uint8Array;
}

interface XcfEffect {
	name: string;
	operation: string;
	visible: boolean;
	opacity: number;
	adjustment?: LayerAdjustment;
}

function readXcfProperties(reader: XcfReader, start: number): XcfProperties {
	const out: XcfProperties = { next: start };
	let offset = start;
	for (let count = 0; count < 100_000; count++) {
		const type = reader.u32(offset), length = reader.u32(offset + 4); offset += 8;
		if (type === 0) { out.next = offset; return out; }
		reader.check(offset, length);
		if (type === 17 && length >= 1) { out.compression = reader.u8(offset); }
		else if (type === 6 && length >= 4) { out.opacity = reader.u32(offset) / 255; }
		else if (type === 33 && length >= 4) { out.opacity = reader.f32(offset); }
		else if (type === 8 && length >= 4) { out.visible = reader.u32(offset) !== 0; }
		else if (type === 15 && length >= 8) { out.offsetX = reader.i32(offset); out.offsetY = reader.i32(offset + 4); }
		else if (type === 7 && length >= 4) { out.mode = reader.u32(offset); }
		else if (type === 29) { out.group = true; }
		else if (type === 30 && length % 4 === 0) {
			out.itemPath = [];
			for (let i = 0; i < length; i += 4) { out.itemPath.push(reader.u32(offset + i)); }
		}
		else if (type === 1 && length >= 4) {
			const countColors = Math.min(256, reader.u32(offset));
			reader.check(offset + 4, countColors * 3);
			out.colormap = reader.bytes.slice(offset + 4, offset + 4 + countColors * 3);
		}
		offset += length;
	}
	throw new Error('XCF property list exceeds the safety limit');
}

function xcfEffectAdjustment(operation: string, args: Record<string, string | number | boolean>): LayerAdjustment | undefined {
	const preserved = args['tiff-visualizer-adjustment'];
	if (typeof preserved === 'string') {
		try {
			const value = JSON.parse(preserved) as LayerAdjustment;
			if (value && typeof value === 'object' && typeof value.type === 'string') { return value; }
		} catch {
			// Continue with interoperable GEGL arguments if an unrelated writer
			// happens to use the same argument name with invalid data.
		}
	}
	const op = operation.toLowerCase().replace(/^(?:gegl|gimp):/, '').replace(/_/g, '-');
	const number = (names: string[], fallback: number): number => {
		for (const name of names) {
			const value = Number(args[name]);
			if (Number.isFinite(value)) { return value; }
		}
		return fallback;
	};
	if (op === 'brightness-contrast') {
		return { type: 'brightness/contrast', brightness: number(['brightness'], 0) * 100, contrast: number(['contrast'], 0) * 100 };
	}
	if (op === 'exposure') {
		return { type: 'exposure', exposure: number(['exposure'], 0), offset: -number(['black-level', 'black_level'], 0), gamma: 1 };
	}
	if (['invert', 'invert-linear', 'invert-gamma', 'value-invert'].includes(op)) { return { type: 'invert' }; }
	if (op === 'threshold') { return { type: 'threshold', level: number(['value', 'threshold'], 0.5) * 255 }; }
	if (op === 'posterize') { return { type: 'posterize', levels: number(['levels'], 4) }; }
	if (['hue-chroma', 'hue-saturation'].includes(op)) {
		return { type: 'hue/saturation', master: { hue: number(['hue'], 0), saturation: number(['chroma', 'saturation'], 0), lightness: number(['lightness'], 0) }, colorize: { hue: 0, saturation: 100, lightness: 0 }, colorizeEnabled: false };
	}
	if (op === 'saturation') {
		return { type: 'hue/saturation', master: { hue: 0, saturation: (number(['scale'], 1) - 1) * 100, lightness: 0 }, colorize: { hue: 0, saturation: 100, lightness: 0 }, colorizeEnabled: false };
	}
	if (op === 'levels') {
		return {
			type: 'levels',
			rgb: {
				shadowInput: number(['in-low', 'in_low'], 0) * 255, highlightInput: number(['in-high', 'in_high'], 1) * 255,
				midtoneInput: 1, shadowOutput: number(['out-low', 'out_low'], 0) * 255, highlightOutput: number(['out-high', 'out_high'], 1) * 255,
			},
		};
	}
	if (['channel-mixer', 'mono-mixer'].includes(op)) {
		const gain = (names: string[], fallback: number) => number(names, fallback) * 100;
		if (op === 'mono-mixer') {
			return { type: 'channel mixer', monochrome: true, gray: { red: gain(['red', 'red-gain'], 0.4), green: gain(['green', 'green-gain'], 0.4), blue: gain(['blue', 'blue-gain'], 0.2), constant: 0 } };
		}
		return {
			type: 'channel mixer',
			red: { red: gain(['rr-gain', 'red-red'], 1), green: gain(['rg-gain', 'red-green'], 0), blue: gain(['rb-gain', 'red-blue'], 0), constant: gain(['red-offset'], 0) },
			green: { red: gain(['gr-gain', 'green-red'], 0), green: gain(['gg-gain', 'green-green'], 1), blue: gain(['gb-gain', 'green-blue'], 0), constant: gain(['green-offset'], 0) },
			blue: { red: gain(['br-gain', 'blue-red'], 0), green: gain(['bg-gain', 'blue-green'], 0), blue: gain(['bb-gain', 'blue-blue'], 1), constant: gain(['blue-offset'], 0) },
		};
	}
	if (op === 'color-balance') {
		const range = (name: string) => ({
			cyanRed: number([`${name}-cyan-red`, `${name}-cyan_red`], 0) * 100,
			magentaGreen: number([`${name}-magenta-green`, `${name}-magenta_green`], 0) * 100,
			yellowBlue: number([`${name}-yellow-blue`, `${name}-yellow_blue`], 0) * 100,
		});
		return { type: 'color balance', shadows: range('shadows'), midtones: range('midtones'), highlights: range('highlights'), preserveLuminosity: args['preserve-luminosity'] !== false };
	}
	return undefined;
}

function decodeXcfEffect(reader: XcfReader, pointer: number): XcfEffect {
	let cursor = pointer;
	const name = reader.string(cursor); cursor = name.next;
	const icon = reader.string(cursor); cursor = icon.next;
	const operation = reader.string(cursor); cursor = operation.next;
	if (reader.version >= 22) { cursor = reader.string(cursor).next; }
	let visible = true, opacity = 1;
	const args: Record<string, string | number | boolean> = {};
	for (let count = 0; count < 100_000; count++) {
		const type = reader.u32(cursor), length = reader.u32(cursor + 4); cursor += 8;
		if (type === 0) { break; }
		reader.check(cursor, length);
		const end = cursor + length;
		if (type === 8 && length >= 4) { visible = reader.u32(cursor) !== 0; }
		else if (type === 33 && length >= 4) { opacity = Math.max(0, Math.min(1, reader.f32(cursor))); }
		else if (type === 45 && length >= 8) {
			const argumentName = reader.string(cursor); let valueCursor = argumentName.next;
			const argumentType = reader.u32(valueCursor); valueCursor += 4;
			if ([1, 5].includes(argumentType) && valueCursor + 4 <= end) { args[argumentName.value] = reader.i32(valueCursor); }
			else if ([2, 7].includes(argumentType) && valueCursor + 4 <= end) { args[argumentName.value] = argumentType === 2 ? reader.u32(valueCursor) !== 0 : reader.u32(valueCursor); }
			else if (argumentType === 3 && valueCursor + 4 <= end) { args[argumentName.value] = reader.f32(valueCursor); }
			else if ([4, 6].includes(argumentType) && valueCursor + 4 <= end) {
				const value = reader.string(valueCursor);
				if (value.next <= end) { args[argumentName.value] = value.value; }
			}
		}
		cursor = end;
	}
	return { name: name.value || operation.value, operation: operation.value, visible, opacity, adjustment: xcfEffectAdjustment(operation.value, args) };
}

function decodeXcfRle(reader: XcfReader, start: number, pixelCount: number, bpp: number): Uint8Array {
	const output = new Uint8Array(pixelCount * bpp);
	let input = start;
	for (let channel = 0; channel < bpp; channel++) {
		let written = 0;
		while (written < pixelCount) {
			const opcode = reader.u8(input++);
			if (opcode <= 126) {
				const length = opcode + 1, value = reader.u8(input++);
				if (written + length > pixelCount) { throw new Error('Invalid XCF RLE run'); }
				for (let i = 0; i < length; i++) { output[(written++ * bpp) + channel] = value; }
			} else if (opcode === 127) {
				const length = reader.u8(input) * 256 + reader.u8(input + 1); input += 2;
				const value = reader.u8(input++);
				if (length <= 0 || written + length > pixelCount) { throw new Error('Invalid XCF long RLE run'); }
				for (let i = 0; i < length; i++) { output[(written++ * bpp) + channel] = value; }
			} else {
				const length = opcode === 128 ? reader.u8(input) * 256 + reader.u8(input + 1) : 256 - opcode;
				if (opcode === 128) { input += 2; }
				if (length <= 0 || written + length > pixelCount) { throw new Error('Invalid XCF RLE literal'); }
				reader.check(input, length);
				for (let i = 0; i < length; i++) { output[(written++ * bpp) + channel] = reader.u8(input++); }
			}
		}
	}
	return output;
}

function decodeXcfTile(reader: XcfReader, pointer: number, pixelCount: number, bpp: number, compression: number, nextPointer?: number): Uint8Array {
	const byteCount = pixelCount * bpp;
	if (compression === 0) { reader.check(pointer, byteCount); return reader.bytes.slice(pointer, pointer + byteCount); }
	if (compression === 1) { return decodeXcfRle(reader, pointer, pixelCount, bpp); }
	if (compression === 2) {
		const payloadEnd = nextPointer && nextPointer > pointer ? nextPointer : reader.view.byteLength;
		reader.check(pointer, payloadEnd - pointer);
		const inflated = pako.inflate(reader.bytes.subarray(pointer, payloadEnd));
		if (inflated.length !== byteCount) { throw new Error('XCF zlib tile decoded to an unexpected size'); }
		return inflated;
	}
	throw new Error(`Unsupported XCF compression: ${compression}`);
}

function xcfPixelToRgba(raw: Uint8Array, base: number, type: number, colormap?: Uint8Array): [number, number, number, number] {
	if (type === 0 || type === 1) { return [raw[base], raw[base + 1], raw[base + 2], type === 1 ? raw[base + 3] : 255]; }
	if (type === 2 || type === 3) { const v = raw[base]; return [v, v, v, type === 3 ? raw[base + 1] : 255]; }
	const index = raw[base] * 3;
	return [colormap?.[index] || 0, colormap?.[index + 1] || 0, colormap?.[index + 2] || 0, type === 5 ? raw[base + 1] : 255];
}

function xcfBlendMode(mode: number): string {
	const legacy: Record<number, string> = { 0: 'normal', 3: 'multiply', 4: 'screen', 5: 'overlay', 6: 'difference', 9: 'darken', 10: 'lighten' };
	return legacy[mode] || `gimp-${mode}`;
}

function decodeXcfPreview(buffer: ArrayBuffer): DecodedLayeredPreview {
	const signature = new TextDecoder('ascii').decode(new Uint8Array(buffer, 0, Math.min(14, buffer.byteLength)));
	if (!signature.startsWith('gimp xcf ')) { throw new Error('Invalid XCF signature'); }
	const tag = signature.slice(9, 13);
	const version = tag === 'file' ? 0 : Number(tag.slice(1));
	if (!Number.isInteger(version) || version < 0 || version > 25) { throw new Error(`Unsupported XCF version tag: ${tag}`); }
	const reader = new XcfReader(buffer, version);
	let offset = 14;
	const width = reader.u32(offset), height = reader.u32(offset + 4), baseType = reader.u32(offset + 8); offset += 12;
	const precision = version >= 4 ? reader.u32(offset) : 150;
	if (version >= 4) { offset += 4; }
	assertDimensions(width, height, 4);
	if (precision !== 150 && !(version === 4 && precision === 0)) {
		throw new Error(`XCF preview currently supports 8-bit gamma integer data; file precision is ${precision}`);
	}
	const imageProps = readXcfProperties(reader, offset); offset = imageProps.next;
	const compression = imageProps.compression ?? 1;
	const layerPointers: number[] = [];
	for (let count = 0; count < 100_000; count++, offset += reader.pointerBytes) {
		const pointer = reader.pointer(offset); if (!pointer) { offset += reader.pointerBytes; break; }
		layerPointers.push(pointer);
	}
	// Skip the channel pointer list for this first raster-preview implementation.
	const layers: { node: LayerNodeSummary; pixels?: Uint8Array; effects: XcfEffect[]; type: number; opacity: number; x: number; y: number; width: number; height: number; mode: number; parentId?: string; groupPath: string[]; groupIds: string[] }[] = [];
	const warnings: string[] = [];
	const groupsByPath = new Map<string, { id: string; names: string[]; ids: string[] }>();
	for (let index = 0; index < layerPointers.length; index++) {
		let cursor = layerPointers[index];
		const layerWidth = reader.u32(cursor), layerHeight = reader.u32(cursor + 4), type = reader.u32(cursor + 8); cursor += 12;
		assertDimensions(layerWidth, layerHeight, 4);
		const name = reader.string(cursor); cursor = name.next;
		const props = readXcfProperties(reader, cursor); cursor = props.next;
		const hierarchyPointer = reader.pointer(cursor); cursor += reader.pointerBytes;
		const maskPointer = reader.pointer(cursor); cursor += reader.pointerBytes;
		const effects: XcfEffect[] = [];
		if (version >= 20) {
			for (let effectIndex = 0; effectIndex < 10_000; effectIndex++, cursor += reader.pointerBytes) {
				const effectPointer = reader.pointer(cursor);
				if (!effectPointer) { break; }
				try { effects.push(decodeXcfEffect(reader, effectPointer)); }
				catch (error) { warnings.push(`An effect on layer “${name.value || `Layer ${index + 1}`}” could not be decoded: ${error instanceof Error ? error.message : String(error)}`); }
			}
		}
		const mode = props.mode ?? 0;
		const itemPath = props.itemPath || [index];
		const parentPath = itemPath.slice(0, -1).join('/');
		const parent = groupsByPath.get(parentPath);
		const blendMode = xcfBlendMode(mode);
		const node: LayerNodeSummary = {
			id: `xcf-layer-${index}`, name: name.value || `Layer ${index + 1}`,
			kind: props.group ? 'group' : 'raster', support: props.group || blendMode !== `gimp-${mode}` ? 'native' : 'approximate',
			visible: props.visible !== false, opacity: props.opacity ?? 1, blendMode,
			left: props.offsetX || 0, top: props.offsetY || 0, width: layerWidth, height: layerHeight,
		};
		let pixels: Uint8Array | undefined;
		if (!props.group && hierarchyPointer) {
			const hierarchyWidth = reader.u32(hierarchyPointer), hierarchyHeight = reader.u32(hierarchyPointer + 4), bpp = reader.u32(hierarchyPointer + 8);
			if (hierarchyWidth !== layerWidth || hierarchyHeight !== layerHeight || bpp < 1 || bpp > 4) { throw new Error('Unsupported XCF layer hierarchy'); }
			const levelPointer = reader.pointer(hierarchyPointer + 12);
			if (!levelPointer) { throw new Error('XCF layer has no pixel level'); }
			const levelWidth = reader.u32(levelPointer), levelHeight = reader.u32(levelPointer + 4);
			if (levelWidth !== layerWidth || levelHeight !== layerHeight) { throw new Error('Unsupported XCF level dimensions'); }
			let tileCursor = levelPointer + 8;
			const tilePointers: number[] = [];
			for (let tile = 0; tile < 1_000_000; tile++, tileCursor += reader.pointerBytes) {
				const pointer = reader.pointer(tileCursor); if (!pointer) { break; } tilePointers.push(pointer);
			}
			const expectedTiles = Math.ceil(layerWidth / 64) * Math.ceil(layerHeight / 64);
			if (tilePointers.length !== expectedTiles) { throw new Error('XCF tile count does not match layer dimensions'); }
			pixels = new Uint8Array(layerWidth * layerHeight * 4);
			const tilesAcross = Math.ceil(layerWidth / 64);
			for (let tile = 0; tile < tilePointers.length; tile++) {
				const tx = (tile % tilesAcross) * 64, ty = Math.floor(tile / tilesAcross) * 64;
				const tw = Math.min(64, layerWidth - tx), th = Math.min(64, layerHeight - ty);
				const raw = decodeXcfTile(reader, tilePointers[tile], tw * th, bpp, compression, tilePointers[tile + 1]);
				for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
					const rgba = xcfPixelToRgba(raw, (y * tw + x) * bpp, type, imageProps.colormap);
					const dest = ((ty + y) * layerWidth + tx + x) * 4;
					pixels.set(rgba, dest);
				}
			}
		}
		if (blendMode.startsWith('gimp-') && !props.group) { warnings.push(`Layer “${node.name}” blend mode ${mode} is approximated as normal`); }
		else if (mode !== 0 && !props.group) { warnings.push(`Layer “${node.name}” uses ${blendMode}; the quick preview is flattened normally, while Layers View preserves the blend mode`); }
		if (props.group) { warnings.push(`Group “${node.name}” is composited as an isolated editable surface after opening Layers View`); }
		if (maskPointer) { warnings.push(`Layer mask on “${node.name}” is present but is not yet decoded by the XCF importer`); }
		for (const effect of effects) if (!effect.adjustment) { warnings.push(`Layer effect “${effect.name}” (${effect.operation}) on “${node.name}” is not supported by the compositor`); }
		if (!props.group && !pixels) { warnings.push(`Layer “${node.name}” has no decodable raster payload`); }
		const groupPath = parent?.names || [], groupIds = parent?.ids || [];
		layers.push({ node, pixels, effects, type, opacity: props.opacity ?? 1, x: props.offsetX || 0, y: props.offsetY || 0, width: layerWidth, height: layerHeight, mode, parentId: parent?.id, groupPath, groupIds });
		if (props.group) { groupsByPath.set(itemPath.join('/'), { id: node.id, names: [...groupPath, node.name], ids: [...groupIds, node.id] }); }
	}
	const composite = new Uint8Array(width * height * 4);
	// XCF layer pointers are top-to-bottom; composite bottom-to-top.
	for (const layer of [...layers].reverse()) {
		if (!layer.node.visible || !layer.pixels) { continue; }
		for (let ly = 0; ly < layer.height; ly++) for (let lx = 0; lx < layer.width; lx++) {
			const dx = layer.x + lx, dy = layer.y + ly;
			if (dx < 0 || dy < 0 || dx >= width || dy >= height) { continue; }
			const si = (ly * layer.width + lx) * 4, di = (dy * width + dx) * 4;
			const sa = (layer.pixels[si + 3] / 255) * layer.opacity, da = composite[di + 3] / 255;
			const oa = sa + da * (1 - sa);
			if (oa <= 0) { continue; }
			for (let c = 0; c < 3; c++) composite[di + c] = Math.round((layer.pixels[si + c] * sa + composite[di + c] * da * (1 - sa)) / oa);
			composite[di + 3] = Math.round(oa * 255);
		}
	}
	const colorMode = baseType === 0 ? 'RGB' : baseType === 1 ? 'Grayscale' : 'Indexed';
	const nodesByParent = new Map<string | undefined, LayerNodeSummary[]>();
	for (const layer of layers) {
		const siblings = nodesByParent.get(layer.parentId) || []; siblings.push(layer.node); nodesByParent.set(layer.parentId, siblings);
	}
	for (const layer of layers) if (layer.node.kind === 'group') { layer.node.children = nodesByParent.get(layer.node.id) || []; }
	const root = nodesByParent.get(undefined) || layers.map(layer => layer.node);
	const layerAssets: LayeredRasterAsset[] = [];
	// XCF layer pointers are top-to-bottom. Build the editable stack directly
	// in bottom-to-top compositor order. Within each drawable, GIMP's effect
	// pointer order matches our base-to-top adjustment order.
	for (let index = layers.length - 1; index >= 0; index--) {
		const layer = layers[index];
		if (layer.node.kind === 'group') {
			layerAssets.push({
				nodeId: layer.node.id, name: layer.node.name, sourcePath: '', kind: 'group', parentId: layer.parentId,
				width, height, x: 0, y: 0, opacity: layer.opacity, visible: layer.node.visible, blendMode: layer.node.blendMode || 'normal',
				groupPath: layer.groupPath, groupIds: layer.groupIds, support: layer.node.support,
			});
		} else if (layer.pixels) {
			layerAssets.push({
				nodeId: layer.node.id, name: layer.node.name, sourcePath: `xcf-layer-${index}`, kind: 'raster', parentId: layer.parentId,
				data: layer.pixels, width: layer.width, height: layer.height, x: layer.x, y: layer.y,
				opacity: layer.opacity, visible: layer.node.visible, blendMode: layer.node.blendMode || 'normal',
				groupPath: layer.groupPath, groupIds: layer.groupIds, support: layer.node.support,
			});
		}
		for (let effectIndex = 0; effectIndex < layer.effects.length; effectIndex++) {
			const effect = layer.effects[effectIndex];
			if (!effect.adjustment) { continue; }
			layerAssets.push({
				nodeId: `${layer.node.id}-effect-${effectIndex}`, name: effect.name, sourcePath: `xcf-effect-${index}-${effectIndex}`,
				kind: 'adjustment', adjustment: effect.adjustment, parentId: layer.parentId,
				width, height, x: 0, y: 0, opacity: effect.opacity, visible: effect.visible, blendMode: 'normal',
				groupPath: layer.groupPath, groupIds: layer.groupIds, support: 'approximate', clipped: true,
			});
		}
	}
	const document: LayeredDocumentSummary = {
		format: 'xcf', width, height, bitDepth: 8, colorMode,
		previewKind: 'reconstructed', previewIsAuthoritative: warnings.length === 0,
		previewWidth: width, previewHeight: height, layerCount: layers.length, root, warnings,
	};
	// XCF has no authoritative flattened preview. Reconstruct its initial view
	// with the same compositor model used after opening Layers View, including
	// imported effects, effect strength, groups, clipping, and blend modes.
	const previewStack: Layer[] = layerAssets.map(asset => ({
		id: asset.nodeId,
		data: asset.data,
		width: asset.width,
		height: asset.height,
		channels: 4,
		isFloat: false,
		typeMax: 255,
		offsetX: asset.x,
		offsetY: asset.y,
		opacity: asset.opacity,
		visible: asset.visible,
		blendMode: asset.blendMode,
		kind: asset.kind,
		adjustment: asset.adjustment,
		parentId: asset.parentId,
		clipped: asset.clipped,
	}));
	const rendered = compositeLayers(previewStack, width, height);
	const reconstructed = new Uint8Array(width * height * 4);
	for (let pixel = 0; pixel < width * height; pixel++) {
		const source = pixel * rendered.channels, destination = pixel * 4;
		const sample = (channel: number): number => {
			const value = Number(rendered.data[source + Math.min(channel, rendered.channels - 1)]);
			return Number.isFinite(value) ? Math.max(0, Math.min(255, Math.round(value))) : 0;
		};
		if (rendered.channels === 1) {
			reconstructed[destination] = reconstructed[destination + 1] = reconstructed[destination + 2] = sample(0);
			reconstructed[destination + 3] = Number.isFinite(rendered.data[source]) ? 255 : 0;
		} else {
			reconstructed[destination] = sample(0);
			reconstructed[destination + 1] = sample(1);
			reconstructed[destination + 2] = sample(2);
			reconstructed[destination + 3] = rendered.channels >= 4 ? sample(3) : 255;
		}
	}
	return {
		width, height, channels: 4, bitDepth: 8, sampleFormat: 1, data: reconstructed,
		formatLabel: 'GIMP XCF reconstructed preview', formatType: 'xcf', document, layerAssets,
		layerOrder: 'bottom-to-top',
		metadata: { xcfVersion: version, colorMode, precision, compression, layerCount: layers.length, previewAuthoritative: document.previewIsAuthoritative },
	};
}

export function decodeLayeredPreview(format: string, buffer: ArrayBuffer): DecodedLayeredPreview {
	const started = performance.now();
	let result: DecodedLayeredPreview;
	switch (format) {
		case 'ora': result = archivePreviewResult('ora', buffer); break;
		case 'kra': result = archivePreviewResult('kra', buffer); break;
		case 'psd': result = decodePsdPreview(buffer, false); break;
		case 'psb': result = decodePsdPreview(buffer, true); break;
		case 'xcf': result = decodeXcfPreview(buffer); break;
		case 'affinity': result = decodeAffinityPreview(buffer); break;
		default: throw new Error(`Unknown layered document format: ${format}`);
	}
	result.decodeTimings = [{ name: `decode-${format}-preview`, durationMs: performance.now() - started }];
	return result;
}
