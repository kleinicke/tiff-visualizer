// Shared by the production build and the web-extension compatibility test.
module.exports = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.web.js',
  platform: 'browser',
  target: 'es2020',
  external: ['vscode'],
  alias: { path: 'path-browserify' },
  // Removes the guarded Node filesystem fast path; webviews fetch source bytes.
  define: { process: 'undefined' },
  minifySyntax: true,
  sourcemap: true,
  // VS Code's worker host loads CommonJS and calls its exported activate().
  format: 'cjs',
};
