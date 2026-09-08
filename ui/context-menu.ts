import ContextMenu from './components/ContextMenu.svelte';
import { mountView } from './mount';
export interface MenuItem { label?: string; action?: () => void; separator?: boolean }
export interface MenuModel { items: MenuItem[]; className?: string; element?: HTMLDivElement; close: () => void }
let active: (() => void) | undefined;
/** One menu at a time; disposal also releases the global dismissal listeners. */
export function openContextMenu(items: MenuItem[], x: number, y: number, className = '', alignRight = false) {
  active?.();
  const priorFocus = document.activeElement as HTMLElement | null;
  const model: MenuModel = { items, className, close };
  const view = mountView(ContextMenu, model);
  const element = model.element!;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('click', outside);
    document.removeEventListener('keydown', keyboard, true);
    view.dispose();
    if (active === close) active = undefined;
  }
  function outside(event: MouseEvent) { if (!element.contains(event.target as Node)) close(); }
  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); priorFocus?.focus(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation();
      const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>('button'));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
  }
  const bounds = element.getBoundingClientRect();
  const inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--context-menu-bottom-inset')) || 0;
  element.style.left = `${Math.max(8, Math.min(x - (alignRight ? bounds.width : 0), window.innerWidth - bounds.width - 8))}px`;
  element.style.top = `${Math.max(8, Math.min(y, window.innerHeight - inset - bounds.height - 8))}px`;
  element.addEventListener('dismiss', close);
  document.addEventListener('click', outside);
  document.addEventListener('keydown', keyboard, true);
  active = close;
  return close;
}
