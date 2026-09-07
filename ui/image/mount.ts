import { mount } from 'svelte';
import ImageInspector from './ImageInspector.svelte';
import { createImageUiBridge } from './bridge';
import type { DisplaySettings } from '../../shared/display-settings';

export function mountImageInspector(settings: Partial<DisplaySettings>, send: (message: { type: string; [key: string]: unknown }) => void) {
  const bridge = createImageUiBridge({
    normalization: settings.normalization || { min: 0, max: 1, autoNormalize: true, gammaMode: false },
    gamma: settings.gamma || { in: 2.2, out: 2.2 }, brightness: settings.brightness || { offset: 0 },
    normalizedFloatMode: settings.normalizedFloatMode,
  }, send);
  const target = document.createElement('div');
  target.id = 'image-ui-root';
  document.body.append(target);
  mount(ImageInspector, { target, props: { bridge } });
  // Svelte's delegated handlers run at this root first. Keep UI gestures away
  // from the image's pan/zoom, context menu, and legacy slider handlers.
  for (const type of ['mousedown', 'click', 'dblclick', 'wheel', 'contextmenu', 'keydown']) {
    target.addEventListener(type, event => event.stopPropagation());
  }
  target.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    target.querySelector<HTMLButtonElement>('[aria-label="Close inspector"]')?.click();
    target.querySelector<HTMLButtonElement>('nav button')?.focus();
  });
  bridge.message({ type: 'updateSettings', settings });
  return bridge;
}
