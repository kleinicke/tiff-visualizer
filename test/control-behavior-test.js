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

	const filterManager = new LayerManager();
	filterManager.setBaseLayer({ data: new Uint8Array([64, 64, 64, 255]), width: 1, height: 1, channels: 4, isFloat: false, typeMax: 255, name: 'Image' });
	const baseId = filterManager.layers[0].id;
	const levelsId = filterManager.addAdjustmentLayer(baseId, 'levels');
	const hueId = filterManager.addAdjustmentLayer(baseId, 'hue/saturation');
	assert.deepStrictEqual(filterManager.layers.map(layer => layer.kind), ['raster', 'adjustment', 'adjustment']);
	assert.deepStrictEqual(filterManager.layers.slice(1).map(layer => layer.clipped), [true, true]);
	assert.strictEqual(filterManager.layers.find(layer => layer.id === levelsId).adjustment.type, 'levels');
	assert.strictEqual(filterManager.layers.find(layer => layer.id === hueId).adjustment.colorizeEnabled, false);
	filterManager.updateLayer(baseId, { visible: false });
	assert.deepStrictEqual(filterManager.layers.slice(1).map(layer => layer.visible), [true, true], 'hiding an image preserves its filter states');
	for (const type of ['brightness/contrast', 'exposure', 'invert', 'channel mixer', 'color balance', 'black & white', 'threshold', 'posterize', 'gradient map']) {
		const id = filterManager.addAdjustmentLayer(baseId, type);
		assert.strictEqual(filterManager.layers.find(layer => layer.id === id).adjustment.type, type);
	}

	const reorderManager = new LayerManager();
	reorderManager.setBaseLayer({ data: new Uint8Array([10, 20, 30, 255]), width: 1, height: 1, channels: 4, isFloat: false, typeMax: 255, name: 'Bottom' });
	const bottomId = reorderManager.layers[0].id;
	const bottomFilterId = reorderManager.addAdjustmentLayer(bottomId, 'levels');
	const topId = reorderManager.addLayer({ data: new Uint8Array([40, 50, 60, 255]), width: 1, height: 1, channels: 4, isFloat: false, typeMax: 255, name: 'Top' });
	const topFilterId = reorderManager.addAdjustmentLayer(topId, 'curves');
	reorderManager.reorderLayer(topId, reorderManager.layers.findIndex(layer => layer.id === topId) - 1);
	assert.deepStrictEqual(reorderManager.layers.map(layer => layer.id), [topId, topFilterId, bottomId, bottomFilterId],
		'moving an image down swaps complete image/filter bundles');
	reorderManager.reorderLayer(topId, reorderManager.layers.findIndex(layer => layer.id === topId) + 1);
	assert.deepStrictEqual(reorderManager.layers.map(layer => layer.id), [bottomId, bottomFilterId, topId, topFilterId],
		'moving an image up keeps both filter stacks attached');
	reorderManager.reorderLayer(topFilterId, reorderManager.layers.findIndex(layer => layer.id === topFilterId) + 1);
	assert.deepStrictEqual(reorderManager.layers.map(layer => layer.id), [bottomId, bottomFilterId, topId, topFilterId],
		'a filter cannot move outside its owning image');

	const duplicateId = reorderManager.duplicateLayerWithAdjustments(bottomId);
	const duplicateIndex = reorderManager.layers.findIndex(layer => layer.id === duplicateId);
	assert.strictEqual(reorderManager.layers[duplicateIndex].name, 'Bottom copy');
	assert.strictEqual(reorderManager.layers[duplicateIndex + 1].adjustment.type, 'levels',
		'duplicating an image also duplicates its attached filters');
	assert.notStrictEqual(reorderManager.layers[duplicateIndex + 1].adjustment, reorderManager.layers.find(layer => layer.id === bottomFilterId).adjustment,
		'duplicated filter parameters are independently editable');
	const copiedFilterId = reorderManager.copyAdjustmentLayer(topFilterId, duplicateId);
	const copiedFilter = reorderManager.layers.find(layer => layer.id === copiedFilterId);
	assert.strictEqual(copiedFilter.adjustment.type, 'curves');
	assert.notStrictEqual(copiedFilter.adjustment, reorderManager.layers.find(layer => layer.id === topFilterId).adjustment,
		'copying a filter to another image creates independent parameters');

	const undoManager = new LayerManager();
	undoManager.setBaseLayer({ data: new Uint8Array([64, 64, 64, 255]), width: 1, height: 1, channels: 4, isFloat: false, typeMax: 255, name: 'Undo base' });
	const undoBaseId = undoManager.layers[0].id;
	const undoFilterId = undoManager.addAdjustmentLayer(undoBaseId, 'brightness/contrast');
	assert.strictEqual(undoManager.canUndo(), true);
	assert.strictEqual(undoManager.undo(), true);
	assert.strictEqual(undoManager.layers.length, 1, 'undo removes a newly added filter');
	const restoredFilterId = undoManager.addAdjustmentLayer(undoBaseId, 'brightness/contrast');
	undoManager.beginHistoryGroup();
	undoManager.updateLayer(restoredFilterId, { adjustment: { type: 'brightness/contrast', brightness: 10, contrast: 0 } });
	undoManager.updateLayer(restoredFilterId, { adjustment: { type: 'brightness/contrast', brightness: 35, contrast: 20 } });
	undoManager.endHistoryGroup();
	assert.strictEqual(undoManager.undo(), true);
	assert.deepStrictEqual(undoManager.layers.find(layer => layer.id === restoredFilterId).adjustment, { type: 'brightness/contrast', brightness: 0, contrast: 0 }, 'continuous filter edits undo as one gesture');
	assert.strictEqual(undoManager.canRedo(), true);
	assert.strictEqual(undoManager.redo(), true);
	assert.deepStrictEqual(undoManager.layers.find(layer => layer.id === restoredFilterId).adjustment, { type: 'brightness/contrast', brightness: 35, contrast: 20 }, 'redo restores a coalesced filter edit');
	assert.strictEqual(undoManager.undo(), true);
	undoManager.removeLayer(restoredFilterId);
	assert.strictEqual(undoManager.layers.some(layer => layer.id === restoredFilterId), false);
	undoManager.undo();
	assert.strictEqual(undoManager.layers.some(layer => layer.id === restoredFilterId), true, 'removed filters can be restored');
	undoManager.addLayer({ data: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1, channels: 4, isFloat: false, typeMax: 255, name: 'Added' });
	undoManager.undo();
	assert.strictEqual(undoManager.layers.some(layer => layer.name === 'Added'), false, 'new image layers can be undone');
	assert.strictEqual(undoManager.canRedo(), true);
	undoManager.addLayer({ data: new Uint8Array([0, 255, 0, 255]), width: 1, height: 1, channels: 4, isFloat: false, typeMax: 255, name: 'Replacement' });
	assert.strictEqual(undoManager.canRedo(), false, 'a new edit clears the redo branch');
	assert.ok(undoFilterId);

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

	console.log('Control behavior passed: layer undo/redo, toggle-solo layers/groups, and double-click range defaults.');
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
