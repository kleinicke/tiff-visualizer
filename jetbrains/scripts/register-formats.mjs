import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function extensions(pkg) {
  return [...new Set(pkg.contributes.customEditors.flatMap(editor => editor.selector.flatMap(({filenamePattern: p}) => {
    if (!/^\*\.(?:\{[\w,]+\}|\w+)$/.test(p)) throw new Error(`Unsupported selector ${p}`);
    return p.slice(2).replace(/[{}]/g, '').toLowerCase().split(',');
  })))].sort();
}
const image = extensions(JSON.parse(await readFile(path.join(root, '../package.json'), 'utf8')));
const data = `image=${image.join(',')}\n`;
const target = path.join(root, 'src/main/resources/formats.properties');
const xmlPath = path.join(root, 'src/main/resources/META-INF/plugin.xml');
let xml = await readFile(xmlPath, 'utf8');
// Common IDE types retain their identity and original editor. Our provider still accepts them.
const native = new Set(['png','jpeg','jpg','bmp','ico','webp','avif','tif','tiff']);
const registrations = `<!-- generated file types -->\n    <fileType name="Scientific Image" implementationClass="de.kleinicke.visualizer.ScientificImageFileType" fieldName="INSTANCE" extensions="${image.filter(e => !native.has(e)).join(';')}"/>\n    <!-- end generated file types -->`;
xml = xml.replace(/<!-- generated file types -->[\s\S]*?<!-- end generated file types -->/, registrations);
const manifest = JSON.stringify({image}, null, 2) + '\n';
for (const [file, value] of [[target, data], [xmlPath, xml], [path.join(root,'formats.json'), manifest]]) {
  if (process.argv.includes('--check')) {
    if (await readFile(file,'utf8') !== value) throw new Error(`Stale format registration: ${file}`);
  } else await writeFile(file, value);
}
console.log(`Registered ${image.length} image suffixes.`);
