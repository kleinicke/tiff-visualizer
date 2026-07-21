export type DatasetKind = 'dicom' | 'ome-tiff';
export type DatasetSourceFormat = 'dicom' | 'tiff';

export interface DatasetAxis {
	key: string;
	label: string;
	size: number;
	valueLabels?: string[];
}

export interface DatasetPlane {
	coordinates: Record<string, number>;
	resourceUri: string;
	format: DatasetSourceFormat;
	pageIndex?: number;
	frameIndex?: number;
}

export interface DatasetSeries {
	id: string;
	label: string;
	axes: DatasetAxis[];
	planes: DatasetPlane[];
}

/** A logical dataset whose planes may be distributed across physical files. */
export interface DatasetManifest {
	id: string;
	kind: DatasetKind;
	label: string;
	series: DatasetSeries[];
	initialSeriesIndex?: number;
	initialCoordinates?: Record<string, number>;
}

export interface WebviewDatasetPlane extends DatasetPlane {
	src: string;
}

export interface WebviewDatasetSeries extends Omit<DatasetSeries, 'planes'> {
	planes: WebviewDatasetPlane[];
}

export interface WebviewDatasetManifest extends Omit<DatasetManifest, 'series'> {
	series: WebviewDatasetSeries[];
}
