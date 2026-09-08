import { mount } from 'svelte';
import Comparison from '../ui/components/Comparison.svelte';

const vscode = (globalThis as any).acquireVsCodeApi() as { postMessage(message: unknown): void };
mount(Comparison, {
  target: document.body,
  props: { images: (window as any).imageData ?? [], send: (message: { type: string; uri?: string }) => vscode.postMessage(message) },
});
