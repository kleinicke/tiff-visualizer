/** Results shared by resident, native-image and deferred decoders. */
export interface ImageLoadResult {
  canvas: HTMLCanvasElement;
  imageData: ImageData | null;
  displayElement?: HTMLElement;
  canvasAlreadyRendered?: boolean;
  lazyPixelData?: boolean;
}

export interface LoadProcessor {
  _pendingRenderData?: unknown;
}

export interface ImageLoadHost {
  isCurrent(generation: number): boolean;
  install(result: ImageLoadResult): void;
  draw(image: ImageData, context: CanvasRenderingContext2D): Promise<void>;
  complete(): void;
}

/** Keep placeholders free of 2D contexts so deferred GPU rendering can own them. */
export async function installImageLoad(host: ImageLoadHost, processor: LoadProcessor, result: ImageLoadResult, generation: number): Promise<boolean> {
  if (!host.isCurrent(generation)) return false;
  host.install(result);
  if (!processor._pendingRenderData && !result.canvasAlreadyRendered && result.imageData) {
    const context = result.canvas.getContext('2d');
    if (context) await host.draw(result.imageData, context);
  }
  if (!host.isCurrent(generation)) return false;
  host.complete();
  return true;
}
