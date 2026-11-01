import assert from 'node:assert/strict';
import { NavigationKeys } from '../out/media/modules/navigation-shortcuts.js';
let settings = {};
const keys = new NavigationKeys(() => settings, () => {});
const event = (key, code, extra = {}) => ({ key, code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, getModifierState: () => false, ...extra });
assert.equal(keys.step(event('ü', 'BracketLeft'), 0), -1);
assert.equal(keys.step(event('+', 'BracketRight'), 0), 1);
assert.equal(keys.step(event('*', 'BracketRight', { shiftKey: true }), 0), 0);
assert.equal(keys.step(event('}', 'BracketRight', { shiftKey: true }), 3), 1);
assert.equal(keys.step(event('<', 'Comma', { shiftKey: true }), 2), -1);
assert.equal(keys.step(event('>', 'Period', { shiftKey: true }), 2), 1);
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

settings = {};
assert.deepEqual(keys.bindings([{}], false), [1]);
assert.deepEqual(keys.bindings([{}], true), [0]);
assert.deepEqual(keys.bindings([{ isChoice: true }, {}, {}, {}], true), [0, 2, 3, -1]);
assert.deepEqual(keys.bindings([{ isChoice: true }, {}, {}, {}], false), [0, 1, 2, 3]);
settings = { '2': ['KeyJ', 'KeyK'] };
assert.deepEqual(keys.bindings([{}, {}, {}, {}], true), [0, 1, 2, 3]);
settings = { '1': ['ArrowLeft', 'KeyK'] };
assert.deepEqual(keys.bindings([{}, {}], true), [2, 3]);

settings = {};
assert.equal(keys.hint(2), '< >');
assert.equal(keys.hint(3), '{ }');
const keyboard = new EventTarget();
let layout = new Map([
  ['BracketLeft', 'ü'], ['BracketRight', '+'], ['Comma', ','], ['Period', '.'],
  ['Semicolon', 'ö'], ['Quote', 'ä'],
]);
keyboard.getLayoutMap = async () => layout;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { keyboard } });
globalThis.window = new EventTarget();
keys.watchLayout();
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual([0, 1, 2, 3].map(i => keys.hint(i)), ['Ü +', '← →', ', .', 'Ö Ä']);
for (const [position, codes] of [[0, ['BracketLeft', 'BracketRight']], [2, ['Comma', 'Period']], [3, ['Semicolon', 'Quote']]]) {
  for (const [index, code] of codes.entries()) {
    assert.equal(keys.step(event(layout.get(code), code), position), index === 0 ? -1 : 1);
    assert.equal(keys.step(event(layout.get(code), code, { shiftKey: true }), position), 0);
  }
}
settings = { '3': ['Shift+KeyJ', 'Shift+KeyK'] };
assert.equal(keys.hint(2), 'Shift+J Shift+K');
assert.equal(keys.step(event('K', 'KeyK', { shiftKey: true }), 2), 1);
settings = {};
// Reported dead/unavailable positions must not produce unusable shortcuts.
layout = new Map([['BracketLeft', 'Dead'], ['BracketRight', ''], ['Comma', ','], ['Period', '.']]);
keyboard.dispatchEvent(new Event('layoutchange'));
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual([0, 2, 3].map(i => keys.hint(i)), [', .', 'PgUp PgDn', 'Home End']);
assert.equal(keys.step(event('PageDown', 'PageDown'), 0), 0);
assert.equal(keys.step(event('PageDown', 'PageDown'), 2), 1);
layout = new Map([['BracketLeft', '['], ['BracketRight', ']'], ['Comma', ','], ['Period', '.']]);
keyboard.dispatchEvent(new Event('layoutchange'));
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual([0, 2, 3].map(i => keys.hint(i)), ['[ ]', '< >', '{ }']);
const observed = new NavigationKeys(() => ({}), () => {});
observed.observe(event('ü', 'BracketLeft'));
assert.equal(observed.hint(2), ', .');
assert.equal(observed.step(event('.', 'Period'), 2), 1);
console.log('Automatic US/non-US defaults, layout changes, unshifted pairs, fallback keys and overrides passed.');
