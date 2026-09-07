/** Explicit host boundary for embedded IDE controls; contains no rendering code. */
export interface EmbeddedImageHost {
  snapshot(): unknown;
  adjust(name: string, values: number[]): void;
  command(name: string): void;
  theme(value: 'dark' | 'light'): void;
}
export function installEmbeddedImageHost(host: EmbeddedImageHost): void {
  if (new URLSearchParams(location.search).get('host') !== 'jetbrains') return;
  (window as any).scientificImageHost = host;
  document.documentElement.classList.add('jetbrains-host');
}
export function notifyEmbeddedImageHost(): void {
  window.dispatchEvent(new Event('scientific-image-state'));
}
