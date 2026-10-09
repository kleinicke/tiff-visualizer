/**
 * Take the <img> the VS Code page bootstrap already showed for `src` (native
 * first paint), if any. `img.src` is the browser's normalized URL, while `src`
 * is the host's `Uri.toString()`, which percent-encodes the `+` of
 * `file+.vscode-resource.vscode-cdn.net`; compared verbatim they never
 * matched, so every processor decoded the file a second time beside the
 * painted image. The image belongs to the first load only: once taken, a
 * later load of the same file (a collection cycling back) decodes normally
 * rather than adopting an element the viewer has since restyled or removed.
 */
export function bootstrapImageFor(src: string): HTMLImageElement | null {
	const bootstrap = (globalThis as any).__tiffVisualizerBootstrap;
	const image = bootstrap?.nativeImage;
	if (typeof HTMLImageElement === 'undefined' || !(image instanceof HTMLImageElement)) { return null; }
	let wanted = src;
	try { wanted = new URL(src, document.baseURI).href; } catch { /* compare as given */ }
	if (image.src !== wanted && image.currentSrc !== wanted && image.src !== src) { return null; }
	bootstrap.nativeImage = null;
	return image;
}
