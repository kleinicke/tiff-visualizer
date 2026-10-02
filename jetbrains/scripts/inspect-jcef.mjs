import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json();
let verified = 0;
for (const target of targets.filter(t => /\/image\/index.html/.test(t.url))) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const response = JSON.parse(event.data);
    const task = pending.get(response.id);
    if (task) { clearTimeout(task.timer); pending.delete(response.id); response.error ? task.reject(new Error(JSON.stringify(response.error))) : task.resolve(response.result); }
  };
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const messageId = ++id;
      const timer = setTimeout(() => { pending.delete(messageId); reject(new Error(`${method} timed out`)); }, 15000);
      pending.set(messageId, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: messageId, method, params }));
    });
  }
  try {
    const kind = 'image';
    await send('Runtime.evaluate', {
      expression: `new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const check = () => {
          const delivered = document.documentElement.dataset.jetbrainsFileDelivered === 'true';
          const loaded = [...document.querySelectorAll('canvas')].some(c => c.width > 1 && c.height > 1);
          if (delivered && loaded) return resolve(true);
          if (Date.now() > deadline) return reject(new Error('Viewer did not finish loading'));
          setTimeout(check, 50);
        };
        check();
      })`, awaitPromise: true,
    }).then(result => { if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); });
    const { result } = await send('Runtime.evaluate', {
      expression: `JSON.stringify({ delivered: document.documentElement.dataset.jetbrainsFileDelivered, canvases: [...document.querySelectorAll('canvas')].map(c => [c.width,c.height]), error: document.querySelector('[role=alert]')?.textContent })`,
      returnByValue: true,
    });
    const state = JSON.parse(result.value);
    console.log(kind, state);
    if (state.delivered !== 'true' || state.error || !state.canvases.some(([w,h]) => w > 1 && h > 1)) throw new Error(`${kind} did not render`);
    if (kind === 'image') {
      const readZoom = async () => (await send('Runtime.evaluate', { expression: "document.getElementById('web-status-zoom').textContent", returnByValue: true })).result.value;
      const before = await readZoom();
      // Modifier is carried on the wheel event, without any preceding keydown.
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 350, deltaX: 0, deltaY: -100, modifiers: 1 });
      await send('Runtime.evaluate', { expression: 'new Promise(r => setTimeout(r, 250))', awaitPromise: true });
      if (await readZoom() === before) throw new Error('Option-wheel did not zoom the image');
      const pinchBefore = await readZoom();
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 350, deltaX: 0, deltaY: -100, modifiers: 2 });
      await send('Runtime.evaluate', { expression: 'new Promise(r => setTimeout(r, 250))', awaitPromise: true });
      if (await readZoom() === pinchBefore) throw new Error('Ctrl-wheel/pinch event did not zoom');
      // Small IDE zoom steps need not overflow the viewport yet. Set an explicit
      // oversized scale before testing panning, independent of zoom sensitivity.
      await send('Runtime.evaluate', { expression: "window.scientificImageHost.adjust('zoom', [2]); new Promise(r => setTimeout(r, 250))", awaitPromise: true });
      await send('Runtime.evaluate', { expression: 'scrollTo(0, 0)' });
      const scrollBefore = (await send('Runtime.evaluate', {expression: 'scrollY', returnByValue:true})).result.value;
      await send('Input.dispatchMouseEvent', {type:'mouseWheel',x:400,y:350,deltaX:0,deltaY:200});
      await send('Runtime.evaluate', {expression:'new Promise(r => setTimeout(r, 250))',awaitPromise:true});
      const scrollAfter = (await send('Runtime.evaluate', {expression:'scrollY',returnByValue:true})).result.value;
      if (scrollAfter === scrollBefore) throw new Error('Unmodified scroll did not pan the zoomed image');
      console.log('Image responds to Option-wheel, pinch-style wheel and scroll panning in JCEF.');
    }
    const screenshot = await send('Page.captureScreenshot');
    await writeFile(path.join(root, `build/pycharm-${kind}.png`), Buffer.from(screenshot.data, 'base64'));
    verified++;
  } finally { socket.close(); }
}
if (verified < 1) throw new Error(`Expected an image JCEF editor, found ${verified}`);
console.log('Actual PyCharm/JCEF image editors rendered successfully.');
