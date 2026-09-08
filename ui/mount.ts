import { flushSync, mount, unmount, type Component } from 'svelte';
import { writable, type Writable } from 'svelte/store';

/** A one-way snapshot bridge. The engine/host remains the settings owner. */
export function mountView<T>(component: Component<{ model: Writable<T> }>, initial: T, target: HTMLElement = document.body) {
  const model = writable(initial);
  const instance = flushSync(() => mount(component, { target, props: { model } }));
  return {
    update(value: T) { flushSync(() => model.set(value)); },
    dispose() { void unmount(instance); },
  };
}
