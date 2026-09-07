const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const { buildSync } = require('esbuild');

// Exercise the real host state owner, including its change notifications.
const output = buildSync({ entryPoints: ['src/imagePreview/appStateManager.ts'], bundle: true,
  platform: 'node', format: 'cjs', external: ['vscode'], write: false }).outputFiles[0].text;
const compiled = new Module(__filename);
compiled.require = name => name === 'vscode' ? {
  EventEmitter: class {
    listeners = new Set();
    event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  },
} : require(name);
compiled._compile(output, __filename);
const { AppStateManager } = compiled.exports;

test('one display edit publishes one coherent host snapshot', () => {
  const manager = new AppStateManager();
  const observed = [];
  manager.onDidChangeSettings(settings => observed.push(structuredClone(settings)));
  manager.editDisplaySettings({ kind: 'exposure', value: -2 });
  assert.equal(observed.length, 1);
  assert.equal(manager.imageSettings.brightness.offset, -2);
  assert.equal(manager.imageSettings.normalization.gammaMode, true);
  assert.equal(manager.imageSettings.normalization.autoNormalize, false);
  manager.editDisplaySettings({ kind: 'range', min: -5, max: 5 });
  assert.equal(observed.length, 2);
  assert.deepEqual(manager.imageSettings.normalization, { min: -5, max: 5, autoNormalize: false, gammaMode: false });
  manager.editDisplaySettings({ kind: 'gamma', input: 1.8, output: 2.2 });
  assert.equal(manager.imageSettings.gamma.in, 1.8);
  assert.equal(manager.imageSettings.normalization.gammaMode, true);
  manager.editDisplaySettings({ kind: 'mode', value: 'auto' });
  assert.equal(manager.imageSettings.normalization.autoNormalize, true);
  assert.equal(manager.imageSettings.normalization.gammaMode, false);
});

test('invalid webview edits do not change host state or publish a render', () => {
  const manager = new AppStateManager();
  const original = structuredClone(manager.imageSettings);
  let notifications = 0;
  manager.onDidChangeSettings(() => notifications++);
  for (const edit of [null, {}, { kind: 'mode', value: 'bad' },
    { kind: 'range', min: 2, max: 1 }, { kind: 'range', min: 1, max: 1 },
    { kind: 'gamma', input: 0, output: 2.2 }, { kind: 'gamma', input: '2', output: 2 },
    { kind: 'exposure', value: Infinity }, { kind: 'exposure', value: NaN },
    { kind: 'exposure', value: 17 }, { kind: 'mode', value: { toString: () => 'auto' } },
  ]) manager.editDisplaySettings(edit);
  assert.deepEqual(manager.imageSettings, original);
  assert.equal(notifications, 0);
});
