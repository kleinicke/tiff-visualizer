import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imageRepo = path.resolve(root, '..');
const plyRepo = process.env.PLY_VISUALIZER_ROOT || path.resolve(imageRepo, '../ply-visualizer');
const destination = path.join(root, 'build/viewer-resources/viewers');
function run(args, cwd) {
  const result = spawnSync('npm', args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Viewer build failed: ${cwd}`);
}
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
run(['run', 'web:build'], imageRepo);
const plyBuild = path.join(root, 'build/ply-web');
run(['run', 'build', '--workspace=engine', '--', '--output-path', plyBuild], plyRepo);
await cp(path.join(imageRepo, 'web-dist'), path.join(destination, 'image'), { recursive: true });
await cp(plyBuild, path.join(destination, 'ply'), { recursive: true });
for (const kind of ['image', 'ply']) {
  const index = path.join(destination, kind, 'index.html');
  let html = await readFile(index, 'utf8');
  // Website analytics and installation do not belong inside an IDE editor.
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, script => /plausible|analytics\.re4vive/.test(script) ? '' : script);
  html = html.replace(/<link\b[^>]*rel="(?:manifest|canonical)"[^>]*>/gi, '');
  html = html.replace(/<nav class="web-legal-nav"[^>]*>[\s\S]*?<\/nav>/, '');
  if (kind === 'ply') html = html.replace(/<div class="bottom-right-nav">[\s\S]*?<\/div>/, '');
  html = html.replace('</head>', '<style>[data-web-action="install"]{display:none!important}</style></head>');
  html = html.replace('</body>', '<script src="../bridge.js" defer></script></body>');
  await writeFile(index, html);
}
console.log('Bundled both existing viewers for JetBrains.');
