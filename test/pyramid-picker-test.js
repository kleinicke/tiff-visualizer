/** The large-scene picker must never flash an overview value before exact data. */
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
	let left = 0;
	const element = {
		dataset: { sceneWidth: '40000', sceneHeight: '40000' },
		getBoundingClientRect: () => ({ left, top: 0, right: left + 100, bottom: 100, width: 100, height: 100 }),
	};
	handler.setImageElement(element);
	handler.setStoredValueResolver(async () => '244', { exactOnly: true });

	handler._handleMouseMove({ clientX: 50, clientY: 50 });
	assert.strictEqual(messages.length, 0, 'no reduced-resolution value is posted while exact data is pending');
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.strictEqual(messages.length, 1);
	assert.strictEqual(messages[0].value, '20000x20000 244');

	messages.length = 0;
	left = -10;
	handler.refreshAtPointer();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.strictEqual(messages.at(-1).value, '24000x20000 244',
		'a stationary pointer follows the image when scroll or keyboard pan moves it');
	console.log('✅ Stationary picker refreshes after trackpad and keyboard scrolling');

	messages.length = 0;
	left = 0;
	handler._handleMouseMove({ clientX: 50.005, clientY: 50 });
	assert.strictEqual(messages.length, 0, 'a neighbouring pixel also waits for its complete exact value');
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.ok(messages.every(message => / 244$/.test(message.value)), 'no partial or approximate number is emitted');

	handler._handleMouseLeave({});
	messages.length = 0;
	left = -20;
	handler.refreshAtPointer();
	assert.strictEqual(messages.length, 0, 'scroll does not resurrect a picker after the pointer left the image');
	console.log('✅ Pyramid picker emits one stable, exact full-resolution value per cursor position');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
