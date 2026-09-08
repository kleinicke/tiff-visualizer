import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
const target = 'packages/python/scientific_image_visualizer/_assets';
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp('web-dist', target, { recursive: true });
// A local data viewer must never load remote analytics, even while offline.
const html = (await readFile(`${target}/index.html`, 'utf8'))
  .replace(/\s*<script[^>]*src="https:\/\/analytics\.[^>]*><\/script>/g, '')
  .replace(/\s*<script src="\.\/plausible-init\.js"><\/script>/g, '');
await writeFile(`${target}/index.html`, html);
console.log(`Packaged local viewer in ${target}`);
