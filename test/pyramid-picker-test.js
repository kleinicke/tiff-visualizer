/** The large-scene picker is immediate and cursor motion never initiates IO. */
const assert = require('assert');
const path = require('path');

async function main() {
	global.window = { addEventListener() {} };
	global.document = {
		body: { classList: { add() {}, remove() {} } },
	};
	const { MouseHandler } = await import(
		path.join('..', 'out', 'media', 'modules', 'mouse-handler.js').replace(/\\/g, '/')
	);
	const messages = [];
	const settings = {
		isMac: false,
		settings: { normalization: { gammaMode: false }, gamma: { in: 1, out: 1 }, brightness: { offset: 0 } },
	};
	const handler = new MouseHandler(settings, { postMessage: message => messages.push(message) }, null);
	const residentValues = new Map();
	let exactReads = 0;
	let left = 0;
	const element = {
		dataset: { sceneWidth: '40000', sceneHeight: '40000' },
		getBoundingClientRect: () => ({ left, top: 0, right: left + 100, bottom: 100, width: 100, height: 100 }),
	};
	handler.setImageElement(element);
	handler.setStoredValueResolver(async () => { exactReads++; return '244'; }, {
		exactOnly: true,
		upgradeApproximate: false,
		immediateResolver: (x, y) => residentValues.get(`${x},${y}`) ?? null,
	});

	handler._handleMouseMove({ clientX: 50, clientY: 50 });
	assert.deepStrictEqual(messages, [{ type: 'pixelBlur' }],
		'an unpainted streamed tile clears the previous readout without starting hidden IO');
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.strictEqual(exactReads, 0, 'hover does not fetch a full-resolution tile');

	messages.length = 0;
	left = -10;
	handler.refreshAtPointer();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepStrictEqual(messages, [{ type: 'pixelBlur' }],
		'a stationary pointer follows the image without starting hidden IO after a pan');
	console.log('✅ Stationary picker refreshes after trackpad and keyboard scrolling');

	messages.length = 0;
	left = 0;
	residentValues.set('20400,20000', { value: '245', exact: true });
	handler._handleMouseMove({ clientX: 51, clientY: 50 });
	assert.strictEqual(messages.length, 1, 'a value retained with its rendered tile is synchronous');
	assert.strictEqual(messages[0].value, '20400x20000 245');

	messages.length = 0;
	residentValues.set('20800,20000', { value: '240', exact: false, note: '1/32 overview' });
	handler._handleMouseMove({ clientX: 52, clientY: 50 });
	assert.strictEqual(messages[0].value, '20800x20000 240',
		'a resident overview value should be visible without waiting for IO');
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.strictEqual(messages.length, 1, 'the resident overview value remains stable');
	assert.strictEqual(exactReads, 0,
		'an overview hover must not decode a different full-resolution block for every cursor move');

	messages.length = 0;
	left = 0;
	handler._handleMouseMove({ clientX: 50.005, clientY: 50 });
	assert.deepStrictEqual(messages, [{ type: 'pixelBlur' }], 'an unpainted neighbouring pixel has no stale value');
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.strictEqual(exactReads, 0);

	handler._handleMouseLeave({});
	messages.length = 0;
	left = -20;
	handler.refreshAtPointer();
	assert.strictEqual(messages.length, 0, 'scroll does not resurrect a picker after the pointer left the image');
	// A generated preview has no stored overview to inspect: upgrade on demand
	// and retain original full-resolution scene coordinates throughout.
	left = 0;
	handler.setStoredValueResolver(async (x, y) => {
		assert.strictEqual(x, 20000);
		assert.strictEqual(y, 20000);
		return '123.5';
	}, {
		exactOnly: true,
		upgradeApproximate: true,
		immediateResolver: () => ({ value: '120', exact: false, note: '1/8 overview' }),
	});
	messages.length = 0;
	handler._handleMouseMove({ clientX: 50, clientY: 50 });
	assert.strictEqual(messages[0].value, '20000x20000 120');
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.strictEqual(messages[messages.length - 1].value, '20000x20000 123.5');
	console.log('✅ Generated-preview picker upgrades to the exact original pixel');
	console.log('✅ Pyramid picker is immediate from resident tiles and hover performs no IO');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
