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

const urlBundle = buildSync({
  entryPoints: ['src/util/remoteImageUrl.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const loadedUrl = { exports: {} };
new Function('module', 'exports', 'require', urlBundle.outputFiles[0].text)(loadedUrl, loadedUrl.exports, require);
const { normalizeRemoteImageUrl } = loadedUrl.exports;

const encodedImageUrl = 'https%3A%2F%2Fdata.source.coop%2Ftge-labs%2Faef%2Fv1%2Fannual%2F2017%2F10N%2Fx1a7tdgjoh7rfvkxc-0000008192-0000000000.tiff&mode=single&bands=1&zoom=12.09&lat=35.231944&lon=-120.68416';
assert.equal(
  normalizeRemoteImageUrl(encodedImageUrl),
  'https://data.source.coop/tge-labs/aef/v1/annual/2017/10N/x1a7tdgjoh7rfvkxc-0000008192-0000000000.tiff',
  'encoded image URLs should be decoded without the source viewer state',
);
assert.equal(
  normalizeRemoteImageUrl('https://example.com/image.tif?token=abc&part=1'),
  'https://example.com/image.tif?token=abc&part=1',
  'ordinary image URL query parameters must be preserved',
);
const escapedSentinelUrl = 'https%3A%2F%2Fsentinel-cogs.s3.us-west-2.amazonaws.com%2Fsentinel-s2-l2a-cogs%2F32%2FU%2FQD%2F2023%2F6%2FS2A\\_32UQD\\_20230612\\_0\\_L2A%2FB01.tif&mode=single&bands=1';
assert.equal(
  normalizeRemoteImageUrl(escapedSentinelUrl),
  'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/32/U/QD/2023/6/S2A_32UQD_20230612_0_L2A/B01.tif',
  'Markdown-escaped underscores should not turn into path separators',
);

const dicom = createDicomFrameDataset({ name: 'volume.dcm', url: 'blob:volume' }, 3);
assert.ok(dicom, 'multi-frame DICOM should create a browser dataset');
assert.equal(dicom.series[0].planes.length, 3);
assert.deepEqual(dicom.series[0].planes.map(plane => plane.frameIndex), [0, 1, 2]);
assert.equal(findDatasetPlane(dicom, 0, { frame: 2 }).plane.frameIndex, 2);
assert.equal(createDicomFrameDataset({ name: 'single.dcm', url: 'blob:single' }, 1), null);

const groupedDicom = createDicomFrameDataset(
  { name: 'combined.dcm', url: 'blob:combined' },
  5,
  ['Series 4', 'Series 4', 'Series 6', 'Series 6', 'Series 6'],
);
assert.ok(groupedDicom, 'labeled multi-frame DICOM should create a browser dataset');
assert.deepEqual(groupedDicom.series.map(series => series.label), ['Series 4', 'Series 6']);
assert.deepEqual(groupedDicom.series.map(series => series.planes.length), [2, 3]);
assert.deepEqual(groupedDicom.series[1].planes.map(plane => plane.frameIndex), [2, 3, 4]);
assert.equal(findDatasetPlane(groupedDicom, 1, { frame: 1 }).plane.frameIndex, 3);

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
const netlify = fs.readFileSync('netlify.toml', 'utf8');
const imagePreview = fs.readFileSync('media/imagePreview.ts', 'utf8');
const imagePreviewCss = fs.readFileSync('media/imagePreview.css', 'utf8');
const roiOverlay = fs.readFileSync('media/modules/measure/roi-overlay.ts', 'utf8');
const measurePanel = fs.readFileSync('media/modules/measure-panel.ts', 'utf8');
assert.match(html, /class="web-drop-zone"/, 'the empty state should be centered on a large drop target');
assert.doesNotMatch(html, /data-web-action="close-control"/, 'display popovers should not need a close button');
assert.match(css, /> canvas:not\(\.scale-to-fit\)[\s\S]*?max-height: none !important/, 'zoomed canvases must not retain fit-mode height limits');
assert.match(css, /> canvas:not\(\.scale-to-fit\)[\s\S]*?flex: none;[\s\S]*?max-width: none !important/, 'zoomed canvases must not be flex-shrunk back to the viewport');
assert.match(css, /body\.web-app\s*\{[\s\S]*?margin:\s*0;[\s\S]*?overflow:\s*hidden;/, 'fit mode must not create page scrollbars from browser body defaults');
assert.match(css, /\.web-app\.web-has-image\.web-image-zoomed \{ overflow: auto; \}/, 'explicit zoom must keep page panning available');
assert.match(css, /--context-menu-bottom-inset:\s*28px/, 'the website context menu should reserve its status bar');
assert.match(css, /\.web-app \.dataset-overlay \{ top: 58px; \}/, 'dataset navigation should sit below the website toolbar');
assert.match(host, /!controlPopover\.contains\(target as Node\)/, 'display popovers should close after an outside click');
assert.match(host, /activeControlPopover === kind[\s\S]*?closeControlPopover\(\)/, 'clicking the active status control should close its popover');
assert.match(html, /resourceUri":"welcome\.png","src":"data:image\/png;base64,/, 'the initial placeholder MIME type and bytes should agree');
assert.match(html, /data-web-command="tiffVisualizer\.openAsPointCloud"/, 'supported depth images should retain the point-cloud action');
assert.match(html, /<footer[^>]*web-status-bar[\s\S]*?data-status-action="options"[\s\S]*?data-status-action="layers"/, 'Options should be the first website status-bar action');
assert.match(html, /data-supported-formats/, 'the file-opening surface should expose its supported formats');
assert.match(html, /data-web-action="loading-log"/, 'the quiet More menu should expose the loading log');
assert.match(html, /id="web-image-tabs-shell"[^>]*hidden/, 'the toolbar should reserve its free space for open image tabs');
assert.match(html, /id="web-image-tabs-previous"[\s\S]*?id="web-image-tabs"[^>]*role="tablist"[\s\S]*?id="web-image-tabs-next"/, 'overflowing image tabs should have scroll controls on both sides');
assert.doesNotMatch(html, /id="web-file-summary"/, 'the current filename should not be repeated below the website title');
assert.match(host, /files\.push\(\.\.\.nextFiles/, 'opening more files should add tabs instead of replacing the current collection');
assert.match(host, /className = 'web-image-tab-select'/, 'each open image should receive a selectable tab');
assert.match(host, /closeImageAt\(index, true\)/, 'image tabs should be individually closable');
assert.doesNotMatch(host, /if \(files\.length > 1\) \{[\s\S]*?className = 'web-image-tab-close'/, 'the final image tab should retain its close button');
assert.match(host, /case 'toggleImage':[\s\S]*?case 'jumpToCollectionIndex':[\s\S]*?click-only/, 'shared viewer navigation must not switch website image tabs');
assert.match(css, /\.web-image-tabs \{[\s\S]*?overflow-x:\s*auto;/, 'overflowing image tabs should remain horizontally scrollable');
assert.match(html, /id="web-log-panel"[^>]*role="dialog"/, 'loading timings should live in a separate diagnostics panel');
assert.match(host, /loadingLog\.push\(line\)/, 'viewer output should be retained for the page session');
assert.match(host, /type: 'switchToImage',[\s\S]*?loadStartTime: Date\.now\(\)/, 'website totals should start when an image begins opening');
assert.match(host, /formatOpenedImageLine\(message\.value\)/, 'the website log should pair timings with file attributes');
assert.match(host, /if \(loadingLogArmed\) appendLoadingLog\(message\.value\)/, 'the welcome-image timing should stay out of the user loading log');
assert.match(imagePreview, /case 'switchToImage':[\s\S]*?extensionLoadStartTime = Number\(message\.loadStartTime\)/, 'switched images should use their own total-time clock');
assert.match(imagePreview, /resetVisibleTiming\(\);\s*initialLoadStartTime = performance\.now\(\);/, 'switched images should produce full per-format performance summaries');
assert.match(host, /type: 'showContextMenu'/, 'the Options status action should open the shared image menu');
assert.match(host, /getBoundingClientRect\(\)[\s\S]*?type: 'showContextMenu', x: anchor\.left, y: anchor\.top/, 'the shared image menu should originate at the Options button');
assert.match(imagePreview, /case 'showContextMenu':[\s\S]*?MouseEvent\('contextmenu'/, 'the shared viewer should open its real context menu on host request');
assert.match(imagePreview, /getPropertyValue\('--context-menu-bottom-inset'\)/, 'context-menu placement should account for host UI below the image');
assert.match(imagePreview, /container\.addEventListener\('click',[\s\S]*?e\.target !== imageElement[\s\S]*?zoomController\.zoomIn\(\)/, 'website controls must not bubble into click-to-zoom');
assert.match(imagePreviewCss, /max-height: calc\(100vh - 16px - var\(--context-menu-bottom-inset, 0px\)\)/, 'an over-tall context menu should scroll above host UI');
assert.match(host, /scientific-image-handoff-probe/, 'the browser host should wait for the 3D viewer before transferring a file');
assert.match(host, /scientific-image-depth/, 'the browser host should hand the selected depth image to the ready 3D viewer');
assert.match(netlify, /Cross-Origin-Opener-Policy = "same-origin-allow-popups"/, 'the deployed page must retain its 3D viewer popup connection');
assert.match(netlify, /connect-src 'self' https: blob: data:/, 'the deployed page must permit user-selected HTTPS image hosts');
assert.match(css, /--measure-scale-bar-bottom-inset:\s*28px/, 'the site should reserve its fixed status-bar height for the scale bar');
assert.match(roiOverlay, /window\.innerHeight - bottomInset/, 'the shared scale bar should honor a host-provided bottom inset');
assert.match(measurePanel, /if \(result && this\.isVisible\(\)\) \{ this\.render\(\); \}/, 'completed particle analysis should update both the green preview and its count');
assert.match(measurePanel, /token !== this\.particleToken[\s\S]*?void this\.startParticleAnalysis\(\)/, 'a filter change during analysis should schedule the current result');
assert.match(measurePanel, /\? 'Analyzing objects…'/, 'pending analysis must not be described as zero accepted objects');

console.log('Browser dataset host tests passed');
