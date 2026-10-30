'use strict';

// Run only in an isolated VS Code test profile and temporary workspace.
const assert = require('node:assert/strict');
const vscode = require('vscode');

exports.run = async () => {
  const extension = vscode.extensions.getExtension('kleinicke.tiff-visualizer');
  assert.ok(extension);
  await extension.activate();
  const config = () => vscode.workspace.getConfiguration('tiffVisualizer');
  const toggle = () => vscode.commands.executeCommand('tiffVisualizer.toggleScrollToZoom');
  const key = 'scrollToZoom';
  const before = config().inspect(key);
  try {
    await config().update(key, undefined, vscode.ConfigurationTarget.Workspace);
    await config().update(key, false, vscode.ConfigurationTarget.Global);
    await toggle();
    assert.equal(config().get(key), true);
    assert.equal(config().inspect(key).globalValue, true);
    assert.equal(config().inspect(key).workspaceValue, undefined);
    await toggle();
    assert.equal(config().get(key), false);
    await config().update(key, true, vscode.ConfigurationTarget.Workspace);
    await toggle();
    assert.equal(config().get(key), false);
    assert.equal(config().inspect(key).workspaceValue, false);
    assert.equal(config().inspect(key).globalValue, false);
    await toggle();
    assert.equal(config().inspect(key).workspaceValue, true);
    assert.equal(config().inspect(key).globalValue, false);
    console.log('Scroll-to-zoom command: user and workspace toggles passed in VS Code.');
  } finally {
    await config().update(key, before.workspaceValue, vscode.ConfigurationTarget.Workspace);
    await config().update(key, before.globalValue, vscode.ConfigurationTarget.Global);
  }
};
