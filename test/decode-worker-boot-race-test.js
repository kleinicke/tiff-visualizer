/**
 * Pushed sources often arrive before the format's decode worker has finished
 * booting. `DecodeWorkerClient.decodeWithFallback` must then wait for the boot
 * already in flight instead of decoding on the main thread (a layered XCF took
 * seconds there), while a worker that is not booting at all still falls back
 * at once.
 */
const assert = require('node:assert/strict');

async function main() {
	const { DecodeWorkerClient } = await import('../out/media/modules/decode-worker-client.js');

	function fakeClient({ bootMs }) {
		let ready = false;
		const boot = bootMs === null ? null : new Promise(resolve => setTimeout(() => { ready = true; resolve(); }, bootMs));
		return {
			start: () => boot || Promise.resolve(),
			whenBooting: () => (boot && !ready ? boot : null),
			canDecode: () => ready,
			decode(format, buffer) {
				if (!ready) return null;
				return Promise.resolve({ ok: true, result: { decodedBy: 'worker', bytes: buffer.byteLength } });
			},
		};
	}
	const local = buffer => ({ decodedBy: 'main', bytes: buffer.byteLength });

	const booting = await DecodeWorkerClient.decodeWithFallback(fakeClient({ bootMs: 30 }), 'xcf', new ArrayBuffer(8), 'src', undefined, local);
	assert.equal(booting.decodedBy, 'worker', 'a booting worker is awaited');

	const absent = await DecodeWorkerClient.decodeWithFallback(fakeClient({ bootMs: null }), 'xcf', new ArrayBuffer(8), 'src', undefined, local);
	assert.equal(absent.decodedBy, 'main', 'without a boot in flight the main thread decodes');

	const controller = new AbortController();
	const pending = DecodeWorkerClient.decodeWithFallback(fakeClient({ bootMs: 30 }), 'xcf', new ArrayBuffer(8), 'src', controller.signal, local);
	controller.abort();
	await assert.rejects(pending, error => error.name === 'AbortError', 'a load superseded while waiting is dropped');

	// After a cancelled decode terminates the adopted warm worker, a new boot
	// must not adopt that terminated worker again.
	for (const [label, bundleName, Client] of [
		['decode worker', 'decodeWorker.bundle.js', DecodeWorkerClient],
		['fast raw worker', 'fastRawWorker.bundle.js', (await import('../out/media/modules/fast-raw-worker-client.js')).FastRawWorkerClient],
	]) {
		let adoptions = 0;
		const terminated = new Set();
		// A client adopting the worker installs its message handler on it.
		const fakeWorker = {
			postMessage() {}, terminate() { terminated.add(this); }, addEventListener() {}, removeEventListener() {},
			set onmessage(handler) { if (handler) adoptions++; }, get onmessage() { return null; },
		};
		globalThis.__tiffVisualizerDecoderWarmup = {
			bundleName,
			workerPromise: Promise.resolve({ worker: fakeWorker, blobUrl: 'blob:warm', caps: {} }),
		};
		const realFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response('', { status: 404 });
		const client = bundleName === 'decodeWorker.bundle.js' ? new Client(bundleName, false) : new Client();
		await client.start();
		assert.equal(adoptions, 1, `${label}: the warm worker is adopted`);
		// A pending decode, then the navigation cancels it.
		const decoding = client.decode('npy', new ArrayBuffer(8));
		client.cancelActiveDecodes();
		await decoding;
		assert.ok(terminated.has(fakeWorker), `${label}: cancelling terminates the worker`);
		await client.start();
		assert.equal(adoptions, 1, `${label}: the terminated warm worker is not adopted again`);
		globalThis.fetch = realFetch;
		delete globalThis.__tiffVisualizerDecoderWarmup;
	}

	console.log('Decode worker boot race: booting worker awaited, absent worker falls back, superseded load aborts, terminated warm workers are not re-adopted');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
