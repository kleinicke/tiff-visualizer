const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const compiled = buildSync({ entryPoints: ['media/modules/zoom-controller.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = { exports: {} };
new Function('module', 'exports', compiled.outputFiles[0].text)(loaded, loaded.exports);
const { ZoomController } = loaded.exports;

global.document = { body: { classList: { contains: () => false } }, documentElement: { classList: { contains: () => false } } };

function createController(scale) {
  const controller = new ZoomController({ isMac: false, constants: {} }, { getState: () => ({ scale }) });
  controller.imageElement = {};
  controller.hasLoadedImage = true;
  controller.firstZoom = () => { controller.scale = 0.5; };
  controller.updateScale = value => { controller.scale = value; };
  return controller;
}

function touch(type, points) {
  const event = {
    type,
    cancelable: true,
    prevented: false,
    touches: points.map(([clientX, clientY]) => ({ clientX, clientY })),
    preventDefault() { this.prevented = true; },
  };
  return event;
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

// Nothing happens before an image is loaded, and coincident fingers are ignored.
controller = createController(1);
controller.hasLoadedImage = false;
controller.handleTouch(touch('touchstart', [[0, 0], [100, 0]]));
controller.hasLoadedImage = true;
const degenerate = touch('touchstart', [[5, 5], [5, 5]]);
controller.handleTouch(degenerate);
assert.equal(degenerate.prevented, false);

console.log('Touch pinch zoom tests passed.');
