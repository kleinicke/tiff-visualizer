import { unzipSync } from 'fflate';
import { initializeCanvas, readPsd } from 'ag-psd';
import pako from 'pako';
import UPNG from 'upng-js';
import type { DecodedLayeredPreview, LayeredRasterAsset, LayerNodeKind, LayerNodeSummary, LayeredDocumentSummary, LayeredPixelArray } from './layered-document.js';

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
	return !value || value === 'svg:src-over' ? 'normal' : value;
}

function compositeRgbaOver(destination: Uint8Array, source: Uint8Array, opacity: number): void {
	const pixelCount = Math.min(destination.length, source.length) / 4;
	for (let pixel = 0; pixel < pixelCount; pixel++) {
		const i = pixel * 4;
		const sa = (source[i + 3] / 255) * opacity;
		if (sa <= 0) { continue; }
		const da = destination[i + 3] / 255;
		const oa = sa + da * (1 - sa);
		for (let channel = 0; channel < 3; channel++) {
			destination[i + channel] = oa > 0
				? Math.round((source[i + channel] * sa + destination[i + channel] * da * (1 - sa)) / oa)
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
	const buildNodes = (nodes: OraXmlNode[], groupPath: string[] = [], groupIds: string[] = [], inheritedX = 0, inheritedY = 0, inheritedOpacity = 1, inheritedVisible = true): LayerNodeSummary[] => nodes.map(node => {
		const id = `ora-node-${nodeSequence++}`;
		const name = node.attrs.name || (node.tag === 'stack' ? 'Group' : `Layer ${nodeSequence}`);
		const x = inheritedX + Math.trunc(oraNumber(node.attrs.x, 0));
		const y = inheritedY + Math.trunc(oraNumber(node.attrs.y, 0));
		const opacity = Math.max(0, Math.min(1, oraNumber(node.attrs.opacity, 1)));
		const visible = inheritedVisible && oraVisible(node.attrs.visibility);
		const blendMode = oraBlendMode(node.attrs['composite-op']);
		const support = blendMode === 'normal' ? 'native' : 'approximate';
		if (blendMode !== 'normal') { warnings.push(`“${name}” uses ${blendMode}; reconstruction currently approximates it as normal`); }
		const summary: LayerNodeSummary = { id, name, kind: node.tag === 'stack' ? 'group' : 'raster', support, visible, opacity, blendMode, left: x, top: y };
		if (node.tag === 'stack') {
			if (opacity !== 1) { warnings.push(`Group “${name}” opacity is flattened into its child layers and may differ in overlapping regions`); }
			summary.children = buildNodes(node.children, [...groupPath, name], [...groupIds, id], x, y, inheritedOpacity * opacity, visible);
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
			assets.push({ nodeId: id, name, sourcePath: path, data: png.data, width: png.width, height: png.height, x, y, opacity: inheritedOpacity * opacity, visible, blendMode, groupPath, groupIds, support });
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
			compositeRgbaOver(output, source, node.opacity);
		}
		return output;
	};
	const reconstructed = renderNodes(root);
	const comparable = decoded.width === declaredWidth && decoded.height === declaredHeight;
	const reconstruction: NonNullable<LayeredDocumentSummary['reconstruction']> = assets.length === 0
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
		const children = summarizePsdLayers(layer.children, `${path}-${index}`);
		const node: LayerNodeSummary = {
			id: `${path}-${index}`,
			name: String(layer.name || `Layer ${index + 1}`),
			kind,
			support: kind === 'group' ? 'inspect-only' : kind === 'raster' ? 'inspect-only' : 'cached-raster',
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

function flattenNodeCount(nodes: LayerNodeSummary[]): number {
	let count = 0;
	for (const node of nodes) { count += 1 + flattenNodeCount(node.children || []); }
	return count;
}

function decodePsdPreview(buffer: ArrayBuffer, psb: boolean): DecodedLayeredPreview {
	ensurePsdImageDataFactory();
	const psd = readPsd(buffer, {
		useImageData: true,
		skipLayerImageData: true,
		skipThumbnail: true,
		skipLinkedFilesData: true,
		logMissingFeatures: false,
		totalMemoryLimit: MAX_PSD_MEMORY_BYTES,
	});
	if (!psd.imageData?.data) { throw new Error('PSD contains no decodable composite image'); }
	const bitDepth = Number(psd.bitsPerChannel || 8);
	assertDimensions(psd.width, psd.height, bitDepth === 32 ? 16 : bitDepth === 16 ? 8 : 4);
	const data = psd.imageData.data as LayeredPixelArray;
	const root = summarizePsdLayers(psd.children);
	const layerCount = flattenNodeCount(root);
	const colorModes: Record<number, string> = { 0: 'Bitmap', 1: 'Grayscale', 2: 'Indexed', 3: 'RGB', 4: 'CMYK', 7: 'Multichannel', 8: 'Duotone', 9: 'Lab' };
	const colorMode = colorModes[Number(psd.colorMode)] || `Mode ${psd.colorMode}`;
	const warnings: string[] = [];
	if (![0, 1, 2, 3].includes(Number(psd.colorMode))) { warnings.push(`${colorMode} is converted by the PSD decoder`); }
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
		formatLabel: `${psb ? 'Photoshop PSB' : 'Photoshop PSD'} composite`,
		formatType: psb ? 'psb' : 'psd',
		document,
		metadata: {
			colorMode, bitDepth, layerCount,
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
	colormap?: Uint8Array;
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
		else if (type === 1 && length >= 4) {
			const countColors = Math.min(256, reader.u32(offset));
			reader.check(offset + 4, countColors * 3);
			out.colormap = reader.bytes.slice(offset + 4, offset + 4 + countColors * 3);
		}
		offset += length;
	}
	throw new Error('XCF property list exceeds the safety limit');
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
	const layers: { node: LayerNodeSummary; pixels?: Uint8Array; type: number; opacity: number; x: number; y: number; width: number; height: number; mode: number }[] = [];
	const warnings: string[] = [];
	for (let index = 0; index < layerPointers.length; index++) {
		let cursor = layerPointers[index];
		const layerWidth = reader.u32(cursor), layerHeight = reader.u32(cursor + 4), type = reader.u32(cursor + 8); cursor += 12;
		assertDimensions(layerWidth, layerHeight, 4);
		const name = reader.string(cursor); cursor = name.next;
		const props = readXcfProperties(reader, cursor); cursor = props.next;
		const hierarchyPointer = reader.pointer(cursor); cursor += reader.pointerBytes;
		const mode = props.mode ?? 0;
		const node: LayerNodeSummary = {
			id: `xcf-layer-${index}`, name: name.value || `Layer ${index + 1}`,
			kind: props.group ? 'group' : 'raster', support: props.group ? 'inspect-only' : mode === 0 ? 'native' : 'approximate',
			visible: props.visible !== false, opacity: props.opacity ?? 1, blendMode: `gimp-${mode}`,
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
		if (mode !== 0 && !props.group) { warnings.push(`Layer “${node.name}” blend mode ${mode} is approximated as normal`); }
		layers.push({ node, pixels, type, opacity: props.opacity ?? 1, x: props.offsetX || 0, y: props.offsetY || 0, width: layerWidth, height: layerHeight, mode });
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
	const root = layers.map(layer => layer.node);
	const document: LayeredDocumentSummary = {
		format: 'xcf', width, height, bitDepth: 8, colorMode,
		previewKind: 'reconstructed', previewIsAuthoritative: warnings.length === 0,
		previewWidth: width, previewHeight: height, layerCount: root.length, root, warnings,
	};
	return {
		width, height, channels: 4, bitDepth: 8, sampleFormat: 1, data: composite,
		formatLabel: 'GIMP XCF reconstructed preview', formatType: 'xcf', document,
		metadata: { xcfVersion: version, colorMode, precision, compression, layerCount: root.length, previewAuthoritative: document.previewIsAuthoritative },
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
