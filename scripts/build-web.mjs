import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const outputDirectory = 'web-dist';
const mediaDirectory = `${outputDirectory}/media`;

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(`${mediaDirectory}/wasm`, { recursive: true });

const browserBuild = {
  bundle: true,
  minify: true,
  platform: 'browser',
  target: 'es2020',
  sourcemap: false,
  logLevel: 'info',
};

await Promise.all([
  build({ ...browserBuild, entryPoints: ['web/browser-host.ts'], outfile: `${outputDirectory}/browserHost.bundle.js`, format: 'iife' }),
  build({
    ...browserBuild,
    entryPoints: ['media/imagePreview.ts'],
    outdir: mediaDirectory,
    entryNames: 'imagePreview.bundle',
    chunkNames: 'chunks/[name]-[hash]',
    format: 'esm',
    splitting: true,
  }),
  build({ ...browserBuild, entryPoints: ['media/decode-worker.ts'], outfile: `${mediaDirectory}/decodeWorker.bundle.js`, format: 'esm' }),
	build({ ...browserBuild, entryPoints: ['media/png-decode-worker.ts'], outfile: `${mediaDirectory}/pngDecodeWorker.bundle.js`, format: 'esm' }),
	build({ ...browserBuild, entryPoints: ['media/layered-decode-worker.ts'], outfile: `${mediaDirectory}/layeredDecodeWorker.bundle.js`, format: 'esm' }),
	build({ ...browserBuild, entryPoints: ['media/layered-preview-fallback.ts'], outfile: `${mediaDirectory}/layeredPreviewFallback.bundle.js`, format: 'esm' }),
	build({ ...browserBuild, entryPoints: ['media/layer-document-writer-entry.ts'], outfile: `${mediaDirectory}/layerDocumentWriter.bundle.js`, format: 'esm' }),
	build({ ...browserBuild, entryPoints: ['media/imagej-roi-entry.ts'], outfile: `${mediaDirectory}/imagejRoi.bundle.js`, format: 'esm' }),
  build({ ...browserBuild, entryPoints: ['media/strip-decode-worker.ts'], outfile: `${mediaDirectory}/stripDecodeWorker.bundle.js`, format: 'esm' }),
  build({ ...browserBuild, entryPoints: ['media/fast-raw-worker.ts'], outfile: `${mediaDirectory}/fastRawWorker.bundle.js`, format: 'iife' }),
  build({
    ...browserBuild,
    entryPoints: ['media/layer-compositor-worker.ts'],
    outfile: `${mediaDirectory}/layerCompositorWorker.bundle.js`,
    format: 'iife',
    supported: { 'import-meta': false },
    logOverride: { 'empty-import-meta': 'silent' },
  }),
]);

await Promise.all([
  cp('web/index.html', `${outputDirectory}/index.html`),
  cp('web/website.css', `${outputDirectory}/website.css`),
  cp('web/plausible-init.js', `${outputDirectory}/plausible-init.js`),
  cp('web/vendor-assets.js', `${outputDirectory}/vendor-assets.js`),
  cp('web/og.png', `${outputDirectory}/og.png`),
  cp('icon.png', `${outputDirectory}/icon.png`),
  cp('media/imagePreview.css', `${mediaDirectory}/imagePreview.css`),
  cp('media/geotiff.min.js', `${mediaDirectory}/geotiff.min.js`),
	cp('media/pako.min.js', `${mediaDirectory}/pako.min.js`),
	cp('media/upng.min.js', `${mediaDirectory}/upng.min.js`),
	cp('media/parse-exr.js', `${mediaDirectory}/parse-exr.js`),
  cp('media/loading.svg', `${mediaDirectory}/loading.svg`),
  cp('media/loading-dark.svg', `${mediaDirectory}/loading-dark.svg`),
  cp('media/loading-hc.svg', `${mediaDirectory}/loading-hc.svg`),
  cp('media/wasm', `${mediaDirectory}/wasm`, { recursive: true }),
]);

console.log(`Standalone website built in ${outputDirectory}/`);
