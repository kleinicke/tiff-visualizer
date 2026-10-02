const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const compiled = buildSync({ entryPoints: ['media/modules/zoom-controller.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = { exports: {} };
new Function('module', 'exports', compiled.outputFiles[0].text)(loaded, loaded.exports);
const { ZoomController } = loaded.exports;
function zoom(host, deltaY, ctrlKey, altKey) {
  global.document = { body: { classList: { contains: () => host !== 'vscode' } }, documentElement: { classList: { contains: () => host === 'jetbrains' } } };
  const controller = new ZoomController({ isMac: true, constants: { SCALE_PINCH_FACTOR: 0.075 } }, { getState: () => ({ scale: 1 }) });
  controller.imageElement = {};
  controller.hasLoadedImage = true;
  controller.updateScale = value => { controller.scale = value; };
  controller.handleWheelZoom({ deltaY, deltaMode: 0, ctrlKey, altKey, preventDefault() {}, stopPropagation() {} }, false, false);
  return controller.scale;
}
for (const delta of [-100, -5, 0, 5, 100]) {
  for (const [ctrl, alt] of [[true, false], [false, true], [false, false]]) {
    assert.equal(zoom('jetbrains', delta, ctrl, alt), zoom('vscode', delta, ctrl, alt));
  }
}
assert.notEqual(zoom('website', -100, true, false), zoom('jetbrains', -100, true, false));
console.log('JetBrains/VS Code wheel zoom parity passed; website response preserved.');
