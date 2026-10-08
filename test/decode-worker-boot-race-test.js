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

	console.log('Decode worker boot race: booting worker awaited, absent worker falls back, superseded load aborts');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
