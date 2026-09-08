import { on } from 'svelte/events';

/** Isolate controls from image gestures, and release panel drags on blur/disposal. */
export function panelGestures(node: HTMLElement, options: string | { headerClass: string; onDragEnd: () => void }) {
  const headerClass = typeof options === 'string' ? options : options.headerClass;
  const stop = (event: Event) => event.stopPropagation();
  const events = ['mousedown', 'click', 'dblclick', 'wheel', 'contextmenu'];
  // Svelte's event helper runs delegated child handlers before isolation.
  const removeListeners = events.map(type => on(node, type, stop));
  let cleanupDrag = () => {};
  const start = (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    if (event.button !== 0 || !target.closest(`.${headerClass}`) || target.closest('button, input, select, label')) return;
    cleanupDrag();
    const rect = node.getBoundingClientRect();
    const dx = event.clientX - rect.left, dy = event.clientY - rect.top;
    const move = (e: MouseEvent) => {
      node.style.left = `${Math.max(0, Math.min(e.clientX - dx, innerWidth - node.offsetWidth))}px`;
      node.style.top = `${Math.max(0, Math.min(e.clientY - dy, innerHeight - node.offsetHeight))}px`;
      node.style.right = 'auto'; node.style.bottom = 'auto';
    };
    cleanupDrag = () => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', cleanupDrag, true);
      window.removeEventListener('blur', cleanupDrag);
      if (typeof options !== 'string') options.onDragEnd();
      cleanupDrag = () => {};
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', cleanupDrag, true);
    window.addEventListener('blur', cleanupDrag);
    event.preventDefault();
  };
  node.addEventListener('mousedown', start);
  return { destroy() { cleanupDrag(); node.removeEventListener('mousedown', start); for (const remove of removeListeners) remove(); } };
}
