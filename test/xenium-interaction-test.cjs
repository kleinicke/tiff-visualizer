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
  console.log('Shared wheel policy and Xenium configuration delivery passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
