/**
 * Collection switches read a local file through `media/modules/pushed-source.ts`:
 * the host offers it with `switchToImage`, the viewer requests it when a
 * processor reads the source, and the host posts `sourceChunk` messages. The
 * receiver must assemble the exact bytes, ignore chunks of a replaced push,
 * fail on an error chunk, give way to a newer switch or an aborted load, and
 * ask again from the first missing byte when the chunks stop.
 */
const assert = require('node:assert/strict');

async function main() {
	global.window = new EventTarget();
	const { setPushedSourceChannel, offerPushedSource, takePushedSource } = await import('../out/media/modules/pushed-source.js');
	const requests = [];
	setPushedSourceChannel({ postMessage: message => requests.push(message) });
	const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
	const file = Uint8Array.from({ length: 100 }, (_, i) => (i * 37) & 0xff);
	const chunk = (token, offset, end) => ({ type: 'sourceChunk', token, offset, bytes: file.slice(offset, end) });

	assert.equal(takePushedSource('a'), null, 'nothing offered');
	offerPushedSource('a', 't1', 100);
	assert.equal(takePushedSource('b'), null, 'offered for another image');

	// Assembles in order; a stale chunk is ignored.
	const first = takePushedSource('a');
	assert.deepEqual(requests.pop(), { type: 'sourceRequest', token: 't1', offset: 0 });
	assert.equal(takePushedSource('a'), null, 'an offer is taken once');
	post(chunk('t1', 0, 40));
	post(chunk('t1', 0, 40));
	post(chunk('other', 40, 100));
	post(chunk('t1', 40, 100));
	assert.ok(Buffer.from(await first).equals(Buffer.from(file)), 'assembled bytes');

	// An error chunk rejects.
	offerPushedSource('a', 't2', 100);
	const failing = takePushedSource('a');
	post({ type: 'sourceChunk', token: 't2', offset: 0, error: 'the file shrank' });
	await assert.rejects(failing, /shrank/);

	// A newer switch cancels the request in flight, and so does an aborted load.
	offerPushedSource('a', 't3', 100);
	const replaced = takePushedSource('a');
	offerPushedSource('b', 't4', 100);
	await assert.rejects(replaced, error => error.name === 'AbortError');
	const controller = new AbortController();
	const aborted = takePushedSource('b', controller.signal);
	controller.abort();
	await assert.rejects(aborted, error => error.name === 'AbortError');

	// Stalled chunks are requested again from the first missing byte.
	offerPushedSource('c', 't5', 100);
	requests.length = 0;
	const resumed = takePushedSource('c');
	post(chunk('t5', 0, 30));
	await new Promise(resolve => setTimeout(resolve, 5200));
	assert.deepEqual(requests.at(-1), { type: 'sourceRequest', token: 't5', offset: 30 }, 'resumes at the first missing byte');
	post(chunk('t5', 30, 100));
	assert.ok(Buffer.from(await resumed).equals(Buffer.from(file)), 'resumed bytes');

	// Prefetch: requested only when started, kept for the switch to that file
	// even when the next prefetch offer arrives before the switch reads it.
	const { offerPrefetch, startPrefetch } = await import('../out/media/modules/pushed-source.js');
	requests.length = 0;
	offerPrefetch('next', 'p1', 100, 7);
	assert.equal(requests.length, 0, 'a prefetch waits for startPrefetch');
	startPrefetch();
	assert.deepEqual(requests.pop(), { type: 'sourceRequest', token: 'p1', offset: 0 });
	post(chunk('p1', 0, 100));
	offerPushedSource('next', 'switch-token', 100, 7);
	offerPrefetch('after', 'p2', 100, 7);
	const prefetched = takePushedSource('next');
	assert.ok(prefetched, 'the switch reads the prefetch');
	assert.ok(Buffer.from(await prefetched).equals(Buffer.from(file)), 'prefetched bytes');
	assert.equal(requests.length, 0, 'the switch requested nothing');
	// A changed file (other mtime) is requested afresh.
	startPrefetch();
	assert.equal(requests.pop()?.token, 'p2');
	post(chunk('p2', 0, 100));
	offerPushedSource('after', 'fresh', 100, 8);
	const fresh = takePushedSource('after');
	assert.deepEqual(requests.pop(), { type: 'sourceRequest', token: 'fresh', offset: 0 });
	post(chunk('fresh', 0, 100));
	assert.ok(Buffer.from(await fresh).equals(Buffer.from(file)));

	console.log('Pushed source: assembles, ignores stale chunks, fails on errors, yields to newer switches and aborts, resumes after a stall; prefetches serve their switch');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
