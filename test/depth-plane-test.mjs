import assert from 'node:assert/strict';
import { encodeDepthPlane } from '../out/media/modules/depth-plane.js';
function image(data, channels = 1) { return { raster: {data, width: 2, height: 2, channels} }; }
function values(bytes) {
  assert.deepEqual([...bytes.slice(0,8)], [147,78,85,77,80,89,1,0]);
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const offset = 10 + view.getUint16(8,true);
  assert.equal(offset % 64,0);
  assert.match(new TextDecoder().decode(bytes.slice(10,offset)), /'shape': \(2, 2\)/);
  return Array.from({length:4},(_,i)=>view.getFloat64(offset+i*8,true));
}
for (const data of [new Float64Array([1.23456789012345,NaN,Infinity,-0]),new Int32Array([-1,2147483647,-2147483648,0]),new Uint32Array([0,65536,4294967295,9]),new Uint16Array([0,500,1000,65535])]) {
 assert.deepEqual(values(encodeDepthPlane(image(data))),Array.from(data));
}
assert.deepEqual(values(encodeDepthPlane({...image(new Float32Array(4)),planar:[new Float32Array([1,2,3,4])]})),[1,2,3,4]);
assert.throws(()=>encodeDepthPlane(null),/not available/);
assert.throws(()=>encodeDepthPlane(image(new Uint8Array(12),3)),/single-channel/);
assert.throws(()=>encodeDepthPlane(image(new Float32Array(3))),/incomplete/);
console.log('Depth NPY preserves raw scalar samples, precision, non-finite values and planar data; rejects RGB and incomplete sources.');
