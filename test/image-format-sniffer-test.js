const assert = require('assert');
const { buildSync } = require('esbuild');

const bundle = buildSync({
	entryPoints: ['src/util/imageFormatSniffer.ts'],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	write: false,
});
const loaded = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(loaded, loaded.exports, require);
const { sniffImageFormat, filenameForDetectedFormat, readResponsePrefix } = loaded.exports;

const bytes = (...values) => new Uint8Array(values);
const text = value => new TextEncoder().encode(value);

async function main() {
	assert.equal(sniffImageFormat(bytes(0x49, 0x49, 0x2a, 0x00)).hint, 'tiff');
	assert.equal(sniffImageFormat(bytes(0x4d, 0x4d, 0x00, 0x2b)).hint, 'tiff', 'BigTIFF is detected');
	assert.equal(sniffImageFormat(bytes(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10)).hint, 'png');
	assert.equal(sniffImageFormat(bytes(0xff, 0xd8, 0xff)).hint, 'jpg');
	assert.equal(sniffImageFormat(bytes(0x76, 0x2f, 0x31, 0x01)).hint, 'exr');
	assert.equal(sniffImageFormat(bytes(0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59)).hint, 'npy');
	assert.equal(sniffImageFormat(text('PF\n4 3\n-1.0\n')).hint, 'pfm');
	assert.equal(sniffImageFormat(text('P6\n4 3\n255\n')).hint, 'ppm');
	assert.equal(sniffImageFormat(text('RIFF1234WEBP')).hint, 'webp');
	assert.equal(sniffImageFormat(bytes(0xff, 0x4f, 0xff, 0x51)).hint, 'jp2');
	assert.equal(sniffImageFormat(text('SIMPLE  =                    T')).hint, 'fits');
	const dicom = new Uint8Array(132); dicom.set(text('DICM'), 128);
	assert.equal(sniffImageFormat(dicom).hint, 'dicom');
	assert.equal(sniffImageFormat(text('CDF\x01')).hint, 'netcdf');
	assert.equal(sniffImageFormat(text('ZISRAWFILE')).hint, 'czi');
	assert.equal(sniffImageFormat(text('not an image')), null, 'unknown content is never guessed');
	assert.equal(sniffImageFormat(bytes(0x49, 0x49)), null, 'truncated signatures are harmless');

	const tiff = sniffImageFormat(bytes(0x49, 0x49, 0x2a, 0x00));
	assert.equal(filenameForDetectedFormat('download', tiff), 'download.tif');
	assert.equal(filenameForDetectedFormat('scene.TIFF', tiff), 'scene.TIFF');
	assert.equal(filenameForDetectedFormat('misleading.jpg', tiff), 'misleading.jpg.tif');

	const response = new Response(new Uint8Array(20_000).fill(7));
	assert.equal((await readResponsePrefix(response, 4096)).length, 4096,
		'a server ignoring Range must not make the probe buffer its whole response');
	console.log('Image header sniffing tests passed');
}

main().catch(error => { console.error(error); process.exit(1); });
