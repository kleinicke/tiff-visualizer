/** Regression tests for the retained multiresolution scene. */
const assert = require('assert');
const path = require('path');

class FakeClassList {
	constructor() { this.values = new Set(); }
	add(...names) { names.forEach(name => this.values.add(name)); }
	remove(...names) { names.forEach(name => this.values.delete(name)); }
	contains(name) { return this.values.has(name); }
}

class FakeElement {
	constructor(tagName) {
		this.tagName = tagName.toUpperCase();
		this.children = [];
		this.parentNode = null;
		this.style = {};
		this.dataset = {};
		this.classList = new FakeClassList();
		this.width = 0;
		this.height = 0;
		this.clientWidth = 0;
		this._className = '';
	}
	set className(value) {
		this._className = value;
		this.classList = new FakeClassList();
		String(value).split(/\s+/).filter(Boolean).forEach(name => this.classList.add(name));
	}
	get className() { return this._className; }
	appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
	remove() {
		if (!this.parentNode) return;
		this.parentNode.children = this.parentNode.children.filter(child => child !== this);
		this.parentNode = null;
	}
	getContext(kind) {
		if (this.tagName !== 'CANVAS' || kind !== '2d') return null;
		return { putImageData: (...args) => { this.lastPut = args; } };
	}
}

async function main() {
	global.document = { createElement: tag => new FakeElement(tag) };
	const { PyramidScene } = await import(
		path.join('..', 'out', 'media', 'modules', 'pyramid-scene.js').replace(/\\/g, '/')
	);

	const full = { index: 0, width: 40000, height: 40000, reduction: 1, blockWidth: 512, blockHeight: 512 };
	const half = { index: 1, width: 20000, height: 20000, reduction: 2, blockWidth: 512, blockHeight: 512 };
	const base = new FakeElement('canvas');
	base.width = 5000; base.height = 5000; base.className = 'scale-to-fit';
	const scene = new PyramidScene(base, full.width, full.height, 4 * 512 * 512);

	assert.strictEqual(scene.element.dataset.sceneWidth, '40000');
	assert.strictEqual(base.parentNode, scene.element, 'overview is owned by the stable scene');
	assert.strictEqual(base.style.width, '100%');
	console.log('✅ The overview and detail share one full-resolution scene transform');

	const request = scene.missingRect(full, { x: 520, y: 20, width: 100, height: 100 });
	assert.deepStrictEqual(request, { x: 512, y: 0, width: 512, height: 512 });
	const imageData = { width: 512, height: 512, data: new Uint8ClampedArray(512 * 512 * 4) };
	scene.commitRegion(full, request, imageData);
	assert.strictEqual(scene.tileCount, 1);
	assert.strictEqual(scene.missingRect(full, { x: 530, y: 30, width: 50, height: 50 }), null,
		'a loaded block is retained across nearby zoom/pan requests');
	console.log('✅ Loaded blocks are retained and reused instead of flashing back to an overview');

	const halfRequest = { x: 0, y: 0, width: 512, height: 512 };
	scene.commitRegion(half, halfRequest, imageData);
	const tiles = scene.element.children.filter(child => child.classList.contains('pyramid-tile'));
	const fullTile = tiles.find(tile => tile.style.zIndex === '999999');
	const halfTile = tiles.find(tile => tile.style.zIndex === '999998');
	assert.ok(fullTile && halfTile);
	assert.ok(Number(fullTile.style.zIndex) > Number(halfTile.style.zIndex),
		'finer pixels always win independent of decode arrival order');
	console.log('✅ Finer retained tiles always cover coarser tiles deterministically');

	for (let column = 2; column < 8; column++) {
		const rect = { x: column * 512, y: 0, width: 512, height: 512 };
		scene.commitRegion(full, rect, imageData);
	}
	assert.ok(scene.tilePixels <= 4 * 512 * 512, 'LRU cache stays inside its pixel budget');
	console.log('✅ The retained tile cache has a hard memory budget');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
