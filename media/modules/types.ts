// Shared type shapes used across multiple webview modules. Only add shapes
// here that are genuinely duplicated between files; format/module-local
// shapes should stay in their own file.

/**
 * Options accepted by ImageRenderer.render() (normalization-helper.ts) and
 * threaded through by every format processor's render*WithSettings() path.
 */
export interface RenderOptions {
  nanColor?: { r: number; g: number; b: number };
  flipY?: boolean;
  typeMax?: number;
  rgbAs24BitGrayscale?: boolean;
  planarData?: any;
  collectHistogram?: boolean;
  renderHistogramResult?: any;
  channels?: number;
}

/**
 * Options passed into a processor's deferred-render / render*WithSettings()
 * entry points. These originate from the webview's updateSettings message
 * handling and are forwarded into the format-specific render pipeline
 * (which further narrows/extends them into a RenderOptions for
 * ImageRenderer.render()).
 */
export interface DeferredRenderOptions {
  targetCanvas?: HTMLCanvasElement;
  collectHistogram?: boolean;
  placeholderImageData?: ImageData;
  renderHistogramResult?: any;
  topDown?: boolean;
}

/** Basic min/max statistics for image data. */
export interface Stats {
  min: number;
  max: number;
}
