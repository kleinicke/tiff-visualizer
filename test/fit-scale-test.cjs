const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const compiled = buildSync({ entryPoints: ['media/modules/zoom-controller.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = { exports: {} };
new Function('module', 'exports', compiled.outputFiles[0].text)(loaded, loaded.exports);
const { ZoomController } = loaded.exports;

global.getComputedStyle = () => ({ paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px' });
global.window = { scrollX: 0, scrollY: 0, scrollTo() {} };
const viewport = { clientWidth: 1000, clientHeight: 600 };
global.document = { body: {}, documentElement: viewport };

function create(width, height, classes = [], extra = {}) {
  const set = new Set(['scale-to-fit', ...classes]);
  const image = { naturalWidth: width, naturalHeight: height, parentElement: {}, style: {}, classList: { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c) }, getBoundingClientRect: () => ({ left: 0, top: 0 }), dataset: {} };
  const bodyClasses = new Set();
  const container = { classList: { contains: c => bodyClasses.has(c), toggle() {}, add() {}, remove() {} } };
  const settings = { constants: { PIXELATION_THRESHOLD: 3, MAX_SCALE: 200, MIN_SCALE: 0.1 }, settings: extra, isMac: true };
  const controller = new ZoomController(settings, { getState: () => ({}), setState() {}, postMessage() {} });
  controller.container = container;
  controller.imageElement = image;
  controller.hasLoadedImage = true;
  return { controller, image, set };
}

let { controller, image, set } = create(100, 60);
controller.updateScale('fit');
assert.equal(controller.scale, 'fit');
assert.equal(image.style.width, `${100 * (580 / 60)}px`);
assert.equal(image.style.height, `${60 * (580 / 60)}px`);
assert.equal(image.style.margin, 'auto');
assert.equal(set.has('pixelated'), true);

({ controller, image, set } = create(900, 500));
controller.updateScale('fit');
assert.equal(image.style.width, `${900 * (980 / 900)}px`);
assert.equal(set.has('pixelated'), false);

({ controller, image, set } = create(4000, 3000));
controller.updateScale('fit');
assert.equal(image.style.width, '');
assert.equal(image.style.height, '');
assert.equal(set.has('pixelated'), false);

({ controller, image } = create(100, 60));
controller.updateScale('fit');
viewport.clientWidth = 500;
viewport.clientHeight = 400;
controller.refit();
assert.equal(image.style.width, `${100 * 4.8}px`);
viewport.clientWidth = 50;
controller.refit();
assert.equal(image.style.width, '');
viewport.clientWidth = 1000;
viewport.clientHeight = 600;
({ controller, image, set } = create(100, 60, [], { fitUpscale: false }));
controller.updateScale('fit');
assert.equal(image.style.width, '', 'fitUpscale off leaves a small image to the CSS fit');
assert.equal(set.has('pixelated'), false);
controller.refit();
assert.equal(image.style.width, '');

({ controller, image } = create(100, 60, ['pyramid-scene'], { fitUpscale: false }));
controller.updateScale('fit');
assert.equal(image.style.width, '100px', 'a pyramid scene stays capped at 100% with fitUpscale off');

({ controller, image } = create(100, 60, ['pyramid-scene']));
controller.updateScale('fit');
assert.equal(image.style.width, `${100 * (580 / 60)}px`);
console.log('fit scale ok');
