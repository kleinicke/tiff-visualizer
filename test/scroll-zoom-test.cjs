const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const compiled = buildSync({ entryPoints: ['media/modules/zoom-controller.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = { exports: {} };
new Function('module', 'exports', compiled.outputFiles[0].text)(loaded, loaded.exports);
const { ZoomController } = loaded.exports;

const scrolls = [];
const listeners = {};
global.window = {
  scrollBy: (x, y) => scrolls.push([x, y]),
  addEventListener: (type, fn) => { listeners[type] = fn; },
  removeEventListener: type => { delete listeners[type]; },
};
global.document = { body: { classList: { contains: () => false } }, documentElement: { classList: { contains: () => false }, clientWidth: 800, clientHeight: 600 } };

function create({ scrollToZoom, scale = 2, isMac = true }) {
  const classes = new Set();
  const container = { classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) } };
  const controller = new ZoomController({ isMac, constants: {}, settings: { scrollToZoom } }, { getState: () => ({ scale }) });
  controller.container = container;
  controller.imageElement = {};
  controller.hasLoadedImage = true;
  controller.scale = scale;
  controller.firstZoom = () => { controller.scale = 1; };
  controller.updateScale = (value, anchor) => { controller.scale = value; controller.anchor = anchor; };
  return { controller, classes };
}

function wheel(overrides = {}) {
  return { deltaY: -100, deltaMode: 0, clientX: 30, clientY: 40, altKey: false, ctrlKey: false, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...overrides };
}

let { controller } = create({ scrollToZoom: false });
let event = wheel();
controller.handleWheelZoom(event, false, false);
assert.equal(event.prevented, false);
assert.equal(controller.scale, 2);

({ controller } = create({ scrollToZoom: true }));
event = wheel();
controller.handleWheelZoom(event, false, false);
assert.equal(event.prevented, true);
assert.ok(Math.abs(controller.scale - 2 * Math.exp(100 * 0.0025)) < 1e-9);
assert.deepEqual(controller.anchor, { x: 30, y: 40 });

({ controller } = create({ scrollToZoom: true }));
controller.handleWheelZoom(wheel({ deltaY: 100 }), false, false);
assert.ok(controller.scale < 2);

({ controller } = create({ scrollToZoom: true, scale: 'fit' }));
controller.handleWheelZoom(wheel(), false, false);
assert.ok(controller.scale > 1);

({ controller } = create({ scrollToZoom: true, scale: 'fit' }));
assert.equal(controller.beginPan({ button: 0, clientX: 0, clientY: 0, preventDefault() {} }, () => {}), false);

({ controller } = create({ scrollToZoom: false }));
assert.equal(controller.beginPan({ button: 0, clientX: 0, clientY: 0, preventDefault() {} }, () => {}), false);

({ controller } = create({ scrollToZoom: true }));
let ended = null;
let prevented = false;
const { classes } = { classes: controller.container.classList };
assert.equal(controller.beginPan({ button: 0, clientX: 100, clientY: 100, preventDefault() { prevented = true; } }, moved => { ended = moved; }), true);
assert.equal(prevented, true);
assert.equal(controller.container.classList.contains('panning'), true);
listeners.mousemove({ clientX: 102, clientY: 101 });
assert.deepEqual(scrolls, []);
listeners.mousemove({ clientX: 90, clientY: 120 });
assert.deepEqual(scrolls, [[10, -20]]);
listeners.mousemove({ clientX: 85, clientY: 120 });
assert.deepEqual(scrolls[1], [5, 0]);
listeners.mouseup({});
assert.equal(ended, true);
assert.equal(controller.container.classList.contains('panning'), false);
assert.equal(listeners.mousemove, undefined);

({ controller } = create({ scrollToZoom: true }));
controller.beginPan({ button: 0, clientX: 100, clientY: 100, preventDefault() {} }, moved => { ended = moved; });
listeners.mousemove({ clientX: 102, clientY: 101 });
listeners.mouseup({});
assert.equal(ended, false);

({ controller } = create({ scrollToZoom: true }));
assert.equal(controller.beginPan({ button: 2, clientX: 0, clientY: 0, preventDefault() {} }, () => {}), false);
console.log('scroll zoom ok');
