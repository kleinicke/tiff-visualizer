const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const compiled = buildSync({ entryPoints: ['media/modules/zoom-controller.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = { exports: {} };
new Function('module', 'exports', compiled.outputFiles[0].text)(loaded, loaded.exports);
const { ZoomController } = loaded.exports;

const scrolls = [];
const scrollRange = { scrollWidth: 800, scrollHeight: 600 };
const listeners = {};
global.window = {
  scrollX: 0,
  scrollY: 0,
  scrollBy(x, y) {
    scrolls.push([x, y]);
    this.scrollX = Math.min(scrollRange.scrollWidth - 800, Math.max(0, this.scrollX + x));
    this.scrollY = Math.min(scrollRange.scrollHeight - 600, Math.max(0, this.scrollY + y));
  },
  addEventListener: (type, fn) => { listeners[type] = fn; },
  removeEventListener: type => { delete listeners[type]; },
};
global.document = { body: { classList: { contains: () => false } }, scrollingElement: scrollRange, documentElement: { classList: { contains: () => false }, clientWidth: 800, clientHeight: 600 } };

function create({ scrollToZoom, scale = 2, isMac = true }) {
  const classes = new Set();
  const container = { classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) } };
  const controller = new ZoomController({ isMac, constants: {}, settings: { scrollToZoom } }, { getState: () => ({ scale }) });
  controller.container = container;
  controller.imageElement = { style: {}, offsetWidth: 200, offsetHeight: 100 };
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


({ controller } = create({ scrollToZoom: false }));
assert.equal(controller.beginPan({ button: 0, clientX: 0, clientY: 0, preventDefault() {} }, () => {}), false);

function press(controller, x = 100, y = 100) {
  let ended = null;
  assert.equal(controller.beginPan({ button: 0, clientX: x, clientY: y, preventDefault() {} }, moved => { ended = moved; }), true);
  return { move: (mx, my) => listeners.mousemove({ clientX: mx, clientY: my }), release: () => { listeners.mouseup({}); return ended; } };
}
const translate = c => c.imageElement.style.translate;

scrollRange.scrollWidth = 1600; scrollRange.scrollHeight = 1200;
window.scrollX = 300; window.scrollY = 300;
({ controller } = create({ scrollToZoom: true }));
let drag = press(controller);
assert.equal(controller.container.classList.contains('panning'), true);
drag.move(102, 101);
assert.deepEqual(scrolls, []);
drag.move(90, 120);
assert.deepEqual([window.scrollX, window.scrollY], [310, 280]);
assert.equal(translate(controller), '');
assert.equal(drag.release(), true);
assert.equal(controller.container.classList.contains('panning'), false);
assert.equal(listeners.mousemove, undefined);

({ controller } = create({ scrollToZoom: true }));
drag = press(controller);
drag.move(102, 101);
assert.equal(drag.release(), false);

window.scrollX = 790; window.scrollY = 590;
({ controller } = create({ scrollToZoom: true }));
drag = press(controller, 500, 500);
drag.move(400, 400);
assert.deepEqual([window.scrollX, window.scrollY], [800, 600]);
assert.equal(translate(controller), '-90px -90px');
drag.move(380, 400);
assert.equal(translate(controller), '-110px -90px');
drag.move(480, 400);
assert.equal(translate(controller), '-10px -90px');
assert.deepEqual([window.scrollX, window.scrollY], [800, 600]);
drag.move(500, 400);
assert.equal(translate(controller), '0px -90px');
assert.equal(window.scrollX, 790);
drag.release();

window.scrollX = 0; window.scrollY = 0;
({ controller } = create({ scrollToZoom: true }));
controller.imageElement.offsetWidth = 1600;
drag = press(controller);
drag.move(150, 130);
assert.equal(translate(controller), '50px 30px');
drag.move(10000, 130);
assert.equal(translate(controller), '768px 30px');
drag.release();

scrollRange.scrollWidth = 800; scrollRange.scrollHeight = 600;
for (const scale of [0.5, 'fit']) {
  window.scrollX = 0; window.scrollY = 0;
  ({ controller } = create({ scrollToZoom: true, scale }));
  drag = press(controller);
  drag.move(150, 90);
  assert.equal(translate(controller), '50px -10px');
  drag.move(10000, 90);
  assert.equal(translate(controller), '468px -10px');
  drag.release();
}

let redraws = 0;
({ controller } = create({ scrollToZoom: true }));
controller.onScaleChanged = () => { redraws++; };
drag = press(controller);
drag.move(150, 100);
assert.ok(redraws > 0);
drag.release();

({ controller } = create({ scrollToZoom: true }));
assert.equal(controller.beginPan({ button: 2, clientX: 0, clientY: 0, preventDefault() {} }, () => {}), false);
console.log('scroll zoom ok');
