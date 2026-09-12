import { installPythonHost } from './python-host';
import { flushSync, mount } from 'svelte';
import App from './App.svelte';
import DisplayForm from './DisplayForm.svelte';
import ImageTabs from './ImageTabs.svelte';
import { mountView } from '../ui/mount.js';
import { unmount } from 'svelte';

import { installEmbeddedImageHost, notifyEmbeddedImageHost } from './embedded-host.js';
import { setupAppInstall } from './app-install.js';
import {
  createDicomFrameDataset,
  createOmeDataset,
  findDatasetPlane,
  type BrowserDatasetManifest,
} from './browser-dataset.js';
import { normalizeRemoteImageUrl } from '../src/util/remoteImageUrl.js';
import { normalizeUrlHistory, rememberUrl, UrlHistoryCursor } from '../src/util/urlHistory.js';
import {
  IMAGE_HEADER_PROBE_BYTES,
  ImageHeaderHttpError,
  sniffImageFormat,
  probeRemoteImage,
  filenameForDetectedFormat,
} from '../src/util/imageFormatSniffer.js';

type ViewerMessage = { type: string; [key: string]: any };

interface BrowserFileEntry {
  sourceUrl?: string;
  name: string;
  size: number | null;
  file?: File;
  url: string;
  resourceUri: string;
  ownsObjectUrl: boolean;
  /** Content-derived registry hint; valid even when the name is misleading. */
  formatHint?: string;
}

interface ViewerSettings {
  normalization: { min: number; max: number; autoNormalize: boolean; gammaMode: boolean };
  gamma: { in: number; out: number };
  brightness: { offset: number };
  rgbAs24BitGrayscale: boolean;
  scale24BitFactor: number;
  normalizedFloatMode: boolean;
  nanColor?: string;
  colorPickerShowModified?: boolean;
  showScaleBar?: boolean;
  gpuAcceleration?: boolean;
  experimentalRegionDecode?: boolean;
  resourceUri?: string;
  src?: string;
  [key: string]: any;
}

// Mount synchronously before the host binds native file and message handlers.
flushSync(() => mount(App, { target: document.body }));
const toolbar = document.querySelector<HTMLElement>('.web-toolbar')!;
const toolbarObserver = new ResizeObserver(() => {
  document.documentElement.style.setProperty('--web-toolbar-bottom', `${Math.max(0, toolbar.getBoundingClientRect().bottom) + 12}px`);
});
toolbarObserver.observe(toolbar);

const STORAGE_STATE = 'scientific-image-visualizer.webview-state';
const STORAGE_THEME = 'scientific-image-visualizer.theme';
const STORAGE_URL_HISTORY = 'scientific-image-visualizer.url-history';
const POINT_CLOUD_URL = 'https://3d.f-kleinicke.de/';
const POINT_CLOUD_ORIGIN = new URL(POINT_CLOUD_URL).origin;
const POINT_CLOUD_FORMATS = new Set([
  'tiff-float', 'tiff-int', 'tiff-int-signed', 'tiff-int-wide', 'tiff-uint16',
  'pfm', 'npy', 'npy-float', 'npy-uint', 'png',
]);
const SUPPORTED_FORMATS_TOOLTIP = 'TIFF/OME-TIFF, EXR, PFM, NPY/NPZ, PNG, JPEG, WebP, AVIF, HDR, JXL, TGA, BMP, ICO, PPM/PGM/PBM, FITS, DICOM, classic NetCDF, CZI, ND2, LIF, ORA, KRA, PSD/PSB, XCF, and Affinity Photo';
const formatSettings = new Map<string, ViewerSettings>();
let files: BrowserFileEntry[] = [];
let urlHistory = normalizeUrlHistory(readJson(STORAGE_URL_HISTORY));
const urlHistoryCursor = new UrlHistoryCursor(urlHistory);
let fileIndex = 0;
let showingOverview = true;
let currentFormat = '';
let copiedPosition: any = null;
let state: any = readJson(STORAGE_STATE) || {};
let showScaleBar = true;
let currentSettings = baseSettings();
let pendingImportKind: 'imagej' | 'sidecar' = 'sidecar';
let dragDepth = 0;
let currentSize = '';
let currentPixel = '';
let currentZoom: number | 'fit' = 'fit';
let currentFormatInfo: any = null;
let currentStats: { min: number; max: number } | null = null;
let currentDataset: BrowserDatasetManifest | null = null;
let currentDatasetSeries = 0;
let currentDatasetCoordinates: Record<string, number> = {};
let layersActive = false;
const loadingLog: string[] = [];
let loadingLogArmed = false;
type ControlPopoverKind = 'normalization' | 'gamma' | 'exposure' | 'zoom';
let activeControlPopover: ControlPopoverKind | null = null;

function baseSettings(): ViewerSettings {
  return {
    normalization: { min: 0, max: 1, autoNormalize: true, gammaMode: false },
    gamma: { in: 2.2, out: 2.2 },
    brightness: { offset: 0 },
    rgbAs24BitGrayscale: false,
    scale24BitFactor: 1000,
    normalizedFloatMode: false,
    nanColor: 'black',
    colorPickerShowModified: false,
    showScaleBar,
    gpuAcceleration: true,
    // Matches the extension's default: the region path is proven against the
    // whole-image one by tests, but not yet the default anywhere.
    experimentalRegionDecode: new URLSearchParams(window.location.search).has('regionDecode'),
    plyVisualizerInstalled: true,
    extensionVersion: 'web-1',
    vscodeVersion: 'browser',
    surfaceMode: 'editor',
  };
}

function defaultsForFormat(format: string): ViewerSettings {
  const settings = baseSettings();
  const displayIntegers = new Set([
    'tiff-int', 'ppm', 'png', 'jpg', 'sgi', 'tga', 'webp', 'avif', 'bmp', 'jxl',
    'ora', 'kra', 'psd', 'psb', 'xcf', 'affinity',
  ]);
  const displayFloats = new Set(['tiff-float', 'pfm', 'hdr']);
  if (displayIntegers.has(format) || displayFloats.has(format)) {
    settings.normalization = { min: 0, max: 1, autoNormalize: false, gammaMode: true };
  }
  return settings;
}

function readJson(key: string): any {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function saveUrlHistory(url: string): void {
  urlHistory = rememberUrl(urlHistory, url);
  urlHistoryCursor.setHistory(urlHistory);
  try { localStorage.setItem(STORAGE_URL_HISTORY, JSON.stringify(urlHistory)); } catch { /* storage unavailable */ }
}

function installUrlHistoryNavigation(input: HTMLInputElement): void {
  input.addEventListener('keydown', event => {
    const value = event.key === 'ArrowUp'
      ? urlHistoryCursor.previous(input.value)
      : event.key === 'ArrowDown'
        ? urlHistoryCursor.next()
        : null;
    if (value === null) { return; }
    event.preventDefault();
    input.value = value;
    input.setSelectionRange(value.length, value.length);
  });
  input.addEventListener('input', () => urlHistoryCursor.reset());
}

function sendToViewer(message: ViewerMessage): void {
  window.postMessage(message, window.location.origin);
}

function showToast(message: string): void {
  const region = document.getElementById('web-toast-region');
  if (!region || !message) return;
  const toast = document.createElement('div');
  toast.className = 'web-toast';
  toast.textContent = message;
  region.appendChild(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function renderLoadingLog(): void {
  const output = document.getElementById('web-log-output');
  if (!output) return;
  if (loadingLog.length === 0) {
    output.replaceChildren(Object.assign(document.createElement('span'), {
      className: 'web-log-empty',
      textContent: 'Open an image to record its loading times.',
    }));
    return;
  }
  output.textContent = loadingLog.join('\n');
  output.scrollTop = output.scrollHeight;
}

function appendLoadingLog(message: unknown): void {
  const line = String(message || '').trim();
  if (!line) return;
  loadingLog.push(line);
  renderLoadingLog();
}

function setLoadingLogOpen(open: boolean): void {
  const panel = document.getElementById('web-log-panel') as HTMLElement | null;
  if (!panel) return;
  panel.hidden = !open;
  if (open) {
    renderLoadingLog();
    panel.querySelector<HTMLElement>('.web-log-close')?.focus();
  }
}

function formatOpenedImageLine(value: any): string | null {
  const entry = files[fileIndex];
  if (!entry || !value) return null;
  const width = Number(value.width);
  const height = Number(value.height);
  const channels = Number(value.samplesPerPixel ?? value.channels);
  const bits = Number(value.bitsPerSample);
  const dimensions = Number.isFinite(channels) && channels > 0
    ? `${channels}x${width}x${height}`
    : `${width}x${height}`;
  const bitDepth = Number.isFinite(bits) ? `${bits}-bit` : 'unknown bit depth';
  const sourceSize = entry.size === null ? 'remote' : formatLogBytes(entry.size);
  return `📂 Opened 1: ${entry.name} (${dimensions}, ${bitDepth}, ${sourceSize})`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const absolute = Math.abs(value);
  if ((absolute !== 0 && absolute < 0.001) || absolute >= 1_000_000) return value.toExponential(3);
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}

function formatLogBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(2)} KB`;
  return `${(size / 1024 ** 2).toFixed(2)} MB`;
}

function normalizationLabel(): string {
  const normalization = currentSettings.normalization;
  if (normalization.autoNormalize) {
    return currentStats
      ? `Auto-Norm: [${formatNumber(currentStats.min)}, ${formatNumber(currentStats.max)}]`
      : 'Auto-Norm';
  }
  if (normalization.gammaMode) return 'Gamma-Norm';
  return `Norm: [${formatNumber(normalization.min)}, ${formatNumber(normalization.max)}]`;
}

function syncStatusBar(): void {
  const size = document.getElementById('web-status-size');
  const bytes = document.getElementById('web-status-bytes');
  const zoom = document.getElementById('web-status-zoom');
  const normalization = document.getElementById('web-status-normalization');
  const gamma = document.getElementById('web-status-gamma');
  const exposure = document.getElementById('web-status-exposure');
  const layers = document.getElementById('web-status-layers');
  const pointCloud = document.querySelector('[data-web-point-cloud]') as HTMLButtonElement | null;
  const readout = currentPixel || currentSize || '—';
  if (size && size.textContent !== readout) size.textContent = readout;
  if (bytes) {
    const entry = files[fileIndex];
    bytes.textContent = entry ? (entry.size === null ? 'Remote' : formatBytes(entry.size)) : '—';
  }
  if (zoom) zoom.textContent = currentZoom === 'fit' ? 'Whole Image' : `${Math.round(currentZoom * 100)}%`;
  if (normalization) normalization.textContent = normalizationLabel();
  if (gamma) {
    gamma.textContent = `γ: ${currentSettings.gamma.in.toFixed(1)}→${currentSettings.gamma.out.toFixed(1)}`;
    gamma.hidden = !currentSettings.normalization.gammaMode;
  }
  if (exposure) {
    const value = currentSettings.brightness.offset;
    exposure.textContent = `Exposure: ${value >= 0 ? '+' : ''}${value.toFixed(1)} EV`;
    exposure.hidden = !currentSettings.normalization.gammaMode;
  }
  if (layers) layers.setAttribute('aria-pressed', String(layersActive));
  if (pointCloud) {
    pointCloud.hidden = !files[fileIndex] || !POINT_CLOUD_FORMATS.has(currentFormatInfo?.formatType || '');
  }
  document.body.classList.toggle('web-image-zoomed', currentZoom !== 'fit');
  notifyEmbeddedImageHost();
}

async function openCurrentAsPointCloud(): Promise<void> {
  const entry = files[fileIndex];
  if (!entry || !POINT_CLOUD_FORMATS.has(currentFormatInfo?.formatType || '')) {
    showToast('This image format cannot be opened as a point cloud.');
    return;
  }

  // Keep this call synchronous with the click so Safari does not classify the
  // new viewer tab as an unsolicited popup.
  const target = window.open(POINT_CLOUD_URL, '_blank');
  if (!target) {
    showToast('Allow pop-ups for this site to open the 3D viewer.');
    return;
  }

  showToast('Opening this image in the 3D viewer…');
  const handoffId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataPromise = entry.file
    ? entry.file.arrayBuffer()
    : fetch(entry.url, { mode: 'cors', redirect: 'follow' }).then(async response => {
      if (!response.ok) throw new Error(`the server answered ${response.status} ${response.statusText}`);
      return response.arrayBuffer();
    });
  let settled = false;

  const finish = () => {
    settled = true;
    window.clearInterval(probeTimer);
    window.clearTimeout(timeoutTimer);
    window.removeEventListener('message', receiveReady);
  };
  const receiveReady = async (event: MessageEvent) => {
    if (
      settled || event.origin !== POINT_CLOUD_ORIGIN || event.source !== target ||
      event.data?.type !== 'scientific-image-viewer-ready' || event.data?.id !== handoffId
    ) return;
    finish();
    try {
      const data = await dataPromise;
      target.postMessage({
        type: 'scientific-image-depth',
        id: handoffId,
        fileName: entry.name,
        data,
      }, POINT_CLOUD_ORIGIN, [data]);
    } catch (error) {
      target.close();
      showToast(`Could not open the 3D viewer: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  window.addEventListener('message', receiveReady);
  const sendProbe = () => {
    if (target.closed) {
      finish();
      return;
    }
    target.postMessage({ type: 'scientific-image-handoff-probe', id: handoffId }, POINT_CLOUD_ORIGIN);
  };
  const probeTimer = window.setInterval(sendProbe, 250);
  const timeoutTimer = window.setTimeout(() => {
    if (settled) return;
    finish();
    showToast('The 3D viewer opened, but the automatic image handoff timed out.');
  }, 15000);
  sendProbe();
}

function sendCurrentSettings(reason: string): void {
  if (files[fileIndex]) {
    currentSettings.resourceUri = files[fileIndex].resourceUri;
    currentSettings.src = files[fileIndex].url;
  }
  formatSettings.set(currentFormat, structuredClone(currentSettings));
  sendToViewer({ type: 'updateSettings', settings: currentSettings, reason });
  syncStatusBar();
}

let controlForm: ReturnType<typeof mount> | null = null;
function closeControlPopover(): void {
  if (controlForm) { void unmount(controlForm); controlForm = null; }
  const popover = document.getElementById('web-control-popover');
  if (popover) popover.hidden = true;
  activeControlPopover = null;
}

function openControlPopover(kind: ControlPopoverKind): void {
  const popover = document.getElementById('web-control-popover') as HTMLElement | null;
  const title = document.getElementById('web-control-title');
  const content = document.getElementById('web-control-content');
  if (!popover || !title || !content) return;
  if (!popover.hidden && activeControlPopover === kind) {
    closeControlPopover();
    return;
  }
  activeControlPopover = kind;
  if (controlForm) void unmount(controlForm);
  let submit: (event: SubmitEvent) => void;
  const isSingleChannelInteger = (currentFormatInfo?.samplesPerPixel ?? 1) === 1 && currentFormatInfo?.sampleFormat !== 3;

  if (kind === 'normalization') {
    title.textContent = 'Image normalization';
    submit = event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget as HTMLFormElement);
      const selectedMode = String(data.get('mode') || 'auto');
      const minimum = Number(data.get('minimum'));
      const maximum = Number(data.get('maximum'));
      if (selectedMode === 'manual' && (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum)) {
        showToast('The maximum display value must be greater than the minimum.');
        return;
      }
      currentSettings.normalization = {
        min: Number.isFinite(minimum) ? minimum : currentSettings.normalization.min,
        max: Number.isFinite(maximum) ? maximum : currentSettings.normalization.max,
        autoNormalize: selectedMode === 'auto',
        gammaMode: selectedMode === 'gamma',
      };
      if (isSingleChannelInteger) currentSettings.normalizedFloatMode = data.get('normalizedFloat') === 'on';
      sendCurrentSettings('browser-normalization');
      closeControlPopover();
    };
  } else if (kind === 'gamma') {
    title.textContent = 'Gamma correction';
    submit = event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget as HTMLFormElement);
      const gammaIn = Number(data.get('gammaIn'));
      const gammaOut = Number(data.get('gammaOut'));
      if (!(gammaIn > 0) || !(gammaOut > 0)) { showToast('Gamma values must be greater than zero.'); return; }
      currentSettings.gamma = { in: gammaIn, out: gammaOut };
      currentSettings.normalization.autoNormalize = false;
      currentSettings.normalization.gammaMode = true;
      sendCurrentSettings('browser-gamma');
      closeControlPopover();
    };
  } else if (kind === 'exposure') {
    title.textContent = 'Exposure';
    submit = event => {
      event.preventDefault();
      const exposure = Number(new FormData(event.currentTarget as HTMLFormElement).get('exposure'));
      if (!Number.isFinite(exposure)) { showToast('Enter a valid exposure value.'); return; }
      currentSettings.brightness = { offset: exposure };
      currentSettings.normalization.autoNormalize = false;
      currentSettings.normalization.gammaMode = true;
      sendCurrentSettings('browser-exposure');
      closeControlPopover();
    };
  } else {
    title.textContent = 'Zoom';
    submit = event => {
      event.preventDefault();
      const raw = String(new FormData(event.currentTarget as HTMLFormElement).get('scale') || 'fit');
      sendToViewer({ type: 'setScale', scale: raw === 'fit' ? 'fit' : Number(raw) });
      closeControlPopover();
    };
  }
  controlForm = flushSync(() => mount(DisplayForm, { target: content, props: { kind, settings: structuredClone(currentSettings), zoom: currentZoom, isSingleChannelInteger, submit } }));
  popover.hidden = false;
  (content.querySelector('input, select') as HTMLElement | null)?.focus();
}

function downloadBytes(fileName: string, bytes: Uint8Array, type = 'application/octet-stream'): void {
  const payload = bytes.slice().buffer as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([payload], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function collectionState() {
  // Website files are navigated exclusively through the toolbar tabs. Keeping
  // the shared viewer collection at one item prevents its arrow-key handler
  // from switching website tabs.
  return { totalImages: files.length > 0 ? 1 : 0, currentIndex: 0, show: false };
}

function updateCollectionOverlay(): void {
  sendToViewer({ type: 'updateImageCollectionOverlay', data: collectionState() });
}

function updateTabScrollControls(): void {
  const tabList = document.getElementById('web-image-tabs');
  const previous = document.getElementById('web-image-tabs-previous') as HTMLButtonElement | null;
  const next = document.getElementById('web-image-tabs-next') as HTMLButtonElement | null;
  if (!tabList || !previous || !next) return;
  const overflowing = tabList.scrollWidth > tabList.clientWidth + 1;
  previous.hidden = !overflowing;
  next.hidden = !overflowing;
  previous.disabled = !overflowing || tabList.scrollLeft <= 1;
  next.disabled = !overflowing || tabList.scrollLeft + tabList.clientWidth >= tabList.scrollWidth - 1;
}

const tabsView = mountView(ImageTabs, { entries: [] as { name: string; title: string }[], index: 0, overview: true,
  select: (index: number) => { if (showingOverview || index !== fileIndex) switchTo(index); },
  close: (index: number) => closeImageAt(index, true),
}, document.getElementById('web-image-tabs')!);
function renderImageTabs(): void {
  const tabList = document.getElementById('web-image-tabs');
  const tabShell = document.getElementById('web-image-tabs-shell');
  if (!tabList || !tabShell) return;
  tabShell.hidden = files.length === 0;
  tabsView.update({ entries: files.map(entry => ({ name: entry.name, title: entry.size === null ? `${entry.name} · remote` : `${entry.name} · ${formatBytes(entry.size)}` })),
    index: fileIndex, overview: showingOverview,
    select: index => { if (showingOverview || index !== fileIndex) switchTo(index); },
    close: index => closeImageAt(index, true),
  });
  tabList.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  window.requestAnimationFrame(updateTabScrollControls);
}

function closeImageAt(index: number, restoreFocus = false): void {
  if (index < 0 || index >= files.length) return;
  const closingActiveImage = index === fileIndex;
  const [removed] = files.splice(index, 1);
  if (removed.ownsObjectUrl) { URL.revokeObjectURL(removed.url); }
  if (files.length === 0) {
    fileIndex = 0;
    showOverview();
    return;
  }
  if (index < fileIndex) fileIndex--;
  if (showingOverview) {
    fileIndex = Math.min(fileIndex, files.length - 1);
    renderImageTabs();
  } else if (closingActiveImage) {
    switchTo(Math.min(index, files.length - 1));
  } else {
    renderImageTabs();
    updateCollectionOverlay();
    syncStatusBar();
  }
  if (restoreFocus) {
    document.querySelector<HTMLElement>('.web-image-tab-select[aria-selected="true"]')?.focus();
  }
}

function showOverview(): void {
  showingOverview = true;
  currentDataset = null;
  currentDatasetCoordinates = {};
  currentFormatInfo = null;
  currentStats = null;
  currentSize = '';
  currentPixel = '';
  currentZoom = 'fit';
  closeControlPopover();
  document.body.classList.remove('web-has-image', 'web-image-zoomed');
  updateSourceUrl();
  sendToViewer({ type: 'setDataset', manifest: null, seriesIndex: 0, coordinates: {} });
  sendToViewer({ type: 'clearImage' });
  renderImageTabs();
  updateCollectionOverlay();
  syncStatusBar();
}

function switchTo(index: number, preserveDataset = false, resetView = false): void {
  if (files.length === 0) return;
  resetView ||= showingOverview;
  showingOverview = false;
  fileIndex = (index + files.length) % files.length;
  const entry = files[fileIndex];
  updateSourceUrl(entry.sourceUrl);
  if (!preserveDataset && currentDataset) {
    currentDataset = null;
    currentDatasetCoordinates = {};
    sendToViewer({ type: 'setDataset', manifest: null, seriesIndex: 0, coordinates: {} });
  }
  document.body.classList.add('web-has-image');
  renderImageTabs();
  sendToViewer({
    type: 'switchToImage',
    uri: entry.url,
    resourceUri: entry.resourceUri,
    zoomState: resetView ? { scale: 'fit', x: 0, y: 0 } : undefined,
    loadStartTime: Date.now(),
    collection: collectionState(),
    formatHint: entry.formatHint,
  });
  updateCollectionOverlay();
  syncStatusBar();
}

function updateSourceUrl(source?: string): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('url');
  if (source) url.searchParams.set('source', source);
  else url.searchParams.delete('source');
  window.history.replaceState(window.history.state, '', url);
}

async function openFiles(selected: File[], sourceUrl?: string): Promise<void> {
  const nextFiles = selected.filter(file => file.size > 0);
  if (nextFiles.length === 0) {
    showToast('No readable files were selected.');
    return;
  }
  if (currentDataset) sendToViewer({ type: 'setDataset', manifest: null, seriesIndex: 0, coordinates: {} });
  const firstNewIndex = files.length;
  const detected = await Promise.all(nextFiles.map(async file => {
    try {
      const prefix = new Uint8Array(await file.slice(0, IMAGE_HEADER_PROBE_BYTES).arrayBuffer());
      return sniffImageFormat(prefix)?.hint;
    } catch { return undefined; }
  }));
  files.push(...nextFiles.map((file, index) => ({
      file,
      name: file.name,
      size: file.size,
      url: URL.createObjectURL(file),
      resourceUri: file.name,
      sourceUrl,
      ownsObjectUrl: true,
      formatHint: detected[index],
    })));
  currentDataset = null;
  currentDatasetCoordinates = {};
  currentFormatInfo = null;
  currentStats = null;
  currentSize = '';
  currentPixel = '';
  switchTo(firstNewIndex, false, true);
}

/**
 * Open an image straight from an https:// link.
 *
 * TIFF stays as a remote URL when its host supports byte ranges, so the shared
 * range-backed path reads metadata, an overview, then visible detail tiles.
 * TIFF hosts returning full responses and decoders for other formats
 * still need one contiguous buffer, so those URLs become a File and follow the
 * same path as a dropped local image.
 *
 * The bytes go from the host to this tab and nowhere else — no server of ours
 * sits in between, which also means a host that refuses cross-origin reads
 * cannot be worked around from here. Say so plainly rather than appearing to
 * fail for no reason.
 */
async function openUrl(rawUrl: string): Promise<void> {
  const trimmed = normalizeRemoteImageUrl(rawUrl);
  if (!trimmed) return;
  // Accept what people actually paste: a full link, a bare host and path
  // (which every browser address bar treats as https), or a path on this host.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('.')
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate, window.location.href);
  } catch {
    showToast('That does not look like a URL.');
    return;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    showToast('Only http:// and https:// links can be opened.');
    return;
  }

  const encodedName = parsed.pathname.split('/').filter(Boolean).pop() || 'image';
  let name = encodedName;
  try { name = decodeURIComponent(encodedName); } catch { /* retain the server's spelling */ }
  const canonicalUrl = parsed.toString();
  saveUrlHistory(canonicalUrl);
  const visibleInput = document.getElementById('web-url-input') as HTMLInputElement | null;
  if (visibleInput) { visibleInput.value = canonicalUrl; }

  let detected: Awaited<ReturnType<typeof probeRemoteImage>>['format'] = null;
  let supportsRanges: boolean | undefined;
  const probeController = new AbortController();
  const probeTimeout = window.setTimeout(() => probeController.abort(), 5_000);
  try {
    const probe = await probeRemoteImage(canonicalUrl, probeController.signal);
    detected = probe.format;
    supportsRanges = probe.supportsRanges;
  } catch (error) {
    // A rejected range can still be readable through the normal loader.
    // Other HTTP failures must reach the user before TIFF routing loses the status.
    if (error instanceof ImageHeaderHttpError && error.status !== 416) {
      showToast(`${name}: the server answered ${error.status} ${error.statusText}.`);
      return;
    }
    console.info('[WebHost] Header probe unavailable; using URL suffix', error);
  } finally {
    window.clearTimeout(probeTimeout);
  }

  const suffixSaysTiff = /\.(?:tif|tiff|tf2|tf8|btf)$/i.test(parsed.pathname);
  if (supportsRanges !== false && (detected?.hint === 'tiff' || (!detected && suffixSaysTiff))) {
    if (currentDataset) sendToViewer({ type: 'setDataset', manifest: null, seriesIndex: 0, coordinates: {} });
    const firstNewIndex = files.length;
    files.push({
      name,
      size: null,
      url: canonicalUrl,
      resourceUri: canonicalUrl,
      sourceUrl: canonicalUrl,
      ownsObjectUrl: false,
      formatHint: detected?.hint || 'tiff',
    });
    currentDataset = null;
    currentDatasetCoordinates = {};
    currentFormatInfo = null;
    currentStats = null;
    currentSize = '';
    currentPixel = '';
    showToast(`Opening ${name}…`);
    switchTo(firstNewIndex, false, true);
    return;
  }

  showToast(`Downloading ${name}…`);
  try {
    const response = await fetch(canonicalUrl, { mode: 'cors', redirect: 'follow' });
    if (!response.ok) {
      showToast(`${name}: the server answered ${response.status} ${response.statusText}.`);
      return;
    }
    const blob = await response.blob();
    if (blob.size === 0) {
      showToast(`${name} is empty.`);
      return;
    }
    const downloadName = detected ? filenameForDetectedFormat(name, detected) : name;
    await openFiles([new File([blob], downloadName, { type: blob.type || 'application/octet-stream' })], canonicalUrl);
  } catch (error) {
    // A cross-origin refusal reaches script as an opaque TypeError with no
    // detail — the browser deliberately withholds the reason — so this message
    // has to cover the whole class rather than report what happened.
    console.warn('[WebHost] URL open failed', error);
    showToast(`Could not read ${name}. The host may not allow other sites to read its files; `
      + 'downloading the file and opening it here always works.');
  }
}

function addLayerFiles(selected: File[]): void {
  const images = selected.filter(file => file.size > 0).map(file => ({
    resourceUri: file.name,
    src: URL.createObjectURL(file),
  }));
  if (images.length > 0) sendToViewer({ type: 'addLayerImages', images });
}

function setDataset(manifest: BrowserDatasetManifest, seriesIndex = 0, coordinates: Record<string, number> = {}): void {
  currentDataset = manifest;
  currentDatasetSeries = seriesIndex;
  currentDatasetCoordinates = { ...coordinates };
  sendToViewer({ type: 'setDataset', manifest, seriesIndex, coordinates });
}

function registerDicomFrames(frameCountValue: unknown, frameLabelsValue?: unknown): void {
  const entry = files[fileIndex];
  if (!entry) return;
  const manifest = createDicomFrameDataset({ name: entry.name, url: entry.url }, frameCountValue, frameLabelsValue);
  if (manifest) setDataset(manifest, 0, { frame: 0 });
}

function registerOmeDataset(description: any): void {
  if (!description || !Array.isArray(description.series)) {
    if (description?.metadataFile) {
      showToast('Select the OME metadata file and all referenced TIFF files together to open this fileset in the browser.');
    }
    return;
  }
  const current = files[fileIndex];
  const result = createOmeDataset(
    description,
    files.map(entry => ({ name: entry.name, url: entry.url })),
    current ? { name: current.name, url: current.url } : undefined,
  );
  if (!result) {
    showToast('The referenced OME-TIFF files were not selected. Open all members of the fileset together.');
    return;
  }
  setDataset(result.manifest, result.seriesIndex, result.coordinates);
}

function navigateDataset(seriesIndexValue: unknown, coordinatesValue: unknown): void {
  if (!currentDataset) return;
  const selected = findDatasetPlane(currentDataset, seriesIndexValue, coordinatesValue);
  if (!selected) { showToast('No image plane is available at that dataset position.'); return; }
  const { plane, seriesIndex, coordinates } = selected;
  currentDatasetSeries = seriesIndex;
  currentDatasetCoordinates = coordinates;
  const matchingIndex = files.findIndex(entry => entry.name === plane.resourceUri);
  if (matchingIndex >= 0) fileIndex = matchingIndex;
  sendToViewer({
    type: 'switchToDatasetPlane',
    uri: plane.src,
    resourceUri: plane.resourceUri,
    formatHint: plane.format,
    pageIndex: plane.pageIndex,
    frameIndex: plane.frameIndex,
    seriesIndex,
    coordinates,
  });
  renderImageTabs();
  syncStatusBar();
}

function handleFormatInfo(message: ViewerMessage): void {
  const format = String(message.value?.formatType || 'unknown');
  if (currentFormat && currentFormat !== format) {
    formatSettings.set(currentFormat, structuredClone(currentSettings));
  }
  currentFormat = format;
  currentFormatInfo = message.value || null;
  if (message.value?.isInitialLoad) {
    const openedLine = formatOpenedImageLine(message.value);
    if (openedLine) {
      loadingLogArmed = true;
      appendLoadingLog(openedLine);
    }
  }
  currentSettings = structuredClone(formatSettings.get(format) || defaultsForFormat(format));
  if (files[fileIndex]) {
    currentSettings.resourceUri = files[fileIndex].resourceUri;
    currentSettings.src = files[fileIndex].url;
  }
  if (message.value?.isInitialLoad) {
    sendToViewer({
      type: 'updateSettings',
      settings: currentSettings,
      reason: 'browser-format-settings',
      isInitialRender: true,
    });
  }
  syncStatusBar();
}

function executeCommand(command: string): void {
  const directMessages: Record<string, ViewerMessage> = {
    'tiffVisualizer.copyImage': { type: 'copyImage' },
    'tiffVisualizer.pastePosition': { type: 'pastePosition', state: copiedPosition },
    'tiffVisualizer.toggleHistogram': { type: 'toggleHistogram' },
    'tiffVisualizer.toggleChannels': { type: 'toggleChannels' },
    'tiffVisualizer.toggleMeasure': { type: 'toggleMeasure' },
    'tiffVisualizer.toggleMetadata': { type: 'toggleMetadata' },
    'tiffVisualizer.revertToOriginal': { type: 'revertToOriginal' },
  };
  if (directMessages[command]) {
    sendToViewer(directMessages[command]);
    return;
  }
  if (command === 'tiffVisualizer.toggleScaleBar') {
    showScaleBar = !showScaleBar;
    currentSettings.showScaleBar = showScaleBar;
    for (const settings of formatSettings.values()) { settings.showScaleBar = showScaleBar; }
    sendToViewer({ type: 'toggleScaleBar', shown: showScaleBar });
  } else if (command === 'tiffVisualizer.browseAndAddToCollection') {
    document.getElementById('web-file-input')?.click();
  } else if (command === 'tiffVisualizer.addLayer') {
    const input = document.getElementById('web-file-input') as HTMLInputElement | null;
    if (input) {
      input.dataset.mode = 'layers';
      input.click();
    }
  } else if (command === 'tiffVisualizer.toggleLayers') {
    const input = document.getElementById('web-file-input') as HTMLInputElement | null;
    if (input) {
      input.dataset.mode = 'layers';
      input.click();
    }
  } else if (command === 'tiffVisualizer.exportLayers') {
    sendToViewer({ type: 'getLayerExportCompatibility' });
  } else if (command === 'tiffVisualizer.toggleNanColor') {
    // Same cycle as the extension: black, fuchsia, transparent. Kept as a
    // literal list rather than importing the viewer's, since this host talks to
    // the viewer only through settings messages.
    const cycle = ['black', 'fuchsia', 'transparent'];
    const index = cycle.indexOf(String(currentSettings.nanColor));
    currentSettings.nanColor = cycle[(index + 1) % cycle.length];
    sendCurrentSettings('browser-nan-color');
  } else if (command === 'tiffVisualizer.toggleColorPickerMode') {
    currentSettings.colorPickerShowModified = !currentSettings.colorPickerShowModified;
    sendCurrentSettings('browser-color-picker');
  } else if (command === 'tiffVisualizer.toggleRgb24Mode') {
    currentSettings.rgbAs24BitGrayscale = !currentSettings.rgbAs24BitGrayscale;
    sendCurrentSettings('browser-rgb24-mode');
  } else if (command === 'tiffVisualizer.applyColormap') {
    const colormap = window.prompt('Colormap: viridis, plasma, inferno, magma, turbo, jet, gray', currentSettings.displayColormap || 'viridis');
    if (colormap) {
      currentSettings.displayColormap = colormap.trim();
      sendToViewer({ type: 'setDisplayColormap', colormap: currentSettings.displayColormap });
    }
  } else if (command === 'tiffVisualizer.convertColormapToFloat') {
    const colormap = window.prompt('Colormap used by the image: viridis, plasma, inferno, magma, jet, hot, cool, turbo, gray', 'viridis');
    if (!colormap) return;
    const minimum = window.prompt('Minimum decoded value', '0');
    if (minimum === null) return;
    const maximum = window.prompt('Maximum decoded value', '1');
    if (maximum === null) return;
    const min = Number(minimum);
    const max = Number(maximum);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
      showToast('The maximum decoded value must be greater than the minimum.');
      return;
    }
    const logarithmic = window.confirm('Use logarithmic value mapping? Select Cancel for linear mapping.');
    const inverted = window.confirm('Invert the colormap direction? Select Cancel for normal direction.');
    sendToViewer({ type: 'convertColormapToFloat', colormap: colormap.trim(), min, max, logarithmic, inverted });
  } else if (command === 'tiffVisualizer.openAsPointCloud') {
    void openCurrentAsPointCloud();
  } else {
    showToast('That action currently requires the VS Code extension.');
  }
}

function handleViewerMessage(message: ViewerMessage): void {
  switch (message.type) {
    case 'automationResult': {
      const pending = automationRequests.get(message.id);
      if (pending) { automationRequests.delete(message.id); clearTimeout(pending.timer); if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result); }
      break;
    }
    case 'get-initial-data':
      sendToViewer({ type: 'restoreHistogramState', isVisible: false, scaleMode: 'sqrt' });
      updateCollectionOverlay();
      break;
    case 'formatInfo':
      handleFormatInfo(message);
      break;
    case 'size':
      currentSize = String(message.value || '');
      syncStatusBar();
      break;
    case 'zoom':
      currentZoom = message.value === 'fit' ? 'fit' : Number(message.value || 1);
      syncStatusBar();
      break;
    case 'pixelFocus':
      currentPixel = String(message.value || '');
      syncStatusBar();
      break;
    case 'pixelBlur':
      currentPixel = '';
      syncStatusBar();
      break;
    case 'stats':
      currentStats = message.value && Number.isFinite(Number(message.value.min)) && Number.isFinite(Number(message.value.max))
        ? { min: Number(message.value.min), max: Number(message.value.max) }
        : null;
      syncStatusBar();
      break;
    case 'refresh-status':
      syncStatusBar();
      break;
    case 'executeCommand':
      executeCommand(String(message.command || ''));
      break;
    case 'toggleImage':
    case 'toggleImageReverse':
    case 'jumpToCollectionIndex':
      // Website image tabs are intentionally click-only.
      break;
    case 'removeFromCollection': {
      closeImageAt(fileIndex);
      break;
    }
    case 'registerDicomFrames':
      registerDicomFrames(message.frames, message.frameLabels);
      break;
    case 'registerOmeDataset':
      registerOmeDataset(message.dataset);
      break;
    case 'navigateDataset':
      navigateDataset(message.seriesIndex, message.coordinates);
      break;
    case 'resolveLayerUris': {
      const map: Record<string, string> = {};
      for (const resourceUri of Array.isArray(message.resourceUris) ? message.resourceUris : []) {
        const entry = files.find(candidate => candidate.name === resourceUri || resourceUri.endsWith(`/${candidate.name}`));
        if (entry) map[resourceUri] = entry.url;
      }
      sendToViewer({ type: 'layerUrisResolved', map });
      break;
    }
    case 'show-error':
    case 'showMessage':
      showToast(String(message.message || 'The image could not be displayed.'));
      break;
    case 'positionCopied':
      copiedPosition = message.state;
      break;
    case 'layerModeChanged':
      layersActive = !!message.active;
      syncStatusBar();
      break;
    case 'didGetLayerExportCompatibility': {
      const options = Array.isArray(message.options) ? message.options : [];
      const selected = options.find((option: any) => option.format === 'png' && option.compatible) || options.find((option: any) => option.compatible);
      if (selected) sendToViewer({ type: 'exportLayerDocument', format: selected.format });
      else showToast('No compatible export format is available for this view.');
      break;
    }
    case 'didExportLayerDocument':
      if (message.error) showToast(String(message.error));
      else if (message.payload) downloadBytes(`scientific-image-export.${message.format || 'bin'}`, bytesFromBase64(message.payload));
      break;
    case 'measureSaveText':
      downloadBytes(String(message.fileName || 'results.csv'), new TextEncoder().encode(String(message.content || '')), 'text/plain;charset=utf-8');
      break;
    case 'measureSaveBinary':
      downloadBytes(String(message.fileName || 'export.bin'), Uint8Array.from(message.bytes || []));
      break;
    case 'measureSaveSidecar':
      downloadBytes(`${files[fileIndex]?.name || 'image'}.rois.json`, new TextEncoder().encode(String(message.content || '')), 'application/json');
      break;
    case 'measureRequestImport': {
      pendingImportKind = message.kind === 'imagej' ? 'imagej' : 'sidecar';
      const input = document.getElementById('web-import-input') as HTMLInputElement | null;
      if (input) {
        input.accept = pendingImportKind === 'imagej' ? '.roi,.zip' : '.json';
        input.click();
      }
      break;
    }
    case 'log':
      if (message.value) {
        console.info(message.value);
        if (loadingLogArmed) appendLoadingLog(message.value);
      }
      break;
  }
}

(window as any).acquireVsCodeApi = () => ({
  postMessage(message: ViewerMessage) {
    handleViewerMessage(message);
    return Promise.resolve(true);
  },
  setState(nextState: any) {
    state = nextState || {};
    try { localStorage.setItem(STORAGE_STATE, JSON.stringify(state)); } catch { /* storage unavailable */ }
    return state;
  },
  getState() {
    return state;
  },
});

function applyTheme(theme: 'dark' | 'light'): void {
  const light = theme === 'light';
  document.documentElement.classList.toggle('web-light', light);
  document.documentElement.classList.toggle('vscode-dark', !light);
  document.body.classList.toggle('vscode-dark', !light);
  document.body.classList.toggle('vscode-light', light);
  localStorage.setItem(STORAGE_THEME, theme);
  const button = document.querySelector('[data-web-action="theme"]');
  if (button) button.textContent = light ? 'Toggle dark theme' : 'Toggle light theme';
}

document.addEventListener('DOMContentLoaded', () => {
  setupAppInstall(openFiles, showToast);
  applyTheme(localStorage.getItem(STORAGE_THEME) === 'light' ? 'light' : 'dark');
  const fileInput = document.getElementById('web-file-input') as HTMLInputElement;
  const importInput = document.getElementById('web-import-input') as HTMLInputElement;
  const moreMenu = document.getElementById('web-more-menu') as HTMLElement;
  const moreButton = document.querySelector('[data-web-action="more"]') as HTMLButtonElement;
  const controlPopover = document.getElementById('web-control-popover') as HTMLElement;
  const logPanel = document.getElementById('web-log-panel') as HTMLElement;
  const imageTabs = document.getElementById('web-image-tabs') as HTMLElement;
  const previousImageTabs = document.getElementById('web-image-tabs-previous') as HTMLButtonElement;
  const nextImageTabs = document.getElementById('web-image-tabs-next') as HTMLButtonElement;

  document.querySelector<HTMLAnchorElement>('.web-brand')?.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    moreMenu.hidden = true;
    moreButton.setAttribute('aria-expanded', 'false');
    showOverview();
  });

  document.querySelectorAll('[data-web-action="open"]').forEach(button => {
    button.addEventListener('click', () => {
      delete fileInput.dataset.mode;
      fileInput.click();
    });
  });
  const urlForm = document.getElementById('web-url-form') as HTMLFormElement | null;
  document.querySelectorAll<HTMLButtonElement>('[data-example-url]').forEach(button => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await openUrl(button.dataset.exampleUrl || ''); }
      finally { button.disabled = false; }
    });
  });
  const urlInput = document.getElementById('web-url-input') as HTMLInputElement | null;
  const urlDialog = document.getElementById('web-url-dialog') as HTMLDialogElement | null;
  const urlDialogForm = document.getElementById('web-url-dialog-form') as HTMLFormElement | null;
  const urlDialogInput = document.getElementById('web-url-dialog-input') as HTMLInputElement | null;
  if (urlInput) { installUrlHistoryNavigation(urlInput); }
  if (urlDialogInput) { installUrlHistoryNavigation(urlDialogInput); }
  urlForm?.addEventListener('submit', event => {
    event.preventDefault();
    void openUrl(urlInput?.value || '');
  });
  urlDialogForm?.addEventListener('submit', event => {
    event.preventDefault();
    const entered = urlDialogInput?.value || '';
    if (!entered.trim()) { return; }
    urlDialog?.close();
    void openUrl(entered);
  });
  document.querySelector('[data-web-action="close-url-dialog"]')?.addEventListener('click', () => urlDialog?.close());
  document.querySelectorAll('[data-web-action="open-url"]').forEach(button => {
    button.addEventListener('click', () => {
      // In the More menu, so close it the way the other entries do.
      moreMenu.hidden = true;
      moreButton.setAttribute('aria-expanded', 'false');
      if (!urlDialog || !urlDialogInput) { return; }
      urlHistoryCursor.reset();
      urlDialogInput.value = urlInput?.value || urlHistory[urlHistory.length - 1] || '';
      urlDialog.showModal();
      urlDialogInput.focus();
      urlDialogInput.setSelectionRange(urlDialogInput.value.length, urlDialogInput.value.length);
    });
  });

  // ?url=… opens a link directly, which is what makes a viewer address
  // shareable: a catalogue entry, a chat message, a bookmark.
  const query = new URLSearchParams(window.location.search);
  const requested = query.get('source') || query.get('url');
  if (requested) {
    if (urlInput) { urlInput.value = requested; }
    void openUrl(requested);
  }

  document.querySelectorAll('[data-viewer-message]').forEach(button => {
    button.addEventListener('click', () => sendToViewer({ type: (button as HTMLElement).dataset.viewerMessage || '' }));
  });
  document.querySelectorAll('[data-status-action]').forEach(button => {
    button.addEventListener('click', () => {
      const action = (button as HTMLElement).dataset.statusAction;
      if (action === 'normalization' || action === 'gamma' || action === 'exposure' || action === 'zoom') {
        openControlPopover(action);
      } else if (action === 'options') {
        const menu = document.querySelector('.custom-context-menu');
        if (menu) {
          menu.dispatchEvent(new Event('dismiss'));
          return;
        }
        const anchor = (button as HTMLElement).getBoundingClientRect();
        sendToViewer({ type: 'showContextMenu', x: anchor.left, y: anchor.top });
      } else if (action === 'layers') {
        executeCommand('tiffVisualizer.toggleLayers');
      }
    });
  });
  document.querySelectorAll('[data-web-command]').forEach(button => {
    button.addEventListener('click', () => {
      executeCommand((button as HTMLElement).dataset.webCommand || '');
      moreMenu.hidden = true;
      moreButton.setAttribute('aria-expanded', 'false');
    });
  });
  document.querySelectorAll('[data-supported-formats]').forEach(element => {
    element.setAttribute('title', SUPPORTED_FORMATS_TOOLTIP);
    element.setAttribute('aria-label', `${element.textContent?.trim() || 'Supported formats'}: ${SUPPORTED_FORMATS_TOOLTIP}`);
  });
  moreButton.addEventListener('click', event => {
    event.stopPropagation();
    moreMenu.hidden = !moreMenu.hidden;
    moreButton.setAttribute('aria-expanded', String(!moreMenu.hidden));
  });
  document.querySelector('[data-web-action="theme"]')?.addEventListener('click', () => {
    applyTheme(document.documentElement.classList.contains('web-light') ? 'dark' : 'light');
    moreMenu.hidden = true;
  });
  document.querySelector('[data-web-action="loading-log"]')?.addEventListener('click', () => {
    setLoadingLogOpen(true);
    moreMenu.hidden = true;
    moreButton.setAttribute('aria-expanded', 'false');
  });
  document.querySelector('[data-web-action="close-loading-log"]')?.addEventListener('click', () => setLoadingLogOpen(false));
  document.querySelector('[data-web-action="clear-loading-log"]')?.addEventListener('click', () => {
    loadingLog.length = 0;
    renderLoadingLog();
  });
  document.querySelector('[data-web-action="copy-loading-log"]')?.addEventListener('click', async () => {
    if (loadingLog.length === 0) return;
    try {
      await navigator.clipboard.writeText(loadingLog.join('\n'));
      showToast('Loading log copied.');
    } catch {
      showToast('The browser could not copy the loading log.');
    }
  });
  document.addEventListener('click', event => {
    if (!moreMenu.hidden && !moreMenu.contains(event.target as Node) && event.target !== moreButton) {
      moreMenu.hidden = true;
      moreButton.setAttribute('aria-expanded', 'false');
    }
    const target = event.target;
    const clickedStatusControl = target instanceof Element && !!target.closest('[data-status-action]');
    if (!controlPopover.hidden && !controlPopover.contains(target as Node) && !clickedStatusControl) {
      closeControlPopover();
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !controlPopover.hidden) closeControlPopover();
    if (event.key === 'Escape' && !logPanel.hidden) setLoadingLogOpen(false);
  });
  imageTabs.addEventListener('scroll', updateTabScrollControls, { passive: true });
  previousImageTabs.addEventListener('click', () => {
    imageTabs.scrollBy({ left: -Math.max(180, imageTabs.clientWidth * 0.7), behavior: 'smooth' });
  });
  nextImageTabs.addEventListener('click', () => {
    imageTabs.scrollBy({ left: Math.max(180, imageTabs.clientWidth * 0.7), behavior: 'smooth' });
  });
  window.addEventListener('resize', updateTabScrollControls);
  imageTabs.addEventListener('keydown', event => {
    const target = event.target as HTMLElement;
    const index = Number(target.dataset.imageIndex);
    if (!Number.isInteger(index)) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      closeImageAt(index, true);
    }
  });
  fileInput.addEventListener('change', () => {
    const selected = Array.from(fileInput.files || []);
    if (fileInput.dataset.mode === 'layers') addLayerFiles(selected);
    else openFiles(selected);
    fileInput.value = '';
    delete fileInput.dataset.mode;
  });
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    if (file) {
      sendToViewer({
        type: 'measureImportResult',
        kind: pendingImportKind,
        fileName: file.name,
        bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
      });
    }
    importInput.value = '';
  });

  window.addEventListener('dragenter', event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    dragDepth++;
    document.body.classList.add('web-drag-active');
  });
  window.addEventListener('dragover', event => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  });
  window.addEventListener('dragleave', event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('web-drag-active');
  });
  window.addEventListener('drop', event => {
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('web-drag-active');
    openFiles(Array.from(event.dataTransfer?.files || []));
  });
  syncStatusBar();
});


// Native IDE controls share the browser host's settings and command semantics.
installEmbeddedImageHost({
  snapshot: () => ({
    ready: !!files[fileIndex],
    readout: [currentPixel || currentSize, currentZoom === 'fit' ? 'Fit' : `${Math.round(currentZoom * 100)}%`, document.getElementById('web-status-bytes')?.textContent].filter(Boolean).join('  |  '),
    normalization: currentSettings.normalization,
    gamma: currentSettings.gamma,
    exposure: currentSettings.brightness.offset,
    modifiedPicker: !!currentSettings.colorPickerShowModified,
    size: currentSize,
    pixel: currentPixel,
    zoom: currentZoom,
    fileSize: files[fileIndex]?.size ?? null,
    stats: currentStats,
    statusItems: ['size', 'options', 'layers', 'exposure', 'gamma', 'normalization', 'zoom', 'bytes'].map(id => {
      const element = document.getElementById(`web-status-${id}`);
      return { id, text: element?.textContent || '', visible: !!element && !element.hidden, tooltip: element?.title || '' };
    }),
  }),
  adjust(name, values) {
    if (!values.every(Number.isFinite)) return;
    if (name === 'zoom' && values.length === 1 && values[0] > 0 && values[0] <= 200) {
      sendToViewer({ type: 'setScale', scale: values[0] });
      return;
    }
    if (name === 'gamma' && values.length === 2 && values.every(v => v > 0)) {
      currentSettings.gamma = { in: values[0], out: values[1] };
      currentSettings.normalization.autoNormalize = false;
      currentSettings.normalization.gammaMode = true;
    } else if (name === 'exposure' && values.length === 1 && Math.abs(values[0]) <= 16) {
      currentSettings.brightness = { offset: values[0] };
      currentSettings.normalization.autoNormalize = false;
      currentSettings.normalization.gammaMode = true;
    } else if (name === 'range' && values.length === 2 && values[0] < values[1]) {
      currentSettings.normalization = { min: values[0], max: values[1], autoNormalize: false, gammaMode: false };
    } else if (name === 'gammaMode') {
      currentSettings.normalization.autoNormalize = false;
      currentSettings.normalization.gammaMode = true;
    } else if (name === 'auto') {
      currentSettings.normalization.autoNormalize = true;
      currentSettings.normalization.gammaMode = false;
    } else return;
    sendCurrentSettings('embedded-controls');
  },
  command(name) {
    if (name === 'fit') sendToViewer({ type: 'setScale', scale: 'fit' });
    else if (name === 'zoomIn' || name === 'zoomOut') sendToViewer({ type: name });
    else executeCommand(`tiffVisualizer.${name}`);
  },
  statusAction(name) {
    if (name === 'normalization' || name === 'gamma' || name === 'exposure' || name === 'zoom') {
      openControlPopover(name);
    } else if (name === 'options') {
      const menu = document.querySelector('.custom-context-menu');
      if (menu) menu.dispatchEvent(new Event('dismiss'));
      else sendToViewer({ type: 'showContextMenu', x: Math.max(0, innerWidth - 280), y: innerHeight - 8 });
    } else if (name === 'layers') executeCommand('tiffVisualizer.toggleLayers');
  },
  theme: applyTheme,
});


const automationRequests = new Map<string, { resolve: (result: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
function automationRequest(operation: string, args: Record<string, any> = {}): Promise<any> {
  return new Promise((resolve,reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { automationRequests.delete(id); reject(new Error('Image renderer did not respond within 15 seconds')); }, 15000);
    automationRequests.set(id, {resolve,reject,timer});
    sendToViewer({type:'automationRequest',id,operation,args});
  });
}
async function waitForAutomationImage() {
  const deadline = performance.now()+15000;
  while (!currentFormatInfo || !document.body.classList.contains('ready')) {
    if (performance.now()>deadline) throw new Error('Image did not decode within 15 seconds. Check the viewer error message or choose a supported image.');
    await new Promise(resolve=>setTimeout(resolve,50));
  }
}
document.addEventListener('DOMContentLoaded', () => installPythonHost({
  open: async selected => {
    while (files.length) closeImageAt(files.length-1);
    await openFiles(selected);
  },
  execute: async (operation,args) => {
    await waitForAutomationImage();
    if (operation==='select') {
      if (!Number.isInteger(args.index)||args.index<0||args.index>=files.length) throw new Error('Image index is out of range');
      currentFormatInfo=null;
      switchTo(args.index);
      await waitForAutomationImage();
    } else if (operation==='display') {
      if (args.exposure!==undefined) currentSettings.brightness={offset:args.exposure};
      if (args.gamma!==undefined) currentSettings.gamma={in:args.gamma[0],out:args.gamma[1]};
      if (args.exposure!==undefined||args.gamma!==undefined) currentSettings.normalization={...currentSettings.normalization,autoNormalize:false,gammaMode:true};
      if (args.value_range!==undefined) currentSettings.normalization={min:args.value_range[0],max:args.value_range[1],autoNormalize:false,gammaMode:false};
      if (args.auto!==undefined) currentSettings.normalization={...currentSettings.normalization,autoNormalize:args.auto,gammaMode:false};
      await automationRequest('display',{settings:currentSettings,zoom:args.zoom});
      syncStatusBar();
    } else if (!['inspect','pixel','capture','measurements','region'].includes(operation)) throw new Error(`Unknown operation: ${operation}`);
    const result = await automationRequest(['display','select'].includes(operation)?'inspect':operation,args);
    return {...result, file:files[fileIndex]?.name, index:fileIndex, count:files.length, format:currentFormatInfo, stats:currentStats};
  },
}));
