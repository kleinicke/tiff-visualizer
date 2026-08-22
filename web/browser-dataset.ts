export interface BrowserDatasetFile {
  name: string;
  url: string;
}

export interface BrowserDatasetPlane {
  coordinates: Record<string, number>;
  resourceUri: string;
  src: string;
  format: 'dicom' | 'tiff';
  pageIndex?: number;
  frameIndex?: number;
}

export interface BrowserDatasetSeries {
  id: string;
  label: string;
  axes: Array<{ key: string; label: string; size: number; valueLabels?: string[] }>;
  planes: BrowserDatasetPlane[];
}

export interface BrowserDatasetManifest {
  id: string;
  kind: 'dicom' | 'ome-tiff';
  label: string;
  series: BrowserDatasetSeries[];
}

export function createDicomFrameDataset(file: BrowserDatasetFile, frameCountValue: unknown): BrowserDatasetManifest | null {
  const frameCount = Math.max(1, Math.trunc(Number(frameCountValue || 1)));
  if (frameCount <= 1) return null;
  return {
    id: `dicom-frames-${file.name}`,
    kind: 'dicom',
    label: file.name,
    series: [{
      id: 'dicom-multiframe',
      label: 'Multi-frame image',
      axes: [{ key: 'frame', label: 'Frame', size: frameCount }],
      planes: Array.from({ length: frameCount }, (_, frameIndex) => ({
        coordinates: { frame: frameIndex },
        resourceUri: file.name,
        src: file.url,
        format: 'dicom' as const,
        frameIndex,
      })),
    }],
  };
}

export function createOmeDataset(
  description: any,
  selectedFiles: BrowserDatasetFile[],
  currentFile: BrowserDatasetFile | undefined,
): { manifest: BrowserDatasetManifest; seriesIndex: number; coordinates: Record<string, number> } | null {
  if (!description || !Array.isArray(description.series)) return null;
  const byName = new Map(selectedFiles.map(file => [file.name, file]));
  const series: BrowserDatasetSeries[] = description.series.map((source: any, seriesIndex: number) => {
    const planes: BrowserDatasetPlane[] = (source.planes || []).flatMap((plane: any) => {
      const referencedName = String(plane.fileName || currentFile?.name || '').replace(/\\/g, '/').split('/').pop() || '';
      const file = byName.get(referencedName) || (referencedName === currentFile?.name ? currentFile : undefined);
      if (!file) return [];
      return [{
        coordinates: { c: Number(plane.c || 0), z: Number(plane.z || 0), t: Number(plane.t || 0) },
        resourceUri: file.name,
        src: file.url,
        format: 'tiff' as const,
        pageIndex: Number(plane.ifd || 0),
      }];
    });
    return {
      id: String(source.imageId || `Image:${seriesIndex}`),
      label: String(source.imageName || `OME Image ${seriesIndex + 1}`),
      axes: [
        { key: 'c', label: 'C', size: Math.max(1, Number(source.sizeC || 1)), valueLabels: Array.isArray(source.channelNames) ? source.channelNames : undefined },
        { key: 'z', label: 'Z', size: Math.max(1, Number(source.sizeZ || 1)) },
        { key: 't', label: 'T', size: Math.max(1, Number(source.sizeT || 1)) },
      ],
      planes,
    };
  }).filter((entry: BrowserDatasetSeries) => entry.planes.length > 0);
  if (series.length === 0) return null;
  const requestedPage = Number(description.currentPageIndex || 0);
  const matchedSeries = series.findIndex(entry => entry.planes.some(plane => plane.resourceUri === currentFile?.name && plane.pageIndex === requestedPage));
  const seriesIndex = Math.max(0, matchedSeries);
  const initialPlane = series[seriesIndex].planes.find(plane => plane.resourceUri === currentFile?.name && plane.pageIndex === requestedPage) || series[seriesIndex].planes[0];
  return {
    manifest: {
      id: `ome-${description.uuid || currentFile?.name || 'dataset'}`,
      kind: 'ome-tiff',
      label: String(description.imageName || currentFile?.name || 'OME dataset'),
      series,
    },
    seriesIndex,
    coordinates: initialPlane.coordinates,
  };
}

export function findDatasetPlane(
  manifest: BrowserDatasetManifest,
  seriesIndexValue: unknown,
  coordinatesValue: unknown,
): { plane: BrowserDatasetPlane; seriesIndex: number; coordinates: Record<string, number> } | null {
  if (!coordinatesValue || typeof coordinatesValue !== 'object') return null;
  const seriesIndex = Math.max(0, Math.min(manifest.series.length - 1, Math.trunc(Number(seriesIndexValue || 0))));
  const series = manifest.series[seriesIndex];
  const coordinates: Record<string, number> = {};
  for (const axis of series.axes) {
    coordinates[axis.key] = Math.max(0, Math.min(axis.size - 1, Math.trunc(Number((coordinatesValue as any)[axis.key] || 0))));
  }
  const plane = series.planes.find(candidate => series.axes.every(axis => Number(candidate.coordinates[axis.key] || 0) === coordinates[axis.key]));
  return plane ? { plane, seriesIndex, coordinates } : null;
}
