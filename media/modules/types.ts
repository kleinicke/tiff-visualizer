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
  typeMin?: number;
  typeMax?: number;
  rgbAs24BitGrayscale?: boolean;
  planarData?: any;
  collectHistogram?: boolean;
  renderHistogramResult?: any;
  channels?: number;
  /**
   * Whether a sample beyond the colour samples is alpha (default true).
   *
   * Only the file knows. TIFF says so in ExtraSamples (tag 338): 1 or 2 mean
   * alpha, 0 means "unspecified" — which is what GDAL writes for an ordinary
   * multi-band raster. Assuming alpha there renders a 2-band Int16 COG almost
   * entirely transparent, because its second band is data, not coverage.
   */
  extraSamplesAreAlpha?: boolean;
  /**
   * The file's "this pixel holds no measurement" sentinel — GDAL_NODATA (TIFF
   * tag 42113). Rendered like NaN, since that is what it means; already
   * excluded from auto-normalize statistics.
   */
  nodataValue?: number;
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
  typeMin?: number;
  typeMax?: number;
}

/** Basic min/max statistics for image data. */
export interface Stats {
  min: number;
  max: number;
}

/**
 * Result shape shared by every decoder that produces a numeric raster with a
 * numeric domain and free-form metadata: FITS, NetCDF, DICOM, CZI, and (via
 * the same Rust `DecodedArray` struct) PFM, NetPBM and NPY.
 *
 * This used to live in `scientific-format-parsers.ts` alongside the TypeScript
 * parsers. Those parsers are all gone — decoding happens in Rust — so the
 * interface outlived its file and moved here.
 */
export interface ScientificDecodedImage {
	width: number;
	height: number;
	channels: number;
	data: Float32Array;
	metadata: Record<string, any>;
	numericDomain: {
		bitsPerSample: number;
		sampleFormat: 1 | 2 | 3;
		typeMin: number;
		typeMax: number;
		sourceNumericType: 'uint8' | 'int8' | 'uint16' | 'int16' | 'uint32' | 'int32' | 'float32' | 'float64';
	};
	/**
	 * Sample statistics computed once inside the Rust decoder (see
	 * `DecodedArray::finalize_stats` in `crates/image-decoders/src/lib.rs`), ported
	 * from `ImageStatsCalculator.calculateFloatStats` / `.calculateIntegerStats`.
	 * Always present for the seven Rust-decoded formats — consume this instead
	 * of rescanning with `ImageStatsCalculator` on the load path.
	 */
	stats: Stats;
	nonFiniteCount: number;
	validCount: number;
	decodeTimings?: { name: string, durationMs: number }[];
}
