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
	const { buildLayerDisplayTree } = await import(panelPath);
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
	console.log('Layers panel hierarchy passed: ordering, nesting, descendants, and stable source group ids.');
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
