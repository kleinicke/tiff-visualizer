import type { ImageSettings } from './viewer-settings';

export type ZoomState = { scale: number | string; x?: number; y?: number; offsetX?: number; offsetY?: number };
export type CopiedPosition = { relativeX: number; relativeY: number; sourceWidth: number; sourceHeight: number; scale: number | string };
export type CollectionState = { totalImages: number; currentIndex: number; show: boolean; [key: string]: unknown };
export type FormatInfo = { width?: number; height?: number; samplesPerPixel?: number; bitsPerSample?: number; sampleFormat?: number; formatType?: string; isInitialLoad?: boolean; [key: string]: unknown };
export type DatasetPlane = { coordinates: Record<string, number>; resourceUri: string; src: string; format: 'dicom' | 'tiff'; pageIndex?: number; frameIndex?: number };
export type DatasetAxis = { key: string; label: string; size: number; valueLabels?: string[] };
export type DatasetSeries = { id: string; label: string; axes: DatasetAxis[]; planes: DatasetPlane[] };
export type DatasetManifest = { id: string; kind: 'dicom' | 'ome-tiff'; label: string; series: DatasetSeries[] };

type MessageMap<M> = { [K in keyof M]: { type: K } & M[K] }[keyof M];
type Empty = Record<never, never>;
export interface AutomationArguments {
  x?: number; y?: number; width?: number; height?: number; name?: string;
  settings?: ImageSettings; zoom?: number | 'fit';
}
export type AutomationOperation = 'inspect' | 'pixel' | 'region' | 'capture' | 'measurements' | 'display';
export type AutomationRequest = { type: 'automationRequest'; id: string; operation: AutomationOperation; args: AutomationArguments };

export type HostToViewerMessage = AutomationRequest | MessageMap<{
  clearImage: Empty; setScale: { scale: number | string };
  addLayerImages: { images: { src: string; resourceUri: string }[] };
  layerUrisResolved: { map: Record<string, string> }; setActive: { value: boolean };
  zoomIn: Empty; zoomOut: Empty; resetZoom: Empty; copyImage: Empty;
  getLayerExportCompatibility: Empty; exportLayerDocument: { format: string };
  'start-comparison': { peerUri: string }; showContextMenu: { x?: number; y?: number };
  pastePosition: { state?: CopiedPosition | null };
  updateSettings: { settings: ImageSettings; reason?: string; isInitialRender?: boolean };
  updateLoadStartTime: { timestamp: number }; updateImageCollectionOverlay: { data: CollectionState };
  setDataset: { manifest: DatasetManifest | null; seriesIndex?: number; coordinates?: Record<string, number> };
  getZoomState: Empty; getComparisonState: Empty; restoreZoomState: { state: ZoomState };
  restoreComparisonState: { state: { peerUris: string[]; isShowingPeer: boolean } };
  switchToImage: { uri: string; resourceUri: string; formatHint?: string; loadStartTime?: number; zoomState?: ZoomState; collection?: CollectionState };
  switchToDatasetPlane: { uri: string; resourceUri: string; formatHint?: string; seriesIndex?: number; coordinates?: Record<string, number>; pageIndex?: number; frameIndex?: number };
  toggleHistogram: Empty; toggleMetadata: Empty; toggleScaleBar: { shown?: boolean }; toggleChannels: Empty; toggleMeasure: Empty;
  measureHint: { text: string }; measureImportResult: { kind: 'imagej' | 'sidecar'; bytes: number[]; fileName?: string; automatic?: boolean };
  restoreHistogramState: { isVisible: boolean; scaleMode?: 'linear' | 'sqrt'; position?: { left: number; top: number } };
  requestHistogram: Empty; convertColormapToFloat: { colormap: string; min: number; max: number; inverted?: boolean; logarithmic?: boolean };
  revertToOriginal: Empty; setDisplayColormap: { colormap: string }; toggleDebayer: Empty;
}>;

export type ViewerToHostMessage = MessageMap<{
  automationResult: { id: string; result?: unknown; error?: string };
  'get-initial-data': Empty; ready: Empty; measureCheckSidecar: Empty; requestInitialLayers: Empty;
  restorePeerImage: { peerUri: string }; error: { message: string }; notifyRevert: { message: string }; 'reopen-as-text': Empty;
  'show-loading': Empty; 'comparison-ready': Empty; formatInfo: { value: FormatInfo };
  size: { value: string }; zoom: { value: number | string }; pixelFocus: { value: string }; pixelBlur: Empty;
  stats: { value: { min: number; max: number } }; 'refresh-status': Empty;
  executeCommand: { command: string }; toggleImage: Empty; toggleImageReverse: Empty;
  jumpToCollectionIndex: { index: number }; removeFromCollection: Empty;
  registerDicomFrames: { frames: number; frameLabels?: string[] };
  registerOmeDataset: { dataset: Record<string, unknown> };
  navigateDataset: { seriesIndex: number; coordinates: Record<string, number> };
  resolveLayerUris: { resourceUris: string[] };
  'show-error': { message: string }; showMessage: { message: string; level?: 'info' | 'warning' | 'error' };
  positionCopied: { state: CopiedPosition }; layerModeChanged: { active: boolean };
  didGetLayerExportCompatibility: { options: { format: string; compatible: boolean; label?: string; description?: string; detail?: string }[] };
  didExportLayerDocument: { format?: string; payload?: string; error?: string; warnings?: string[] };
  measureSaveText: { fileName: string; content: string; open?: boolean };
  measureSaveBinary: { fileName: string; bytes: number[] };
  measureSaveSidecar: { content: string }; measureRequestImport: { kind: 'imagej' | 'sidecar' };
  log: { value: string }; zoomStateResponse: { state: ZoomState };
  comparisonStateResponse: { state: { peerUris: string[]; isShowingPeer: boolean } };
  measureVisibilityChanged: { isVisible: boolean }; histogramVisibilityChanged: { isVisible: boolean };
  metadataVisibilityChanged: { isVisible: boolean }; channelsVisibilityChanged: { isVisible: boolean };
}>;

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** Validate requests at the automation boundary before interpreting coordinates/settings. */
export function parseAutomationRequest(value: unknown): AutomationRequest {
  if (!record(value) || value.type !== 'automationRequest' || typeof value.id !== 'string' || !value.id) throw new Error('Invalid automation request');
  if (!['inspect', 'pixel', 'region', 'capture', 'measurements', 'display'].includes(String(value.operation))) throw new Error('Unknown image operation');
  const args = value.args ?? {};
  if (!record(args)) throw new Error('Automation arguments must be an object');
  for (const key of ['x', 'y', 'width', 'height']) if (args[key] !== undefined && (!Number.isInteger(args[key]) || Number(args[key]) < (key === 'width' || key === 'height' ? 1 : 0))) throw new Error(`Invalid ${key}`);
  if (value.operation === 'pixel' || value.operation === 'region') {
    for (const key of value.operation === 'pixel' ? ['x','y'] : ['x','y','width','height']) if (args[key] === undefined) throw new Error(`Missing ${key}`);
  }
  if (args.name !== undefined && typeof args.name !== 'string') throw new Error('Invalid region name');
  if (args.zoom !== undefined && args.zoom !== 'fit' && (typeof args.zoom !== 'number' || !Number.isFinite(args.zoom) || args.zoom <= 0)) throw new Error('Invalid zoom');
  if (value.operation === 'display') {
    if (!record(args.settings)) throw new Error('Display settings must be an object');
    for (const [group, keys] of [['normalization',['min','max']], ['gamma',['in','out']], ['brightness',['offset']]] as const) {
      const setting = args.settings[group];
      if (setting === undefined) continue;
      if (!record(setting) || keys.some(key => typeof setting[key] !== 'number' || !Number.isFinite(setting[key]))) throw new Error(`Invalid ${group}`);
    }
  }
  return { type: 'automationRequest', id: value.id, operation: value.operation as AutomationOperation, args: args as AutomationArguments };
}

export interface PythonArguments extends AutomationArguments {
  index?: number; exposure?: number; gamma?: [number, number]; value_range?: [number, number]; auto?: boolean;
}
export type PythonOperation = AutomationOperation | 'select';
export function parsePythonCommand(value: unknown): { id: string; operation: PythonOperation; arguments: PythonArguments } {
  if (!record(value) || typeof value.id !== 'string' || !value.id || !record(value.arguments)) throw new Error('Invalid Python command');
  const args = value.arguments;
  const operation = value.operation;
  if (operation === 'select') {
    if (!Number.isInteger(args.index) || Number(args.index) < 0) throw new Error('Invalid image index');
  } else if (operation === 'display') {
    if (args.exposure !== undefined && (typeof args.exposure !== 'number' || !Number.isFinite(args.exposure))) throw new Error('Invalid exposure');
    for (const name of ['gamma', 'value_range']) {
      const pair = args[name];
      if (pair === undefined) continue;
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`Invalid ${name}`);
      if (name === 'gamma' ? pair.some(value => value <= 0) : pair[1] <= pair[0]) throw new Error(`Invalid ${name}`);
    }
    if (args.auto !== undefined && typeof args.auto !== 'boolean') throw new Error('Invalid auto normalization flag');
    parseAutomationRequest({ type: 'automationRequest', id: value.id, operation: 'display', args: { settings: {}, zoom: args.zoom } });
  } else {
    parseAutomationRequest({ type: 'automationRequest', id: value.id, operation, args });
  }
  return { id: value.id, operation: operation as PythonOperation, arguments: args as PythonArguments };
}
