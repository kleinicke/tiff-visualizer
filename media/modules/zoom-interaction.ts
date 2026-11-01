/** Input policy shared by the element-based image viewer and tiled scenes. */
export const PAN_DRAG_THRESHOLD = 4;

export function wheelShouldZoom(
  event: Pick<WheelEvent, 'altKey' | 'ctrlKey'>,
  scrollToZoom: boolean, isMac: boolean, ctrlPressed = false, altPressed = false,
): boolean {
  return scrollToZoom || event.ctrlKey || (isMac ? event.altKey || altPressed : event.ctrlKey || ctrlPressed);
}

export function wheelDeltaPixels(delta: number, mode: number, viewportSize: number): number {
  return delta * (mode === 1 ? 16 : mode === 2 ? viewportSize : 1);
}

export function wheelZoomFactor(
  event: Pick<WheelEvent, 'deltaY' | 'deltaMode' | 'ctrlKey'>,
  viewportHeight: number, smooth: boolean, pinchFactor = 0.075,
): number {
  if (!event.deltaY) { return 1; }
  if (!smooth) { return 1 - Math.sign(event.deltaY) * pinchFactor; }
  const delta = Math.max(-100, Math.min(100, wheelDeltaPixels(event.deltaY, event.deltaMode, viewportHeight)));
  return Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0025));
}
