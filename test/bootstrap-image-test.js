/**
 * The VS Code bootstrap paints the first image natively; processors adopt
 * that <img> through `bootstrapImageFor`. The host's URI encodes the `+` of
 * `file+.vscode-resource.vscode-cdn.net` while `img.src` is normalized, so
 * the two must be compared as URLs. Adoption is one-shot.
 */
const assert = require('node:assert/strict');

async function main() {
	globalThis.HTMLImageElement = class { constructor(src) { this.src = new URL(src).href; this.currentSrc = this.src; } };
	globalThis.document = { baseURI: 'https://webview.invalid/index.html' };
	const { bootstrapImageFor } = await import('../out/media/modules/bootstrap-image.js');

	const hostUri = 'https://file%2B.vscode-resource.vscode-cdn.net/Users/me/images/a%20b.png';
	const image = new HTMLImageElement(hostUri);
	assert.notEqual(image.src, hostUri, 'the DOM normalizes the host URI');
	globalThis.__tiffVisualizerBootstrap = { nativeImage: image };

	assert.equal(bootstrapImageFor('https://file%2B.vscode-resource.vscode-cdn.net/Users/me/images/other.png'), null, 'another file');
	assert.equal(globalThis.__tiffVisualizerBootstrap.nativeImage, image, 'a miss keeps the image');
	assert.equal(bootstrapImageFor(hostUri), image, 'the encoded host URI matches');
	assert.equal(globalThis.__tiffVisualizerBootstrap.nativeImage, null, 'taken once');
	assert.equal(bootstrapImageFor(hostUri), null, 'a later load of the same file decodes normally');

	delete globalThis.__tiffVisualizerBootstrap;
	assert.equal(bootstrapImageFor(hostUri), null, 'no bootstrap');
	console.log('Bootstrap image: encoded host URIs match the normalized <img>, adopted once');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
