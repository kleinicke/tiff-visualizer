/** Remote TIFF regions must use byte ranges and preserve decoded samples. */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

async function main() {
	const source = fs.readFileSync(path.join(__dirname, '..', 'test-samples', 'house.tif'));
	let bytesServed = 0;
	let rangeRequests = 0;
	const server = http.createServer((request, response) => {
		const match = /^bytes=(\d+)-(\d+)$/.exec(String(request.headers.range || ''));
		if (!match) {
			response.writeHead(200, { 'Content-Length': source.length, 'Accept-Ranges': 'bytes' });
			response.end(source);
			bytesServed += source.length;
			return;
		}
		const start = Number(match[1]);
		const end = Math.min(source.length - 1, Number(match[2]));
		const part = source.subarray(start, end + 1);
		rangeRequests++;
		bytesServed += part.length;
		response.writeHead(206, {
			'Content-Length': part.length,
			'Content-Range': `bytes ${start}-${end}/${source.length}`,
			'Accept-Ranges': 'bytes',
		});
		response.end(part);
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		const url = `http://127.0.0.1:${address.port}/house.tif`;
		const GeoTIFF = await import('geotiff');
		global.window = { GeoTIFF };
		global.navigator = { platform: 'Linux' };
		global.document = { body: {}, createElement: () => ({}) };
		const { TiffProcessor } = await import(
			path.join('..', 'out', 'media', 'modules', 'tiff-processor.js').replace(/\\/g, '/')
		);
		const processor = new TiffProcessor({ settings: {} }, null);
		processor._remoteTiff = await GeoTIFF.fromUrl(url, {
			blockSize: 64 * 1024,
			cacheSize: 16,
			allowFullFile: false,
		});
		processor._remoteTiffUrl = url;
		const actual = await processor._decodeRemoteRegionRaw(0, { x: 200, y: 200, width: 8, height: 8 });

		const wasm = await import(path.join('..', 'media', 'wasm', 'tiff-wasm.js').replace(/\\/g, '/'));
		await wasm.default({ module_or_path: fs.readFileSync(path.join(__dirname, '..', 'media', 'wasm', 'tiff-wasm.wasm')) });
		const expectedRegion = wasm.decode_tiff_region(source, 0, 200, 200, 8, 8);
		const expected = expectedRegion.take_data_as_f32();
		assert.deepStrictEqual(Array.from(actual.data), Array.from(expected), 'range and local decoders must return identical samples');
		assert.ok(rangeRequests > 0, 'the source was requested with HTTP Range');
		assert.ok(bytesServed < source.length, `region read transferred ${bytesServed}, full file is ${source.length}`);
		console.log(`✅ Remote region matched local pixels using ${bytesServed} / ${source.length} bytes`);
	} finally {
		await new Promise(resolve => server.close(resolve));
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
