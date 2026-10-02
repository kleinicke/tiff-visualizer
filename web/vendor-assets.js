"use strict";

// Dynamic imports resolve relative to the importing bundle, not this page.
// Use document-relative absolute URLs for lazily imported modules.
window.__tiffVisualizerVendorAssets = {
	wasm: './media/wasm/tiff-wasm.wasm',
	workers: {
		'decodeWorker.bundle.js': './media/decodeWorker.bundle.js',
		'pngDecodeWorker.bundle.js': './media/pngDecodeWorker.bundle.js',
		'fastRawWorker.bundle.js': './media/fastRawWorker.bundle.js',
		'layeredDecodeWorker.bundle.js': './media/layeredDecodeWorker.bundle.js',
	},
	jxlWasm: './media/wasm/jxl-wasm.wasm',
	codecWasm: './media/wasm/codec-wasm.wasm',
	geotiff: './media/geotiff.min.js',
	pako: './media/pako.min.js',
	upng: './media/upng.min.js',
	parseExr: './media/parse-exr.js',
	layeredPreviewFallback: new URL('./media/layeredPreviewFallback.bundle.js', document.baseURI).href,
	layerDocumentWriter: new URL('./media/layerDocumentWriter.bundle.js', document.baseURI).href,
	imagejRoi: new URL('./media/imagejRoi.bundle.js', document.baseURI).href,
};
