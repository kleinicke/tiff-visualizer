const assert = require('assert');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const esbuild = require('esbuild');

async function load(relative) {
	const outfile = path.join(os.tmpdir(), `${relative.replace(/[\\/]/g, '-')}-${process.pid}.mjs`);
	await esbuild.build({ entryPoints: [path.join(__dirname, '..', 'media', 'modules', `${relative}.ts`)], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
	return import(pathToFileURL(outfile).href);
}

(async () => {
	const { micronsPerPixel, parseCellsAutoOpen, shouldAutoOpenCells } = await load('cells/cells-relevance');
	const calibration = (unit, pixelWidth = 0.5) => ({ unit, pixelWidth, pixelHeight: pixelWidth, origin: 'ome' });

	assert.strictEqual(micronsPerPixel(calibration('µm')), 0.5);
	assert.strictEqual(micronsPerPixel(calibration('μm')), 0.5);
	assert.strictEqual(micronsPerPixel(calibration('um')), 0.5);
	assert.strictEqual(micronsPerPixel(calibration('nm', 500)), 0.5);
	assert.strictEqual(micronsPerPixel(calibration('mm', 0.001)), 1);
	assert.strictEqual(micronsPerPixel(calibration('px', 1)), null, 'uncalibrated images have no micron scale');
	assert.strictEqual(micronsPerPixel(calibration('µm', 0)), null);

	assert.strictEqual(parseCellsAutoOpen(undefined), 'auto');
	assert.strictEqual(parseCellsAutoOpen('bogus'), 'auto');
	assert.strictEqual(parseCellsAutoOpen('always'), 'always');
	assert.strictEqual(parseCellsAutoOpen('never'), 'never');

	const microscopy = { channels: 4, omeMetadata: true, micronsPerPixel: 0.2125 };
	assert.ok(shouldAutoOpenCells('auto', microscopy), 'a calibrated multichannel OME image opens it');
	assert.ok(!shouldAutoOpenCells('auto', { ...microscopy, channels: 1 }), 'one channel does not');
	assert.ok(!shouldAutoOpenCells('auto', { ...microscopy, omeMetadata: false }), 'no OME metadata does not');
	assert.ok(!shouldAutoOpenCells('auto', { ...microscopy, micronsPerPixel: null }), 'no micron scale does not');
	assert.ok(!shouldAutoOpenCells('auto', { channels: 3, omeMetadata: false, micronsPerPixel: null }), 'a photo never does');
	assert.ok(shouldAutoOpenCells('always', { channels: 1, omeMetadata: false, micronsPerPixel: null }));
	assert.ok(!shouldAutoOpenCells('never', microscopy));
	console.log('cells relevance: ok');
})().catch(error => { console.error(error); process.exit(1); });
