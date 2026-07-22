'use strict';

const assert = require('assert');
const path = require('path');

async function main() {
	const managerPath = path.join(__dirname, '..', 'out', 'media', 'modules', 'layer-manager.js');
	const controlsPath = path.join(__dirname, '..', 'out', 'media', 'modules', 'range-controls.js');
	const { LayerManager } = await import(managerPath);
	const { resetRangeToDefault } = await import(controlsPath);

	const manager = new LayerManager();
	manager.layers = [
		{ id: 'a', visible: true },
		{ id: 'b', visible: true },
		{ id: 'c', visible: false },
	];
	manager.showOnlyLayer('b');
	assert.deepStrictEqual(manager.layers.map(layer => layer.visible), [false, true, false]);
	manager.showOnlyLayer('b');
	assert.deepStrictEqual(manager.layers.map(layer => layer.visible), [true, true, true]);

	manager.toggleSoloLayers(new Set(['a', 'c']));
	assert.deepStrictEqual(manager.layers.map(layer => layer.visible), [true, false, true]);
	manager.toggleSoloLayers(new Set(['a', 'c']));
	assert.deepStrictEqual(manager.layers.map(layer => layer.visible), [true, true, true]);

	const events = [];
	const range = {
		dataset: { defaultValue: '50' },
		getAttribute: () => null,
		min: '0',
		max: '100',
		value: '73',
		dispatchEvent: event => { events.push(event.type); return true; },
	};
	assert.strictEqual(resetRangeToDefault(range), true);
	assert.strictEqual(range.value, '50');
	assert.deepStrictEqual(events, ['input', 'change']);
	assert.strictEqual(resetRangeToDefault(range), false, 'a slider already at its default does not emit duplicate changes');

	const minFallback = {
		dataset: {}, getAttribute: () => null, min: '-5', max: '5', value: '2',
		dispatchEvent: () => true,
	};
	resetRangeToDefault(minFallback);
	assert.strictEqual(minFallback.value, '-5');

	console.log('Control behavior passed: toggle-solo layers/groups and double-click range defaults.');
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
