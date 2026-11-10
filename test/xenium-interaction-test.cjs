const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const { URI, Utils } = require('vscode-uri');
function load(file, vscode) {
  const result = buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
  const loaded = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(loaded, loaded.exports, name => name === 'vscode' ? vscode : require(name));
  return loaded.exports;
}
(async () => {
  const { wheelShouldZoom, wheelZoomFactor, wheelDeltaPixels } = load('media/modules/zoom-interaction.ts');
  const wheel = { altKey: false, ctrlKey: false, deltaY: -10, deltaMode: 0 };
  for (const isMac of [false, true]) {
    assert.equal(wheelShouldZoom(wheel, false, isMac), false);
    assert.equal(wheelShouldZoom(wheel, true, isMac), true);
    assert.equal(wheelShouldZoom({ ...wheel, ctrlKey: true }, false, isMac), true);
    assert.equal(wheelShouldZoom({ ...wheel, altKey: true }, false, isMac), isMac);
  }
  assert.equal(wheelDeltaPixels(2, 1, 600), 32);
  assert.equal(wheelDeltaPixels(2, 2, 600), 1200);
  assert.equal(wheelZoomFactor(wheel, 600, false), 1.075);
  assert.equal(wheelZoomFactor({ ...wheel, deltaY: 0 }, 600, true), 1);
  assert.equal(wheelZoomFactor(wheel, 600, true), Math.exp(0.025));

  let enabled = false, watcher, disposed = false, onDispose;
  const messages = [];
  const vscode = {
    Uri: { joinPath: Utils.joinPath },
    workspace: {
      workspaceFolders: [],
      getConfiguration: section => ({ get: (key, fallback) => section === 'tiffVisualizer' && key === 'scrollToZoom' ? enabled : fallback }),
      onDidChangeConfiguration: callback => { watcher = callback; return { dispose() { disposed = true; } }; },
    },
  };
  const { XeniumEditorProvider } = load('src/xenium/xeniumEditor.ts', vscode);
  const panel = {
    webview: { cspSource: 'test-resource:', asWebviewUri: uri => uri, postMessage: message => { messages.push(message); }, onDidReceiveMessage() {} },
    onDidDispose: callback => { onDispose = callback; },
  };
  await new XeniumEditorProvider(URI.file('/extension')).resolveCustomEditor({ uri: URI.file('/sample/experiment.xenium') }, panel);
  assert.match(panel.webview.html, /scrollToZoom&quot;:false/, 'initial page gets the default-off setting');
  for (const next of [true, false]) {
    enabled = next;
    watcher({ affectsConfiguration: name => name === 'tiffVisualizer.scrollToZoom' });
    assert.equal(messages.at(-1).type, 'settings');
    assert.equal(messages.at(-1).scrollToZoom, next, 'configuration changes reach an open viewer');
  }
  enabled = true;
  await new XeniumEditorProvider(URI.file('/extension')).resolveCustomEditor({ uri: URI.file('/sample/experiment.xenium') }, panel);
  assert.match(panel.webview.html, /scrollToZoom&quot;:true/, 'a newly opened viewer gets the current setting');
  onDispose();
  assert.equal(disposed, true);
  const events = [];
  let shown = true, listener, sessionDisposed = false, registered, received, disposeScalePanel;
  const registry = {
    settingsManager: {
      getShowScaleBar: () => shown,
      toggleScaleBar: () => { shown = !shown; listener(); return shown; },
      onDidChangeSettings: callback => { listener = callback; return { dispose() { sessionDisposed = true; } }; },
    },
    registerViewer: (target, registeredPanel) => { registered = { target, registeredPanel }; },
  };
  const scalePanel = {
    webview: { cspSource: 'test-resource:', asWebviewUri: uri => uri, postMessage: message => { events.push(message); }, onDidReceiveMessage: callback => { received = callback; } },
    onDidDispose: callback => { disposeScalePanel = callback; },
  };
  await new XeniumEditorProvider(URI.file('/extension'), registry).resolveCustomEditor({ uri: URI.file('/sample/experiment.xenium') }, scalePanel);
  assert.match(scalePanel.webview.html, /showScaleBar&quot;:true/, 'a new viewer starts from the session scale bar setting');
  assert.equal(registered.registeredPanel, scalePanel, 'the viewer registers itself as a command target');
  registered.target.toggleScaleBar();
  assert.equal(events.at(-1).type, 'settings');
  assert.equal(events.at(-1).showScaleBar, false, 'a session change reaches the open viewer');
  await received({ type: 'executeCommand', command: 'tiffVisualizer.toggleScaleBar' });
  assert.equal(events.at(-1).showScaleBar, true, 'the viewer menu toggles the same session setting');
  const before = events.length;
  await received({ type: 'executeCommand', command: 'workbench.action.closeWindow' });
  assert.equal(events.length, before, 'the webview cannot run other commands through this message');
  disposeScalePanel();
  assert.equal(sessionDisposed, true, 'the session listener is released with the panel');
  console.log('Shared wheel policy, Xenium configuration delivery and scale bar routing passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
