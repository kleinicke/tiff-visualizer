const { buildSync } = require('esbuild');
const path = require('path');

/** Bundle the production source in memory; stub only the unavailable IDE API. */
exports.loadSource = function loadSource(relativePath) {
  const result = buildSync({
    entryPoints: [path.resolve(__dirname, '../..', relativePath)],
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['vscode'],
  });
  const vscode = {
    EventEmitter: class {
      listeners = new Set();
      event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
      fire(value) { for (const listener of this.listeners) listener(value); }
      dispose() { this.listeners.clear(); }
    },
    commands: { executeCommand() {} },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(
    name => name === 'vscode' ? vscode : require(name), module, module.exports,
  );
  return module.exports;
};
