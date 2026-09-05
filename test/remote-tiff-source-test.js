/** Independently exercise lazy metadata, the real codecs, memory limits and cancellation. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function largeIndexFixture() {
 const count = 1024 * 1024, offsets = 1024 * 1024, counts = 8 * 1024 * 1024, pixels = 16 * 1024 * 1024;
 const bytes = Buffer.alloc(pixels + 512 * 512 * 2);
 bytes.write('II'); bytes.writeUInt16LE(42, 2); bytes.writeUInt32LE(8, 4);
 const entries = [[256,4,1,512*1024],[257,4,1,512*1024],[258,3,1,16],[259,3,1,1],[262,3,1,1],
  [277,3,1,1],[322,4,1,512],[323,4,1,512],[324,4,count,offsets],[325,4,count,counts]];
 bytes.writeUInt16LE(entries.length,8);
 entries.forEach(([tag,type,n,value],i)=>{const at=10+i*12;bytes.writeUInt16LE(tag,at);bytes.writeUInt16LE(type,at+2);bytes.writeUInt32LE(n,at+4);bytes.writeUInt32LE(value,at+8);});
 for(const index of [0,count-1]){bytes.writeUInt32LE(pixels,offsets+index*4);bytes.writeUInt32LE(512*512*2,counts+index*4);}
 for(let at=pixels;at<bytes.length;at+=2)bytes.writeUInt16LE(1234,at);
 return bytes;
}
async function main() {
 const GeoTIFF = await import('geotiff');
 const wasm = await import('../media/wasm/tiff-wasm.js');
 await wasm.default({module_or_path:fs.readFileSync('media/wasm/tiff-wasm.wasm')});
 const {openRemoteTiff,TiffRangeSource,remoteTileConcurrency}=await import('../out/media/modules/remote-tiff-source.js');
 global.__tiffVisualizerDecoderWarmup = { wasmModulePromise: WebAssembly.compile(fs.readFileSync('media/wasm/tiff-wasm.wasm')) };
 const { getWasmModule } = await import('../out/media/modules/tiff-wasm-wrapper.js');
 const appModule = await getWasmModule();
 assert.equal(typeof appModule.remote_tiff_ifd, 'function', 'the application wrapper must expose the lazy parser');

 const original=global.fetch;
 let source, served=0, requests=0;
 global.fetch=async (_url, options)=>{
  assert.equal(options.cache,'no-store');
  if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');
  const match=/^bytes=(\d+)-(\d+)$/.exec(new Headers(options.headers).get('range'));
  assert.ok(match);const start=+match[1],end=Math.min(+match[2],source.length-1);
  assert.ok(start<=end,'never ask past EOF');requests++;served+=end-start+1;
  return new Response(source.subarray(start,end+1),{status:206,headers:{'content-range':`bytes ${start}-${end}/${source.length}`}});
 };
 try {
  let compared=0;
  for(const name of ['shapes_lzw_tiled_planar.tif','shapes_lzw_planar.tif','house.tif','bigtiff_deflate_tiled.tif','cog_2band_pyramid.tif','deflate_pred3_f32.tif','pred_ref_rgb8.tif','geotiff_utm31n.tif','cog_pyramid_detail.tif']) {
   source=fs.readFileSync(path.join('test-samples',name));
   const lazy=await openRemoteTiff('https://test.invalid/'+name,GeoTIFF,wasm);
   const whole=await GeoTIFF.fromArrayBuffer(source.buffer.slice(source.byteOffset,source.byteOffset+source.byteLength));
   assert.equal(await lazy.getImageCount(),await whole.getImageCount());
   for(let page=0;page<await whole.getImageCount();page++) {
    const actualImage=await lazy.getImage(page),referenceImage=await whole.getImage(page);
    assert.deepEqual([actualImage.getWidth(),actualImage.getHeight()],[referenceImage.getWidth(),referenceImage.getHeight()]);
    for(const concurrency of [1,2,4,8]) {
     await Promise.all(Array.from({length:concurrency},async(_,index)=>{
      const w=Math.min(17,referenceImage.getWidth()),h=Math.min(19,referenceImage.getHeight());
      const x=index%2 ? referenceImage.getWidth()-w:0,y=index%3 ? referenceImage.getHeight()-h:0;
      const options={window:[x,y,x+w,y+h]};
      const [actual,expected]=await Promise.all([actualImage.readRasters(options),referenceImage.readRasters(options)]);
      assert.deepEqual(actual,expected,`${name}, IFD ${page}, concurrency ${concurrency}`);compared++;
     }));
    }
   }
   await lazy.close();
  }
  source=largeIndexFixture();served=requests=0;
  const load = new AbortController();
  const lazy=await openRemoteTiff('https://test.invalid/large-index.tif',GeoTIFF,wasm,load.signal);
  const image=await lazy.getImage();
  assert.equal(image.fileDirectory.TileOffsets.length,1024*1024);
  assert.ok(served<=16384,'opening must not fetch either 4 MB tile-index table');
  for(const edge of [0,512*1024-8]){
   const raster=await image.readRasters({window:[edge,edge,edge+8,edge+8]});
   assert.ok(raster[0].every(value=>value===1234));
  }
  assert.ok(served<2*1024*1024,'fetch only selected index entries and pixel blocks');
  load.abort();
  lazy.setLoadSignal(new AbortController().signal);
  const resumed=await image.readRasters({window:[0,0,2,2]});
  assert.ok(resumed[0].every(value=>value===1234),'a retained TIFF remains usable after a new load signal');
  const before=requests;
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(image.readRasters({window:[0,0,1,1],signal:cancelled.signal}),e=>e.name==='AbortError');
  assert.equal(requests,before,'cancelled viewport performs no request');
  assert.equal(remoteTileConcurrency(512,512,1),16);
  assert.equal(remoteTileConcurrency(512,512,8),2);
  assert.equal(remoteTileConcurrency(8192,8192,4),1);
  global.fetch=async()=>new Response('ignored range',{status:200});
  await assert.rejects(new TiffRangeSource('https://test.invalid').fetch([{offset:0,length:16}]),/must support byte ranges/);
  for(const data of [new Uint8Array(),new Uint8Array([73,73,43,0,4,0,0,0])])assert.throws(()=>wasm.remote_tiff_header(data));
  assert.throws(()=>wasm.remote_tiff_index_values(new Uint8Array(3),2,true));
  assert.throws(()=>wasm.remote_tiff_index_values(new Uint8Array(8).fill(255),8,true));
  const little=wasm.remote_tiff_index_values(new Uint8Array([1,2,3,4]),4,true);
  const big=wasm.remote_tiff_index_values(new Uint8Array([4,3,2,1]),4,false);
  assert.deepEqual(little,big);
  console.log(`✅ ${compared} lazy regions identical at concurrency 1/2/4/8; million-entry index stays lazy; cancellation, EOF, endian and concurrency guards passed`);
 } finally {global.fetch=original;}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
