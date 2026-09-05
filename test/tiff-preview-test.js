/** Bounded large-TIFF preview and exact full-resolution picker regression. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// A >128 MP file with small independent strips, partial final strip, and NaN.
// Generated a strip at a time; no full-size reference raster is allocated.
function fixture() {
 const width = 8193, height = 15625, rows = 32;
 const value = (x, y) => x === 0 && y === 0 ? NaN : x - y;
 const strips = [];
 for (let y = 0; y < height; y += rows) {
  const data = Buffer.alloc(width * Math.min(rows, height - y) * 4);
  for (let row = 0; row < Math.min(rows, height - y); row++) {
   for (let x = 0; x < width; x++) data.writeFloatLE(value(x, y + row), (row * width + x) * 4);
  }
  strips.push(zlib.deflateSync(data));
 }
 const entries = 10, tableEnd = 8 + 2 + entries * 12 + 4;
 const offsetsAt = tableEnd, countsAt = offsetsAt + strips.length * 4;
 const head = Buffer.alloc(countsAt + strips.length * 4);
 head.write('II'); head.writeUInt16LE(42, 2); head.writeUInt32LE(8, 4); head.writeUInt16LE(entries, 8);
 let at = 10;
 for (const [tag, type, count, val] of [
  [256,4,1,width],[257,4,1,height],[258,3,1,32],[259,3,1,8],[262,3,1,1],
  [273,4,strips.length,offsetsAt],[277,3,1,1],[278,4,1,rows],
  [279,4,strips.length,countsAt],[339,3,1,3],
 ]) {
  head.writeUInt16LE(tag, at); head.writeUInt16LE(type, at+2);
  head.writeUInt32LE(count, at+4); head.writeUInt32LE(val, at+8); at += 12;
 }
 let offset = head.length;
 strips.forEach((strip, i) => {
  head.writeUInt32LE(offset, offsetsAt+i*4); head.writeUInt32LE(strip.length, countsAt+i*4); offset += strip.length;
 });
 return { bytes: Buffer.concat([head,...strips]), width, height, value };
}

async function main() {
 const wasm = await import('../media/wasm/tiff-wasm.js');
 await wasm.default({ module_or_path: fs.readFileSync(path.join(__dirname, '../media/wasm/tiff-wasm.wasm')) });
 const input = fixture();
 // Header-only routing checks: 128 MP itself stays on the normal path.
 const smaller = Buffer.from(input.bytes);
 smaller.writeUInt32LE(8192, 18);
 assert.equal(wasm.tiff_preview_reduction(smaller), 0);
 smaller.writeUInt32LE(6400, 18); // 100 MP at the same height
 assert.equal(wasm.tiff_preview_reduction(smaller), 0);
 const reduction = wasm.tiff_preview_reduction(input.bytes);
 assert.ok(reduction > 1);
 const preview = wasm.decode_tiff_preview(input.bytes);
 assert.equal(preview.width, Math.ceil(input.width/reduction));
 assert.equal(preview.height, Math.ceil(input.height/reduction));
 assert.equal(preview.min_value, -(input.height-1));
 assert.equal(preview.max_value, input.width-1);
 const width = preview.width, height = preview.height;
 const pixels = preview.take_data_as_f32();
 for (let y=0; y<height; y++) for (let x=0; x<width; x++) {
  assert.equal(pixels[y*width+x], input.value(x*reduction,y*reduction));
 }
 const directory=JSON.parse(preview.page_directory_json);
 assert.equal(directory[0].width,input.width);
 assert.equal(directory[1].generated,true);
 assert.equal(directory[1].parent,0);
 preview.free();
 const decoder = new wasm.TiffRegionDecoder(input.bytes);
 for (const [x,y] of [[0,0],[321,31],[322,32],[input.width-1,input.height-1]]) {
  const pixel=decoder.decode(0,x,y,1,1);
  assert.equal(pixel.blocks_decoded,1);
  assert.equal(pixel.take_data_as_f32()[0],input.value(x,y));
  pixel.free();
 }
 decoder.free();
 console.log('✅ Every preview sample matches its original coordinate; exact min/max, NaN, partial strips, and full-resolution picker reads pass');
 // Optional user file: compare independent geotiff.js region reads with WASM.
 if (process.env.TIFF_LARGE_SAMPLE) {
  const file=process.env.TIFF_LARGE_SAMPLE;
  const bytes=fs.readFileSync(file);
  const {fromFile}=await import('geotiff');
  const tiff=await fromFile(file); const image=await tiff.getImage();
  const result=wasm.decode_tiff_preview(bytes); const step=wasm.tiff_preview_reduction(bytes);
  const w=result.width; const data=result.take_data_as_f32();
  const regions=new wasm.TiffRegionDecoder(bytes);
  for(const [x,y] of [[0,0],[10000,10000],[10003,10007],[image.getWidth()-1,image.getHeight()-1]]) {
   const reference=await image.readRasters({window:[x,y,x+1,y+1]});
   const decoded=regions.decode(0,x,y,1,1);
   assert.equal(decoded.take_data_as_f32()[0],reference[0][0]); decoded.free();
   const px=Math.floor(x/step),py=Math.floor(y/step);
   const sampled=await image.readRasters({window:[px*step,py*step,px*step+1,py*step+1]});
   assert.equal(data[py*w+px],sampled[0][0]);
  }
  console.log(`✅ ${path.basename(file)}: ${image.getWidth()}×${image.getHeight()} → ${w}×${result.height}; original picker values match geotiff.js`);
  regions.free();result.free();await tiff.close();
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
