/** Shared, format-neutral description of a layered creative document. */

import type { LayerAdjustment } from './layer-compositor.js';

export type LayerSupportState = 'native' | 'cached-raster' | 'approximate' | 'inspect-only' | 'unsupported';

export type LayeredDocumentFormat = 'ora' | 'kra' | 'psd' | 'psb' | 'xcf' | 'affinity';

export type LayerNodeKind = 'group' | 'raster' | 'text' | 'vector' | 'smart-object' | 'adjustment' | 'fill' | 'filter' | 'unknown';

export interface LayerNodeSummary {
	id: string;
	name: string;
	kind: LayerNodeKind;
	support: LayerSupportState;
	visible: boolean;
	opacity: number;
	blendMode?: string;
	left?: number;
	top?: number;
	width?: number;
	height?: number;
	children?: LayerNodeSummary[];
	warnings?: string[];
}

export interface LayeredDocumentSummary {
	format: LayeredDocumentFormat;
	width: number;
	height: number;
	bitDepth: number;
	colorMode: string;
	previewKind: 'integrated' | 'merged' | 'embedded' | 'reconstructed';
	previewIsAuthoritative: boolean;
	previewWidth: number;
	previewHeight: number;
	layerCount: number;
	root: LayerNodeSummary[];
	warnings: string[];
	reconstruction?: {
		available: boolean;
		meanAbsoluteError?: number;
		maxAbsoluteError?: number;
		differentPixelRatio?: number;
	};
}

export type LayeredPixelArray = Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array;

export interface LayeredRasterAsset {
	nodeId: string;
	name: string;
	sourcePath: string;
	kind?: 'raster' | 'group' | 'adjustment';
	adjustment?: LayerAdjustment;
	parentId?: string;
	data?: Uint8Array;
	width: number;
	height: number;
	x: number;
	y: number;
	opacity: number;
	visible: boolean;
	blendMode: string;
	groupPath: string[];
	groupIds: string[];
	support: LayerSupportState;
	clipped?: boolean;
	rasterMask?: {
		data: Uint8Array;
		width: number;
		height: number;
		channels: number;
		typeMax: number;
		x: number;
		y: number;
	};
}

export interface DecodedLayeredPreview {
	width: number;
	height: number;
	channels: number;
	bitDepth: number;
	sampleFormat: 1 | 3;
	data: LayeredPixelArray;
	integratedData?: LayeredPixelArray;
	reconstructedData?: LayeredPixelArray;
	layerAssets?: LayeredRasterAsset[];
	/** Order used by layerAssets. The compositor itself always consumes bottom-to-top. */
	layerOrder?: 'top-to-bottom' | 'bottom-to-top';
	formatLabel: string;
	formatType: LayeredDocumentFormat;
	document: LayeredDocumentSummary;
	metadata: Record<string, string | number | boolean>;
	decodeTimings?: { name: string; durationMs: number }[];
}
