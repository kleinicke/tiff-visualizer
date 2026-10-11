/** Shared navigation bindings and layout-aware labels, independent of image format. */
export type NavigationShortcuts = Record<string, readonly string[]>;
type LayoutKeyboard = { getLayoutMap?: () => Promise<Map<string, string>>; addEventListener?: EventTarget['addEventListener'] };
const defaults = [
  ['BracketLeft', 'BracketRight'], ['ArrowLeft', 'ArrowRight'],
  ['Shift+Comma', 'Shift+Period'], ['Shift+BracketLeft', 'Shift+BracketRight'],
];
const literals = [['[', ']'], [], ['<', '>'], ['{', '}']];
const names: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', PageUp: 'PgUp', PageDown: 'PgDn' };
const fallbackLabels: Record<string, string> = { BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Semicolon: ';', Quote: "'", Backquote: '`', Minus: '-', Equal: '=', Slash: '/', Backslash: '\\', IntlBackslash: 'ISO extra key' };
const physical = /^(Key[A-Z]|Digit[0-9]|BracketLeft|BracketRight|Comma|Period|Semicolon|Quote|Backquote|Minus|Equal|Slash|Backslash|IntlBackslash|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|PageUp|PageDown|Home|End|F(?:[1-9]|1[0-2]))$/;
function parse(value: string) {
  const shift = value.startsWith('Shift+');
  const key = shift ? value.slice(6) : value;
  if (!physical.test(key) && Array.from(key).length !== 1) return undefined;
  return { key, shift, code: physical.test(key) };
}

export class NavigationKeys {
  private labels = new Map<string, string>();
  constructor(private readonly settings: () => unknown, private readonly changed: () => void) {}

  /** Layout lookup is optional in webviews; observed unmodified keys fill gaps. */
  watchLayout() {
    const keyboard = (navigator as Navigator & { keyboard?: LayoutKeyboard }).keyboard;
    const refresh = async () => {
      try {
        const map = await keyboard?.getLayoutMap?.();
        if (map) { this.labels = new Map(map); this.changed(); }
      } catch { /* Embedded hosts may disallow keyboard-map access. */ }
    };
    void refresh();
    // Chromium's Keyboard API can expose getLayoutMap without EventTarget.
    if (typeof keyboard?.addEventListener === 'function') {
      keyboard.addEventListener('layoutchange', refresh);
    }
    window.addEventListener('focus', refresh);
  }

  observe(event: KeyboardEvent) {
    if (!event.code || event.isComposing || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || Array.from(event.key).length !== 1) return;
    if (this.labels.get(event.code) !== event.key) {
      this.labels.set(event.code, event.key); this.changed();
    }
  }

  private pair(position: number): { keys: readonly string[]; custom: boolean } {
    const config = this.settings();
    const pair = config && typeof config === 'object' ? (config as NavigationShortcuts)[String(position + 1)] : undefined;
    if (Array.isArray(pair) && pair.length === 2 && pair.every(v => typeof v === 'string' && parse(v)) && pair[0] !== pair[1]) {
      return { keys: pair, custom: true };
    }
    return { keys: defaults[position] || [], custom: false };
  }

  step(event: KeyboardEvent, position: number): number {
    if (event.isComposing || event.metaKey || (event.ctrlKey && !event.getModifierState('AltGraph'))) return 0;
    const { keys, custom } = this.pair(position);
    // Resolve physical bindings before legacy characters across all rows in the caller.
    for (let i = 0; i < keys.length; i++) {
      const binding = parse(keys[i])!;
      if (!event.ctrlKey && !event.altKey && (binding.code
        ? event.shiftKey === binding.shift && event.code === binding.key
        : (!binding.shift || event.shiftKey) && event.key === binding.key)) return i === 0 ? -1 : 1;
    }
    if (!custom && position === 0 && !event.shiftKey && !event.ctrlKey && !event.altKey) {
      if (event.code === 'PageUp') return -1;
      if (event.code === 'PageDown') return 1;
    }
    return 0;
  }

  legacyStep(event: KeyboardEvent, position: number): number {
    if (this.pair(position).custom || event.isComposing || event.metaKey || (event.ctrlKey && !event.getModifierState('AltGraph'))) return 0;
    const index = literals[position]?.indexOf(event.key) ?? -1;
    return index < 0 ? 0 : index === 0 ? -1 : 1;
  }

  hint(position: number): string {
    return this.pair(position).keys.map(value => {
      const binding = parse(value)!;
      const label = binding.code ? names[binding.key] || this.labels.get(binding.key) || fallbackLabels[binding.key] ||
        (binding.key.startsWith('Key') ? binding.key.slice(3) : binding.key.startsWith('Digit') ? binding.key.slice(5) : binding.key) : binding.key;
      return `${binding.shift ? 'Shift+' : ''}${label.length === 1 && label.toLocaleUpperCase().length === 1 ? label.toLocaleUpperCase() : label}`;
    }).join(' ');
  }
}
