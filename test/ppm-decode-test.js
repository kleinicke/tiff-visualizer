/**
 * Regression tests for the NetPBM parser (media/modules/ppm-processor.js).
 *
 * Covers ASCII and binary variants of PBM/PGM/PPM. The binary PBM case is a
 * regression guard: the header reader used to greedily swallow raster bytes
 * into the numeric height field when the single whitespace before the data was
 * absent, throwing "Insufficient data for binary PBM".
 *
 * Run with: node test/ppm-decode-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const samplesDir = path.join(__dirname, '..', 'test-samples');

function bufferToArrayBuffer(buf) {
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function main() {
	const { PpmProcessor } = await import(
		path.join('..', 'out', 'media', 'modules', 'ppm-processor.js').replace(/\\/g, '/')
	);
	const parser = new PpmProcessor(/** @type {any} */ (null), null);

	const decode = (file) => {
		const buf = fs.readFileSync(path.join(samplesDir, file));
		return parser._parsePpm(bufferToArrayBuffer(buf));
	};

	console.log('🧪 Running NetPBM (PPM/PGM/PBM) parser tests...\n');

	// 1. Binary PBM — the previously-failing case. 8x2 checkerboard packed as
	//    0xAA / 0x55, with no whitespace between the header and the raster.
	{
		const r = decode('binary-test.pbm');
		assert.strictEqual(r.format, 'PBM (Binary)');
		assert.strictEqual(r.width, 8);
		assert.strictEqual(r.height, 2);
		assert.strictEqual(r.channels, 1);
		assert.strictEqual(r.data.length, 16);
		// 0xAA -> 1,0,1,0,... ; display maps 1(black)->0, 0(white)->255.
		assert.deepStrictEqual(Array.from(r.data.slice(0, 8)), [0, 255, 0, 255, 0, 255, 0, 255]);
		assert.deepStrictEqual(Array.from(r.data.slice(8, 16)), [255, 0, 255, 0, 255, 0, 255, 0]);
		console.log('✅ Binary PBM (P4) decodes the packed checkerboard correctly');
	}

	// 2. The remaining sample files parse without error and report sane shapes.
	const expected = [
		['test.pbm', 'PBM (ASCII)', 6, 4, 1],
		['binary-test.pgm', 'PGM (Binary)', 3, 3, 1],
		['test.pgm', 'PGM (ASCII)', 4, 4, 1],
		['test.ppm', 'PPM (ASCII)', 2, 2, 3],
		['wide-range.pgm', 'PGM (ASCII)', 4, 3, 1],
	];
	for (const [file, format, width, height, channels] of expected) {
		const r = decode(file);
		assert.strictEqual(r.format, format, `${file} format`);
		assert.strictEqual(r.width, width, `${file} width`);
		assert.strictEqual(r.height, height, `${file} height`);
		assert.strictEqual(r.channels, channels, `${file} channels`);
		assert.strictEqual(r.data.length, width * height * channels, `${file} data length`);
		console.log(`✅ ${format} ${file} -> ${width}x${height} ch=${channels}`);
	}

	console.log('\n🎉 All NetPBM parser tests passed.\n');
}

main().catch(err => {
	console.error('❌ NetPBM parser test failed:');
	console.error(err);
	process.exit(1);
});
