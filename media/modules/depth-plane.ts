import type { ActiveImage } from './active-image';

/** Encode original scalar samples, never a display canvas or normalized values. */
export function encodeDepthPlane(image: ActiveImage | null): Uint8Array {
  const raster = image?.raster;
  if (!raster) throw new Error('Original depth samples are not available for this image.');
  if (raster.channels !== 1) throw new Error('Open a single-channel depth image or select a grayscale slice first. RGB images and channel composites cannot be opened as depth.');
  const { width, height } = raster;
  const count = width * height;
  const samples = image?.planar?.[0] ?? raster.data;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || !Number.isSafeInteger(count) || samples.length !== count) {
    throw new Error('The selected depth plane is incomplete. Wait for the image to finish loading.');
  }
  // f64 retains every Number-valued decoded sample, including uint32, NaN and
  // infinities. This does not recover precision already lost by a decoder.
  const header = `{'descr': '<f8', 'fortran_order': False, 'shape': (${height}, ${width}), }`;
  const padded = header + ' '.repeat((64 - ((10 + header.length + 1) % 64)) % 64) + '\n';
  const bytes = new Uint8Array(10 + padded.length + count * 8);
  bytes.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, padded.length, true);
  bytes.set(new TextEncoder().encode(padded), 10);
  const offset = 10 + padded.length;
  for (let i = 0; i < count; i++) view.setFloat64(offset + i * 8, samples[i], true);
  return bytes;
}
