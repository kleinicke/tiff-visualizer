import assert from 'node:assert/strict';
import { NavigationKeys } from '../out/media/modules/navigation-shortcuts.js';
let settings = {};
const keys = new NavigationKeys(() => settings, () => {});
const event = (key, code, extra = {}) => ({ key, code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, getModifierState: () => false, ...extra });
assert.equal(keys.step(event('ü', 'BracketLeft'), 0), -1);
assert.equal(keys.step(event('+', 'BracketRight'), 0), 1);
assert.equal(keys.step(event('*', 'BracketRight', { shiftKey: true }), 0), 0);
assert.equal(keys.step(event('*', 'BracketRight', { shiftKey: true }), 3), 1);
assert.equal(keys.step(event(';', 'Comma', { shiftKey: true }), 2), -1);
assert.equal(keys.step(event(':', 'Period', { shiftKey: true }), 2), 1);
assert.equal(keys.legacyStep(event(']', 'Digit9', { ctrlKey: true, altKey: true, getModifierState: name => name === 'AltGraph' }), 0), 1);
for (const modifier of ['ctrlKey', 'metaKey', 'isComposing']) {
  assert.equal(keys.step(event('+', 'BracketRight', { [modifier]: true }), 0), 0);
  assert.equal(keys.legacyStep(event(']', 'BracketRight', { [modifier]: true }), 0), 0);
}
settings = { '1': ['KeyJ', 'KeyK'] };
assert.equal(keys.step(event('j', 'KeyJ'), 0), -1);
assert.equal(keys.step(event('k', 'KeyK'), 0), 1);
assert.equal(keys.step(event('PageDown', 'PageDown'), 0), 0);
assert.equal(keys.legacyStep(event(']', 'BracketRight'), 0), 0);
assert.equal(keys.hint(0), 'J K');
settings = { '1': ['ü', '+'], '2': ['Shift+KeyJ', 'Shift+KeyK'] };
assert.equal(keys.step(event('ü', 'Quote'), 0), -1);
assert.equal(keys.step(event('+', 'Equal', { shiftKey: true }), 0), 1);
assert.equal(keys.step(event('K', 'KeyK', { shiftKey: true }), 1), 1);
for (const invalid of [null, 1, [], { '1': [] }, { '1': ['Bogus', 'KeyK'] }, { '1': ['KeyJ', 'KeyJ'] }]) {
  settings = invalid;
  assert.equal(keys.step(event('+', 'BracketRight'), 0), 1);
}
console.log('Navigation shortcuts: layout positions, modifiers, aliases, custom pairs and invalid settings passed.');
