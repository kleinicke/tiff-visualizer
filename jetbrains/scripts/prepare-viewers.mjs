import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imageRepo = path.resolve(root, '..');
const destination = path.join(root, 'build/viewer-resources/viewers');
function run(args, cwd) {
  const result = spawnSync('npm', args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Viewer build failed: ${cwd}`);
}
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
run(['run', 'web:build'], imageRepo);
await cp(path.join(imageRepo, 'web-dist'), path.join(destination, 'image'), { recursive: true });
const index = path.join(destination, 'image', 'index.html');
let html = await readFile(index, 'utf8');
html = html.replace('class="vscode-dark"', 'class="vscode-dark jetbrains-host"');
// Website analytics and installation do not belong inside an IDE editor.
html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, script => /plausible|analytics\.re4vive/.test(script) ? '' : script);
html = html.replace(/<link\b[^>]*rel="(?:manifest|canonical)"[^>]*>/gi, '');
html = html.replace(/<nav class="web-legal-nav"[^>]*>[\s\S]*?<\/nav>/, '');
html = html.replace('</head>', '<style>[data-web-action="install"]{display:none!important}</style></head>');
html = html.replace('</body>', '<script src="../bridge.js" defer></script></body>');
await writeFile(index, html);
console.log('Bundled the image viewer for JetBrains; no PLY repository required.');

await import("./collect-notices.mjs");
