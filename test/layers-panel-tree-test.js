'use strict';

const assert = require('assert');
const path = require('path');

function layer(id, name, groupPath = [], groupIds = []) {
	return {
		id,
		name,
		width: 1,
		height: 1,
		data: new Float32Array([0]),
		groupPath,
		groupIds,
	};
}

async function main() {
	const panelPath = path.join(__dirname, '..', 'out', 'media', 'modules', 'layers-panel.js');
	const { adjustmentLabel, adjustmentSummary, buildLayerDisplayTree, clippingTarget } = await import(panelPath);
	const layers = [
		layer('background', 'Background'),
		layer('nested-low', 'Nested low', ['Art', 'Details'], ['art-a', 'details-a']),
		layer('nested-high', 'Nested high', ['Art', 'Details'], ['art-a', 'details-a']),
		layer('art-top', 'Art top', ['Art'], ['art-a']),
		layer('other-art', 'Other art', ['Art'], ['art-b']),
		layer('foreground', 'Foreground'),
	];

	const tree = buildLayerDisplayTree(layers);
	assert.deepStrictEqual(tree.map(item => item.kind === 'layer' ? item.layer.id : item.key), [
		'foreground', 'art-b', 'art-a', 'background',
	]);

	const otherArt = tree[1];
	assert.strictEqual(otherArt.kind, 'group');
	assert.strictEqual(otherArt.name, 'Art');
	assert.deepStrictEqual(otherArt.layers.map(item => item.id), ['other-art']);

	const art = tree[2];
	assert.strictEqual(art.kind, 'group');
	assert.deepStrictEqual(art.layers.map(item => item.id), ['art-top', 'nested-high', 'nested-low']);
	assert.strictEqual(art.items[0].kind, 'layer');
	assert.strictEqual(art.items[0].layer.id, 'art-top');
	assert.strictEqual(art.items[1].kind, 'group');
	assert.strictEqual(art.items[1].key, 'details-a');
	assert.deepStrictEqual(art.items[1].items.map(item => item.layer.id), ['nested-high', 'nested-low']);

	assert.notStrictEqual(otherArt.key, art.key, 'same-named groups with distinct source ids remain separate');

	const firstClass = buildLayerDisplayTree([
		layer('background', 'Background'),
		{ ...layer('group', 'Editable group'), kind: 'group', data: undefined, opacity: 0.5 },
		{ ...layer('child-low', 'Child low'), parentId: 'group' },
		{ ...layer('child-high', 'Child high'), parentId: 'group' },
	]);
	assert.deepStrictEqual(firstClass.map(item => item.kind === 'group' ? item.key : item.layer.id), ['group', 'background']);
	assert.strictEqual(firstClass[0].group.opacity, 0.5);
	assert.deepStrictEqual(firstClass[0].items.map(item => item.layer.id), ['child-high', 'child-low']);

	const adjustmentStack = [
		{ ...layer('base', 'Grayscale channel'), channels: 4 },
		{ ...layer('levels', 'Levels 1'), kind: 'adjustment', data: undefined, clipped: true,
			adjustment: { type: 'levels', rgb: { shadowInput: 3, highlightInput: 200, midtoneInput: 1.2 } } },
		{ ...layer('hue', 'Hue 1'), kind: 'adjustment', data: undefined, clipped: true,
			adjustment: { type: 'hue/saturation', colorize: { hue: -131, saturation: 100, lightness: -50 } } },
	];
	assert.strictEqual(clippingTarget(adjustmentStack, 1).id, 'base');
	assert.strictEqual(clippingTarget(adjustmentStack, 2).id, 'base');
	assert.strictEqual(adjustmentLabel(adjustmentStack[2].adjustment), 'Hue/Saturation · Colorize');
	assert.strictEqual(adjustmentSummary(adjustmentStack[1].adjustment), 'Input 3–200 · γ 1.20');
	assert.strictEqual(adjustmentSummary(adjustmentStack[2].adjustment), 'Colorize · H -131° · S 100 · L -50');
	const adjustmentTree = buildLayerDisplayTree(adjustmentStack);
	assert.deepStrictEqual(adjustmentTree.map(item => item.layer.id), ['base']);
	assert.deepStrictEqual(adjustmentTree[0].effects.map(item => item.layer.id), ['levels', 'hue']);
	console.log('Layers panel hierarchy passed: ordering, nesting, descendants, and stable source group ids.');
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
