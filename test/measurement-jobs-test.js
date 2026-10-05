const assert = require('node:assert/strict');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const url = relative => pathToFileURL(path.resolve(relative)).href;

async function main() {
  const wasm = await import(url('out/media/wasm/tiff-wasm.js'));
  await wasm.default({ module_or_path: fs.readFileSync('out/media/wasm/tiff-wasm.wasm') });
  const { MeasurementAnalysis } = await import(url('out/media/modules/measure/analysis.js'));
  let changes = 0;
  const job = new MeasurementAnalysis({getSource:()=>({width:2,height:1}),getScalarPlane:()=>new Float32Array([10,20]),changed:()=>changes++,maskChanged() {},isVisible:()=>true});
  job.threshold.manual = true;
  let release;
  let calls = 0;
  job.preprocessedPlane = () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(new Float32Array([10,20]));
  job.thresholdToken = 1;
  const first = job.runPrepareThreshold(1);
  job.thresholdToken = 2;
  await job.runPrepareThreshold(2);
  release(new Float32Array([1,2]));
  await first;
  for (let i=0; i<100 && !job.histogram; i++) await new Promise(resolve => setTimeout(resolve,5));
  assert.equal(job.histogram?.min,10,'latest queued preprocessing request must run after stale work finishes');
  assert.equal(changes,1,'stale analysis cannot publish results');

  job.preprocessedPlane = () => new Promise(resolve => { release=resolve; });
  job.thresholdToken = 3;
  const oldImage = job.runPrepareThreshold(3);
  job.invalidateImage();
  release(new Float32Array([100,200]));
  await oldImage;
  assert.equal(job.histogram,null,'switching images invalidates all pending analysis');
  assert.equal(changes,1);

  job.previewPlane = new Float32Array([10,20]);
  job.histogram = {min:10,max:20,counts:new Uint32Array(256)};
  job.threshold.low=15; job.threshold.high=20;
  await job.runApplyThreshold(job.thresholdToken);
  assert.deepEqual([...job.thresholdMask],[0,1]);
  let particlePasses = 0;
  job.runParticles = () => ++particlePasses === 1 ? new Promise(resolve => { release=resolve; }) : Promise.resolve({particles:[{id:'latest'}]});
  const beforeParticles = changes;
  const particleJob = job.startParticleAnalysis();
  job.particleToken++;
  release({particles:[{id:'stale'}]});
  await particleJob;
  for (let i=0; i<100 && job.particleAnalysisRunning; i++) await new Promise(resolve => setTimeout(resolve,5));
  assert.equal(job.particleResult.particles[0].id,'latest');
  assert.equal(changes,beforeParticles+1,'publish the current particle result once for both preview and count');
  console.log('Measurement jobs: latest-request scheduling, image invalidation and source-domain masks passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
