const assert = require('assert');
const fs = require('fs');
const { buildSync } = require('esbuild');

const bundle = buildSync({
  entryPoints: ['web/browser-dataset.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const loaded = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(loaded, loaded.exports, require);
const { createDicomFrameDataset, createOmeDataset, findDatasetPlane } = loaded.exports;

const dicom = createDicomFrameDataset({ name: 'volume.dcm', url: 'blob:volume' }, 3);
assert.ok(dicom, 'multi-frame DICOM should create a browser dataset');
assert.equal(dicom.series[0].planes.length, 3);
assert.deepEqual(dicom.series[0].planes.map(plane => plane.frameIndex), [0, 1, 2]);
assert.equal(findDatasetPlane(dicom, 0, { frame: 2 }).plane.frameIndex, 2);
assert.equal(createDicomFrameDataset({ name: 'single.dcm', url: 'blob:single' }, 1), null);

const ome = createOmeDataset({
  uuid: 'dataset-1',
  currentPageIndex: 0,
  series: [{
    imageId: 'Image:0',
    imageName: 'Z stack',
    sizeC: 1,
    sizeZ: 2,
    sizeT: 1,
    planes: [
      { fileName: 'z0.tif', c: 0, z: 0, t: 0, ifd: 0 },
      { fileName: 'z1.tif', c: 0, z: 1, t: 0, ifd: 0 },
    ],
  }],
}, [
  { name: 'z0.tif', url: 'blob:z0' },
  { name: 'z1.tif', url: 'blob:z1' },
], { name: 'z0.tif', url: 'blob:z0' });
assert.ok(ome, 'selected OME files should create a browser dataset');
assert.equal(findDatasetPlane(ome.manifest, 0, { c: 0, z: 1, t: 0 }).plane.src, 'blob:z1');

const html = fs.readFileSync('web/index.html', 'utf8');
const css = fs.readFileSync('web/website.css', 'utf8');
const host = fs.readFileSync('web/browser-host.ts', 'utf8');
assert.match(html, /class="web-drop-zone"/, 'the empty state should be centered on a large drop target');
assert.doesNotMatch(html, /data-web-action="close-control"/, 'display popovers should not need a close button');
assert.match(css, /> canvas:not\(\.scale-to-fit\)[\s\S]*?max-height: none !important/, 'zoomed canvases must not retain fit-mode height limits');
assert.match(css, /\.web-app \.dataset-overlay \{ top: 58px; \}/, 'dataset navigation should sit below the website toolbar');
assert.match(host, /!controlPopover\.contains\(target as Node\)/, 'display popovers should close after an outside click');

console.log('Browser dataset host tests passed');
