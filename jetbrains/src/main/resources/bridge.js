// One latest-state update per frame, with no polling or per-pixel native queue.
window.jetbrainsConnectStatus = receiver => {
  window.jetbrainsDisconnectStatus?.();
  let frame = 0, last = '';
  const publish = () => {
    frame = 0;
    const host = window.scientificImageHost;
    if (!host) return;
    const json = JSON.stringify(host.snapshot());
    if (json !== last) { last = json; receiver(json); }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(publish); };
  window.addEventListener('scientific-image-state', schedule);
  window.jetbrainsDisconnectStatus = () => {
    window.removeEventListener('scientific-image-state', schedule);
    cancelAnimationFrame(frame);
  };
  publish();
};

// Preserve small native wheel deltas instead of waiting in JCEF's OSR accumulator.
// Custom image/panel wheel handlers still run; only unhandled default scrolling
// is performed here because synthetic DOM wheel events have no default action.
const panRemainders = new WeakMap();
window.jetbrainsPan = (xRatio, yRatio, dx, dy) => {
  if (![xRatio, yRatio, dx, dy].every(Number.isFinite)) return;
  const x = xRatio * innerWidth, y = yRatio * innerHeight;
  const target = document.elementFromPoint(x, y) || document.body;
  const event = new WheelEvent('wheel', { clientX: x, clientY: y, deltaX: dx, deltaY: dy, bubbles: true, cancelable: true });
  if (!target.dispatchEvent(event)) return;
  let scroller = target;
  while (scroller && scroller !== document.body) {
    const style = getComputedStyle(scroller);
    if ((dy && /auto|scroll/.test(style.overflowY) && scroller.scrollHeight > scroller.clientHeight)
        || (dx && /auto|scroll/.test(style.overflowX) && scroller.scrollWidth > scroller.clientWidth)) break;
    scroller = scroller.parentElement;
  }
  if (!scroller || scroller === document.body) scroller = document.scrollingElement;
  if (!scroller) return;
  const remainder = panRemainders.get(scroller) || [0, 0];
  remainder[0] += dx; remainder[1] += dy;
  const sx = Math.trunc(remainder[0]), sy = Math.trunc(remainder[1]);
  remainder[0] -= sx; remainder[1] -= sy;
  panRemainders.set(scroller, remainder);
  scroller.scrollBy({ left: sx, top: sy, behavior: 'instant' });
};

// Called by JetBrains' native ZoomableViewport magnification callbacks on macOS.
// This scales image content through its normal gesture handler, not browser chrome.
window.jetbrainsGesture = (type, scale) => {
  if (!['gesturestart', 'gesturechange', 'gestureend'].includes(type) || !Number.isFinite(scale)) return;
  if (!document.querySelector('#web-file-input')) return;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'scale', { value: scale });
  document.body.dispatchEvent(event);
};

/* Thin prototype adapter: deliver the IDE's selected file through each viewer's
 * existing file input. No decoder, renderer or privileged browser API is added. */
window.addEventListener('load', async () => {
  try {
    const input = document.querySelector('#web-file-input, #hiddenFileInput');
    if (!input) throw new Error('Viewer file input is unavailable');
    if (input.id === 'hiddenFileInput') {
      const deadline = Date.now() + 30000;
      while (document.documentElement.dataset.visualizerReady !== 'true') {
        if (Date.now() > deadline) throw new Error('3D viewer initialization timed out');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    const [source, filename] = await Promise.all([fetch('../source'), fetch('../filename')]);
    if (!source.ok || !filename.ok) throw new Error('The selected file could not be read');
    const transfer = new DataTransfer();
    transfer.items.add(new File([await source.blob()], await filename.text()));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.documentElement.dataset.jetbrainsFileDelivered = 'true';
  } catch (error) {
    const message = document.createElement('div');
    message.setAttribute('role', 'alert');
    message.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:100000;padding:12px;background:#722;color:white';
    message.textContent = `Could not open the IDE file: ${error.message}`;
    document.body.append(message);
  }
}, { once: true });
