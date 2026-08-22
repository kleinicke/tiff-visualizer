const assert = require('assert');
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

console.log('Browser dataset host tests passed');
