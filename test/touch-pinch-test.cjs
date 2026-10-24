const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const compiled = buildSync({ entryPoints: ['media/modules/zoom-controller.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = { exports: {} };
new Function('module', 'exports', compiled.outputFiles[0].text)(loaded, loaded.exports);
const { ZoomController } = loaded.exports;

const scrolls = [];
const body = { classList: { contains: () => false } };
global.window = { scrollBy: (x, y) => scrolls.push([x, y]) };
global.document = { body, documentElement: { classList: { contains: () => false } } };

const image = {};
const panel = { closest: () => null };
const overlay = { closest: selector => (selector === '.measure-overlay' ? overlay : null) };

function createController(scale) {
  const controller = new ZoomController({ isMac: false, constants: {} }, { getState: () => ({ scale }) });
  controller.imageElement = { contains: element => element === image };
  controller.hasLoadedImage = true;
  controller.firstZoom = () => { controller.scale = 0.5; };
  controller.updateScale = (value, anchor) => { controller.scale = value; controller.anchor = anchor; };
  return controller;
}

function touch(type, points, { target = image, cancelable = true } = {}) {
  return {
    type,
    cancelable,
    prevented: false,
    touches: points.map(([clientX, clientY]) => ({ clientX, clientY, target })),
    preventDefault() { this.prevented = true; },
  };
}

// Spreading fingers zooms in by the distance ratio, relative to the start of the pinch.
let controller = createController(2);
const start = touch('touchstart', [[0, 0], [100, 0]]);
controller.handleTouch(start);
assert.equal(start.prevented, true);
assert.equal(controller.scale, 2);
controller.handleTouch(touch('touchmove', [[0, 0], [200, 0]]));
assert.equal(controller.scale, 4);
controller.handleTouch(touch('touchmove', [[0, 0], [50, 0]]));
assert.equal(controller.scale, 1);

// The pinch anchors on the fingers' midpoint; the content follows them when both move.
controller = createController(1);
controller.handleTouch(touch('touchstart', [[100, 200], [200, 200]]));
scrolls.length = 0;
controller.handleTouch(touch('touchmove', [[80, 190], [280, 190]]));
assert.equal(controller.scale, 2);
assert.deepEqual(controller.anchor, { x: 150, y: 200 });
assert.deepEqual(scrolls, [[-30, 10]], 'midpoint moved (+30, -10) so the view scrolls the opposite way');
controller.handleTouch(touch('touchmove', [[80, 190], [280, 190]]));
assert.deepEqual(controller.anchor, { x: 180, y: 190 }, 'the anchor follows the fingers');
assert.deepEqual(scrolls[1], [0, 0]);

// A move the browser will not let us cancel is already being panned natively.
scrolls.length = 0;
controller.handleTouch(touch('touchmove', [[80, 190], [300, 190]], { cancelable: false }));
assert.deepEqual(scrolls, []);

// Leaving fit mode starts the pinch from the displayed scale.
controller = createController('fit');
controller.handleTouch(touch('touchstart', [[0, 0], [0, 100]]));
controller.handleTouch(touch('touchmove', [[0, 0], [0, 300]]));
assert.equal(controller.scale, 1.5);

// One finger is left to native scrolling and ends a pinch in progress.
controller = createController(1);
controller.handleTouch(touch('touchstart', [[0, 0], [100, 0]]));
const single = touch('touchmove', [[0, 0]]);
controller.handleTouch(single);
assert.equal(single.prevented, false);
controller.handleTouch(touch('touchmove', [[0, 0], [400, 0]]));
assert.equal(controller.scale, 1, 'a pinch resumed after one finger lifts must re-anchor, not jump');

// Lifting a finger (touchend with one touch left) also ends the pinch; three fingers are not a pinch.
controller.handleTouch(touch('touchend', [[0, 0]]));
controller.handleTouch(touch('touchmove', [[0, 0], [200, 0]]));
assert.equal(controller.scale, 1);
const three = touch('touchstart', [[0, 0], [100, 0], [50, 80]]);
controller.handleTouch(three);
assert.equal(three.prevented, false);

// Fingers on panels or controls never zoom the image; the page background, image and measure overlay do.
for (const [target, zooms] of [[panel, false], [overlay, true], [body, true], [image, true]]) {
  controller = createController(1);
  controller.handleTouch(touch('touchstart', [[0, 0], [100, 0]], { target }));
  controller.handleTouch(touch('touchmove', [[0, 0], [200, 0]], { target }));
  assert.equal(controller.scale, zooms ? 2 : 1);
}
controller = createController(1);
const mixed = touch('touchstart', [[0, 0], [100, 0]]);
mixed.touches[1].target = panel;
controller.handleTouch(mixed);
assert.equal(mixed.prevented, false, 'one finger on the image and one on a panel is not a pinch');

// While Safari's gesture events own a pinch, the touch path stays out of it.
controller = createController(1);
controller.gestureScale = 1;
const owned = touch('touchstart', [[0, 0], [100, 0]]);
controller.handleTouch(owned);
assert.equal(owned.prevented, false);

// Nothing happens before an image is loaded, and coincident fingers are ignored.
controller = createController(1);
controller.hasLoadedImage = false;
controller.handleTouch(touch('touchstart', [[0, 0], [100, 0]]));
controller.hasLoadedImage = true;
const degenerate = touch('touchstart', [[5, 5], [5, 5]]);
controller.handleTouch(degenerate);
assert.equal(degenerate.prevented, false);

console.log('Touch pinch zoom tests passed.');
