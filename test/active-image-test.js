const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const moduleUrl = name => pathToFileURL(path.resolve('out/media/modules', `${name}.js`)).href;

async function main() {
  const { imageRaster, imageLayer } = await import(moduleUrl('active-image'));
  const data = new Float32Array([-2, NaN, Infinity, 0.5]);
  const raw = { data, width: 2, height: 2, channels: 1 };
  const raster = imageRaster(raw, { isFloat: true, typeMax: 65535, sourceNumericType: 'int16' });
  assert.equal(raster.data, data, 'no pixel copy');
  assert.equal(raster.sourceNumericType, 'int16', 'source type remains separate from its float carrier');
  const layer = imageLayer({ raster, readPixel: () => '', pixelDisplay: 'float' }, 'source', 'file://source');
  assert.equal(layer.data, data);
  assert.ok(Number.isNaN(layer.data[1]));
  assert.equal(layer.data[2], Infinity);
  assert.equal(imageLayer({ raster: null }, 'streamed', 'url'), null);

  for (const [file, name, extra] of [
    ['pfm', 'PfmProcessor', {}], ['hdr', 'HdrProcessor', {}],
    ['npy', 'NpyProcessor', { dtype: '<i2' }], ['ppm', 'PpmProcessor', { maxval: 1023 }],
    ['png', 'PngProcessor', { bitDepth: 16, maxValue: 65535 }],
  ]) {
    const module = await import(moduleUrl(`${file}-processor`));
    const processor = Object.create(module[name].prototype);
    processor._lastRaw = { ...raw, ...extra };
    processor._decodedStats = { min: -2, max: 0.5 };
    const snapshot = processor.captureDecoded();
    assert.ok(snapshot, `${file}: supports decoded snapshots`);
    processor._lastRaw = null;
    processor._decodedStats = { min: 100, max: 200 };
    snapshot.restore();
    assert.equal(processor.activeImage.raster.data, data, `${file}: restores exact source buffer`);
    if (['pfm', 'npy', 'ppm'].includes(file)) assert.equal(processor._decodedStats.min, -2, `${file}: statistics follow the cached pixels`);
    assert.equal(processor._isInitialLoad, true);
    assert.ok(processor._pendingRenderData, `${file}: restores deferred-render input`);
  }
  const { ScientificArrayProcessor } = await import(moduleUrl('scientific-array-processor'));
  const scientific = Object.create(ScientificArrayProcessor.prototype);
  scientific.config = { workerFormat: 'dicom' };
  scientific._lastRaw = raw;
  scientific.metadata = { frameIndex: 3 };
  scientific.numericDomain = { typeMax: 4095, sourceNumericType: 'int16' };
  const snapshot = scientific.captureDecoded();
  scientific.metadata = {}; scientific._lastRaw = null;
  scientific.numericDomain = { typeMax: 1, sourceNumericType: 'float32' };
  snapshot.restore();
  assert.equal(scientific.metadata.frameIndex, 3);
  assert.equal(scientific.activeImage.raster.typeMax, 4095);

  const { TiffProcessor } = await import(moduleUrl('tiff-processor'));
  const tiff = Object.create(TiffProcessor.prototype);
  Object.assign(tiff, { rawTiffData: { data, image: { getWidth: () => 2, getHeight: () => 2 }, rasters: [data], ifd: { width: 2, height: 2, t258: 16, t339: 2, t277: 1 } },
    _lastAllTags: [{ tag: 42113, value: '-2' }], _gdalNodata: -2, _extraSamplesAreAlpha: false,
    _sourceBuffer: new ArrayBuffer(12), _sourceBufferSrc: 'first.tif', _regionSourceGeneration: 0,
    _regionSampleCache: new Map(), _regionSampleCacheBytes: 0,
  });
  const renderOptions = { collectHistogram: true, targetCanvas: {}, placeholderImageData: {} };
  const rendered = {};
  tiff.renderTiffWithSettings = async (image, rasters, options) => {
    assert.equal(image, tiff.rawTiffData.image);
    assert.equal(rasters, tiff.rawTiffData.rasters);
    assert.equal(options, renderOptions, 'TIFF must forward canvas and histogram options');
    return rendered;
  };
  assert.equal(await tiff.renderWithSettings(renderOptions), rendered);

  const { ExrProcessor } = await import(moduleUrl('exr-processor'));
  const exr = Object.create(ExrProcessor.prototype);
  exr.settingsManager = { settings: {} };
  exr.rawExrData = { width: 2, height: 2 };
  exr.renderExrToCanvas = (settings, options) => {
    assert.equal(settings, exr.settingsManager.settings);
    assert.equal(options, renderOptions, 'EXR must forward options on initial and subsequent renders');
    return rendered;
  };
  exr._pendingRenderData = {}; exr._isInitialLoad = true;
  assert.equal(exr.renderWithSettings(renderOptions), rendered);
  assert.equal(exr._pendingRenderData, null);
  assert.equal(exr.renderWithSettings(renderOptions), rendered);

  const tiffSnapshot = tiff.captureDecoded();
  tiff._gdalNodata = 99; tiff._lastAllTags = []; tiff._sourceBufferSrc = 'second.tif';
  tiff.rawTiffData = null; tiff._regionSampleCache.set('stale', {});
  tiffSnapshot.restore();
  assert.equal(tiff.activeImage.raster.data, data);
  assert.equal(tiff._gdalNodata, -2, 'no-data meaning belongs to the cached source');
  assert.equal(tiff._lastAllTags[0].tag, 42113);
  assert.equal(tiff._sourceBufferSrc, 'first.tif', 'region reads must not use the next file');
  assert.equal(tiff._regionSampleCache.size, 0, 'old viewport samples cannot survive restoration');

  global.window = { addEventListener() {} };
  global.document = { body: { classList: { add() {}, remove() {} } } };
  const { MouseHandler } = await import(moduleUrl('mouse-handler'));
  let image = { raster, pixelDisplay: 'float', readPixel: () => '0.25 0.5 1 α:0.3' };
  const picker = new MouseHandler({ isMac: false, settings: {
    normalization: { gammaMode: true }, colorPickerShowModified: true,
    gamma: { in: 1, out: 1 }, brightness: { offset: 1 },
  } }, { postMessage() {} }, () => image);
  assert.equal(picker._getColorAtPixel(0, 0, 1, 1), '0.500000 1.000000 2.000000 α:0.300000');
  image = { ...image, pixelDisplay: 'byte', readPixel: () => '064 128 255 α:0.50' };
  assert.equal(picker._getColorAtPixel(0, 0, 1, 1), '128 255 255 α:0.50');
  image = { ...image, pixelDisplay: 'native', readPixel: () => 'new image' };
  assert.equal(picker._getColorAtPixel(0, 0, 1, 1), 'new image', 'switching replaces the source without stale processor probing');
  console.log('Active image: source domains, zero-copy layers, cache restoration and pixel inspection passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
