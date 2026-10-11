const { deflateRawSync, crc32 } = require('node:zlib');
const { buildNpy, buildNpyRaw } = require('./decoder-cases');

function npy(shape, { dtype = '<f4', fortran = false, version = 1, value = i => i } = {}) {
  const count = shape.reduce((a, b) => a * b, 1);
  const size = Number(dtype.slice(2));
  const payload = Buffer.alloc(count * size);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let flat = 0; flat < count; flat++) {
    let n = flat;
    const coords = Array(shape.length).fill(0);
    for (let a = shape.length - 1; a >= 0; a--) { coords[a] = n % shape[a]; n = Math.floor(n / shape[a]); }
    let stored = flat;
    if (fortran) {
      stored = 0; let stride = 1;
      for (let a = 0; a < shape.length; a++) { stored += coords[a] * stride; stride *= shape[a]; }
    }
    const v = value(flat, coords);
    const little = dtype[0] !== '>';
    if (dtype.endsWith('f4')) view.setFloat32(stored * size, v, little);
    else if (dtype.endsWith('f8')) view.setFloat64(stored * size, v, little);
    else if (dtype.endsWith('u2')) view.setUint16(stored * size, v, little);
    else view.setUint8(stored * size, v);
  }
  return buildNpyRaw(`{'descr': '${dtype}', 'fortran_order': ${fortran ? 'True' : 'False'}, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`, version, payload);
}

function npz(entries, { compressed = false, descriptor = false, zip64 = false } = {}) {
  const parts = [], central = [];
  let offset = 0;
  for (const [key, data] of entries) {
    const name = Buffer.from(`${key}.npy`);
    const payload = compressed ? deflateRawSync(data) : data;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(descriptor ? 8 : 0, 6); local.writeUInt16LE(compressed ? 8 : 0, 8);
    local.writeUInt32LE(descriptor ? 0 : checksum, 14);
    local.writeUInt32LE(zip64 ? 0xffffffff : descriptor ? 0 : payload.length, 18);
    local.writeUInt32LE(zip64 ? 0xffffffff : descriptor ? 0 : data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const extra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) { extra.writeUInt16LE(1); extra.writeUInt16LE(24, 2); extra.writeBigUInt64LE(BigInt(data.length), 4); extra.writeBigUInt64LE(BigInt(payload.length), 12); extra.writeBigUInt64LE(BigInt(offset), 20); }
    local.writeUInt16LE(extra.length, 28);
    const desc = descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (descriptor) { desc.writeUInt32LE(0x08074b50); desc.writeUInt32LE(checksum, 4); desc.writeUInt32LE(payload.length, 8); desc.writeUInt32LE(data.length, 12); }
    parts.push(local, name, extra, payload, desc);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(45, 4); dir.writeUInt16LE(45, 6);
    dir.writeUInt16LE(descriptor ? 8 : 0, 8); dir.writeUInt16LE(compressed ? 8 : 0, 10);
    dir.writeUInt32LE(checksum, 16); dir.writeUInt32LE(zip64 ? 0xffffffff : payload.length, 20); dir.writeUInt32LE(zip64 ? 0xffffffff : data.length, 24);
    dir.writeUInt16LE(name.length, 28); dir.writeUInt16LE(extra.length, 30); dir.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    central.push(dir, name, extra);
    offset += local.length + name.length + extra.length + payload.length + desc.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

function researchEntries(height = 5, width = 6) {
  return [
    ['K', npy([3, 3])],
    ['prediction8_m', npy([3, height, width], { value: (i, c) => c[0] * 100 + c[1] + c[2] / 8 })],
    ['prediction24_m', npy([3, height, width], { value: (i, c) => c[0] * 100 + c[1] + c[2] / 8 + 0.5 })],
    ['ground_truth_m', npy([3, height, width])],
    ['rgb', npy([3, height, width, 3], { dtype: '|u1', value: (i, c) => c[0] * 60 + c[3] * 50 })],
    ['c2w', npy([3, 4, 4])],
    ['view_ids', npy([3], { dtype: '|u1', value: i => i + 8 })],
    ['notes', buildNpy('|O8', [1], Buffer.alloc(8))],
  ];
}
module.exports = { npy, npz, researchEntries };
