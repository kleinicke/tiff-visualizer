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
		global.ImageData = class ImageData {
			constructor(width, height) {
				this.width = width;
				this.height = height;
				this.data = new Uint8ClampedArray(width * height * 4);
			}
		};
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
		processor._cacheRegionSamples(0, 200, 200, actual);
		const cachedRegion = Array.from(processor._regionSampleCache.values())[0];
		assert.ok(cachedRegion.planes?.length,
			'remote samples should remain in their compact native planar arrays');
		assert.strictEqual(cachedRegion.data, undefined,
			'the picker cache must not retain the expanded Float32 render carrier too');
		assert.strictEqual(
			processor._readCachedPagePixel(0, 200, 200),
			Array.from(expected.slice(0, actual.channels)).join(' '),
			'the resident native tile should provide the pixel value synchronously',
		);
		assert.ok(rangeRequests > 0, 'the source was requested with HTTP Range');
		assert.ok(bytesServed < source.length, `region read transferred ${bytesServed}, full file is ${source.length}`);
		console.log(`✅ Remote region matched local pixels using ${bytesServed} / ${source.length} bytes`);

		processor.settingsManager.settings.remoteTiffUrl = url;
		const progressive = await processor.processTiff('unused', 0, {
			displayWidth: 100,
			maxAxis: 10000,
			maxArea: 100_000_000,
			maxBytes: 400_000_000,
			pixelBudget: 1,
		});
		assert.strictEqual(processor.isProgressiveRemoteBase, true);
		assert.strictEqual(processor.rawTiffData.data.length, 0,
			'progressive bootstrap must not materialize the selected level');
		assert.deepStrictEqual([progressive.imageData.width, progressive.imageData.height], [1, 1],
			'progressive bootstrap must not allocate a full-size empty RGBA placeholder');
		console.log('✅ Oversized remote bootstrap returns metadata without decoding the whole overview');

		// A zoom transition may retain old and new detail concurrently, but the
		// overview remains visible around both. Detail eviction must therefore not
		// leave those lower-resolution areas without an immediate picker value.
		processor._clearRegionSampleCache();
		processor.pageIndex = 5;
		processor._regionSampleCacheMaxBytes = 16;
		const samples = values => ({
			width: 2, height: 1, channels: 1, sampleFormat: 2,
			data: new Float32Array(values),
		});
		processor._cacheRegionSamples(5, 0, 0, samples([31, 32]));
		processor._cacheRegionSamples(0, 0, 0, samples([1, 2]));
		processor._cacheRegionSamples(0, 2, 0, samples([3, 4]));
		assert.strictEqual(processor._readCachedPagePixel(5, 0, 0), '31',
			'the visible overview value must survive detail-cache pressure');
		assert.strictEqual(processor._readCachedPagePixel(0, 0, 0), null,
			'older detail is evicted before the still-visible overview');
		assert.strictEqual(processor._readCachedPagePixel(0, 2, 0), '3',
			'the newest detail tile remains immediately pickable');
		console.log('✅ Picker cache retains the visible overview before stale detail');
	} finally {
		await new Promise(resolve => server.close(resolve));
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
