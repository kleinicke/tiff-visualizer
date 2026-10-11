const assert = require('node:assert/strict');
const fs = require('node:fs');
const { npy, npz, researchEntries } = require('./lib/numpy-dataset-fixtures.cjs');

(async () => {
  const wasm = await import('../media/wasm/tiff-wasm.js');
  await wasm.default({ module_or_path: fs.readFileSync('media/wasm/tiff-wasm.wasm') });
  function decoded(dataset, indices = {}) {
    const r = dataset.decode(JSON.stringify({ indices }));
    const image = { width: r.width, height: r.height, channels: r.channels, metadata: JSON.parse(r.metadata_json), min: r.data_min, max: r.data_max, kind: r.sample_kind };
    image.data = r.sample_kind === 1 ? r.take_data_as_u8() : r.sample_kind === 2 ? r.take_data_as_u16() : r.take_data_as_f32();
    r.free();
    return image;
  }
  for (const compressed of [false, true]) for (const descriptor of [false, true]) for (const zip64 of [false, true]) {
    const dataset = new wasm.NumpyDataset(npz(researchEntries(), { compressed, descriptor, zip64 }));
    try {
      const first = decoded(dataset);
      assert.equal(first.metadata.array, 'prediction8_m');
      assert.deepEqual([first.width, first.height, first.channels], [6, 5, 1]);
      assert.equal(first.metadata.arrays.length, 8);
      assert.match(first.metadata.arrays[7].unavailable, /dtype/);
      assert.deepEqual(first.metadata.selectors.map(s => s.name), ['Array', 'Layout', 'Axis 0']);
      for (const view of [2, 0, 1, 2]) {
        const result = decoded(dataset, { Array: 1, 'Axis 0': view });
        assert.deepEqual(Array.from(result.data), Array.from({ length: 30 }, (_, i) => view * 100 + Math.floor(i / 6) + (i % 6) / 8));
        assert.equal(result.min, view * 100); assert.equal(result.max, view * 100 + 4 + 5 / 8);
      }
      const rgb = decoded(dataset, { Array: 4, 'Axis 0': 2 });
      assert.deepEqual([rgb.width, rgb.height, rgb.channels, rgb.kind], [6, 5, 3, 1]);
      assert.deepEqual(Array.from(rgb.data.slice(0, 6)), [120, 170, 220, 120, 170, 220]);
      const ids = decoded(dataset, { Array: 6 });
      assert.deepEqual([ids.width, ids.height, ...ids.data], [3, 1, 8, 9, 10]);
    } finally { dataset.free(); }
  }
  for (const fortran of [false, true]) for (const dtype of ['<f4', '>f4', '<f8', '>f8', '|u1', '<u2', '>u2']) {
    const source = npy([2, 3, 5, 6], { fortran, dtype, value: (_, c) => c[0] * 60 + c[1] * 15 + c[2] * 2 + c[3] });
    const dataset = new wasm.NumpyDataset(source);
    try {
      const result = decoded(dataset, { 'Axis 0': 1, Layout: 1 }); // Channels first (N,C,H,W)
      assert.deepEqual([result.width, result.height, result.channels], [6, 5, 3]);
      const expected = [];
      for (let y = 0; y < 5; y++) for (let x = 0; x < 6; x++) for (let c = 0; c < 3; c++) expected.push(60 + c * 15 + y * 2 + x);
      assert.deepEqual(Array.from(result.data), expected, `${dtype}, Fortran=${fortran}`);
    } finally { dataset.free(); }
  }
  for (const shape of [[], [5], [5, 6], [2, 5, 6], [2, 5, 6, 3]]) {
    const dataset = new wasm.NumpyDataset(npy(shape, { version: 3 }));
    const result = decoded(dataset); assert.ok(result.data.length > 0); dataset.free();
  }
  const boolean = new wasm.NumpyDataset(npy([1, 5], { dtype: '|b1', value: i => i % 2 }));
  const boolImage = decoded(boolean); assert.equal(boolImage.metadata.dtype, '|b1'); assert.deepEqual(Array.from(boolImage.data), [0, 1, 0, 1, 0]); boolean.free();
  const special = new wasm.NumpyDataset(npy([1, 5], { value: i => [NaN, Infinity, -Infinity, -0, 1.25][i] }));
  const values = decoded(special).data;
  assert.ok(Number.isNaN(values[0])); assert.equal(values[1], Infinity); assert.equal(values[2], -Infinity); assert.ok(Object.is(values[3], -0)); assert.equal(values[4], 1.25); special.free();
  assert.throws(() => new wasm.NumpyDataset(Buffer.from('broken')), /directory/);
  const truncated = new wasm.NumpyDataset(npy([5, 6]).subarray(0, 130));
  assert.throws(() => decoded(truncated), /Truncated/); truncated.free();
  const empty = new wasm.NumpyDataset(npy([0, 5])); assert.throws(() => decoded(empty), /No supported/); empty.free();
  console.log('NumPy dataset: archive choices, cached planes, Deflate, ZIP64, descriptors, NCHW, Fortran, endian, dtypes, scalar/vector, non-finite and invalid inputs passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
