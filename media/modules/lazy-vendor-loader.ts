"use strict";

type VendorName = 'geotiff' | 'pako' | 'upng' | 'parseExr';
type VendorAssets = Partial<Record<VendorName, string>> & { nonce?: string };

const loads = new Map<VendorName, Promise<void>>();

function assets(): VendorAssets {
	return ((window as any).__tiffVisualizerVendorAssets || {}) as VendorAssets;
}

function loadScript(name: VendorName): Promise<void> {
	const existing = loads.get(name);
	if (existing) { return existing; }
	const configured = assets();
	const url = configured[name];
	if (!url) { return Promise.reject(new Error(`No ${name} fallback asset was configured`)); }
	const promise = new Promise<void>((resolve, reject) => {
		const script = document.createElement('script');
		script.src = url;
		script.async = true;
		if (configured.nonce) { script.nonce = configured.nonce; }
		script.addEventListener('load', () => resolve(), { once: true });
		script.addEventListener('error', () => reject(new Error(`Failed to load ${name} fallback`)), { once: true });
		document.head.append(script);
	}).catch(error => {
		loads.delete(name);
		throw error;
	});
	loads.set(name, promise);
	return promise;
}

export async function loadGeoTiff(): Promise<any> {
	if (!(window as any).GeoTIFF) {
		// geotiff.js delegates Deflate-compressed strips to the global inflater.
		// Both assets therefore remain behind the Rust TIFF failure boundary.
		await loadPako();
		await loadScript('geotiff');
	}
	return (window as any).GeoTIFF;
}

export async function loadPako(): Promise<any> {
	if (!(window as any).pako) { await loadScript('pako'); }
	return (window as any).pako;
}

export async function loadUpng(): Promise<any> {
	if (!(window as any).UPNG) {
		// The vendored UPNG build obtains its inflater from window.pako.
		await loadPako();
		await loadScript('upng');
	}
	return (window as any).UPNG;
}

export async function loadParseExr(): Promise<(buffer: ArrayBuffer, type: number) => any> {
	if (!(window as any).parseExr) { await loadScript('parseExr'); }
	return (window as any).parseExr;
}
