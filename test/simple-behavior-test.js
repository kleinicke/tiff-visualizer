const assert = require('node:assert/strict');
const { loadSource } = require('./lib/load-source.cjs');
const { AppStateManager } = loadSource('src/imagePreview/appStateManager.ts');
const { defaultDisplaySettings, setDisplayMode } = loadSource('shared/display-settings.ts');

const manager = new AppStateManager();
let changes = 0;
const subscription = manager.onDidChangeSettings(() => changes++);
manager.updateNormalization(-4, 8);
manager.setAutoNormalize(true);
manager.setGammaMode(true);
assert.deepEqual(manager.imageSettings.normalization, { min: -4, max: 8, autoNormalize: false, gammaMode: true });
manager.setGammaMode(false);
assert.deepEqual(manager.imageSettings.normalization, { min: -4, max: 8, autoNormalize: false, gammaMode: false });
const before = changes;
manager.setGammaMode(false);
assert.equal(changes, before, 'unchanged settings do not trigger rendering');

manager.setImageFormat('png');
manager.updateGamma(1.4, 2.2);
manager.setImageFormat('npy-uint');
assert.equal(manager.imageSettings.normalization.autoNormalize, true);
manager.setImageFormat('png');
assert.equal(manager.imageSettings.gamma.in, 1.4, 'format settings survive switches');
const copy = manager.getSettingsForFormat('png');
copy.gamma.in = 99;
assert.equal(manager.imageSettings.gamma.in, 1.4, 'snapshots do not alias live settings');

for (const format of ['ico', 'png', 'tiff-int', 'tiff-int-signed', 'npy-uint', 'jxl-float', 'exr-float', 'unknown']) {
  const fresh = new AppStateManager();
  assert.deepEqual(fresh.getSettingsForFormat(format), defaultDisplaySettings(format), `${format}: host uses shared policy`);
  fresh.dispose();
}
const settings = defaultDisplaySettings('ico');
assert.equal(settings.normalization.gammaMode, true, 'ICO keeps its authored display range in every host');
setDisplayMode(settings, 'auto');
assert.equal(settings.normalization.gammaMode, false);
setDisplayMode(settings, 'manual');
assert.equal(settings.normalization.autoNormalize, false);

manager.setImageSize('1024×768');
manager.setImageZoom(2);
manager.updateImageStats(-5, 9);
assert.equal(manager.uiState.zoom, 2);
assert.equal(manager.uiState.imageSize, '1024×768');
assert.deepEqual(manager.imageStats, { min: -5, max: 9 });
subscription.dispose();
manager.dispose();
console.log('Production settings: transitions, notifications, format defaults and isolation passed.');
