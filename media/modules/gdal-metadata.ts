"use strict";

import type { TagEntry } from './tiff-tag-utils.js';

/**
 * GDAL's per-band metadata (TIFF tag 42112, `GDALMetadata`).
 *
 * GDAL stores what a band's numbers MEAN in an XML blob in the IFD:
 *
 *     <GDALMetadata>
 *       <Item name="OFFSET" sample="0" role="offset">0</Item>
 *       <Item name="SCALE" sample="0" role="scale">0.001</Item>
 *       <Item name="DESCRIPTION" sample="0" role="description">yearly rate</Item>
 *     </GDALMetadata>
 *
 * Ignoring it makes the viewer disagree with every other tool that reads the
 * file: where GDAL, QGIS and rasterio report 1.234, a reader that skips the
 * scale reports 1234, and nothing on screen explains the factor of a thousand.
 *
 * Parsing stays in TypeScript for the same reason OME-XML does (see
 * media/modules/ome-tiff.ts): the byte-level extraction is already Rust's — the
 * tag arrives as text in the tag dump — and what is left is mapping XML onto a
 * typed model that only the UI consumes.
 *
 * Scale and offset are applied to REPORTED values (pixel readout, statistics
 * shown as physical units), never to the render pipeline: normalization ranges,
 * histograms and exported pixels stay in the file's own units, so what the
 * viewer draws is always what the file stores.
 */

export interface GdalBandMetadata {
	/** Zero-based sample index within the pixel. */
	sample: number;
	/** Physical value = raw * scale + offset. Absent means 1. */
	scale?: number;
	/** Absent means 0. */
	offset?: number;
	description?: string;
	unit?: string;
}

export interface GdalMetadata {
	bands: GdalBandMetadata[];
	/** Items with no `sample` attribute — dataset-level, e.g. AREA_OR_POINT. */
	dataset: Record<string, string>;
}

const EMPTY: GdalMetadata = { bands: [], dataset: {} };

/** Physical value for a raw sample, or the raw value when nothing is declared. */
export function applyBandScaling(metadata: GdalMetadata | null, sample: number, value: number): number {
	const band = metadata?.bands.find(entry => entry.sample === sample);
	if (!band) { return value; }
	return value * (band.scale ?? 1) + (band.offset ?? 0);
}

/** Whether any band rescales its values, i.e. whether raw and physical differ. */
export function hasBandScaling(metadata: GdalMetadata | null): boolean {
	return !!metadata?.bands.some(band =>
		(band.scale !== undefined && band.scale !== 1) || (band.offset !== undefined && band.offset !== 0));
}

/** A band's name for the channels panel, or '' when the file names none. */
export function bandDescription(metadata: GdalMetadata | null, sample: number): string {
	return metadata?.bands.find(entry => entry.sample === sample)?.description || '';
}

function bandFor(bands: Map<number, GdalBandMetadata>, sample: number): GdalBandMetadata {
	let band = bands.get(sample);
	if (!band) {
		band = { sample };
		bands.set(sample, band);
	}
	return band;
}

/**
 * Parse the XML text of a GDALMetadata tag. Written against the structure GDAL
 * emits rather than as a general XML reader: a flat list of `<Item>` elements.
 * Anything unrecognized is ignored rather than rejected — the tag is a
 * free-form metadata store, and readers meet items no version of GDAL wrote.
 */
export function parseGdalMetadataXml(xml: string | undefined | null): GdalMetadata {
	if (!xml || !/<GDALMetadata/i.test(xml)) { return { bands: [], dataset: {} }; }
	const bands = new Map<number, GdalBandMetadata>();
	const dataset: Record<string, string> = {};

	const itemPattern = /<Item\b([^>]*)>([\s\S]*?)<\/Item>/gi;
	let match: RegExpExecArray | null;
	while ((match = itemPattern.exec(xml)) !== null) {
		const attributes = match[1];
		const text = match[2].trim();
		const attribute = (name: string): string | undefined => {
			const found = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attributes);
			return found ? found[1] : undefined;
		};
		const name = (attribute('name') || '').toUpperCase();
		const sampleAttribute = attribute('sample');
		if (sampleAttribute === undefined) {
			if (name) { dataset[name] = text; }
			continue;
		}
		const sample = Number(sampleAttribute);
		if (!Number.isFinite(sample) || sample < 0) { continue; }

		// GDAL writes both a `role` and a conventional `name`; either is enough
		// to identify the item, and files in the wild carry one or the other.
		const role = (attribute('role') || '').toLowerCase();
		const numeric = Number(text);
		if (role === 'scale' || name === 'SCALE') {
			if (Number.isFinite(numeric)) { bandFor(bands, sample).scale = numeric; }
		} else if (role === 'offset' || name === 'OFFSET') {
			if (Number.isFinite(numeric)) { bandFor(bands, sample).offset = numeric; }
		} else if (role === 'description' || name === 'DESCRIPTION') {
			if (text) { bandFor(bands, sample).description = text; }
		} else if (role === 'unittype' || name === 'UNITTYPE' || name === 'UNITS') {
			if (text) { bandFor(bands, sample).unit = text; }
		}
	}

	return {
		bands: [...bands.values()].sort((a, b) => a.sample - b.sample),
		dataset,
	};
}

/**
 * Find the GDALMetadata tag in a parsed tag list and read it. Matching follows
 * `parseGdalNodata`: the numeric id on the Rust/WASM path, the name on the
 * geotiff.js fallback path, which carries no ids.
 */
export function parseGdalMetadata(tags: TagEntry[]): GdalMetadata {
	if (!Array.isArray(tags)) { return EMPTY; }
	for (const tag of tags) {
		const name = String(tag?.name || '');
		const unknownMatch = /unknown\((\d+)\)/i.exec(name);
		const matchesByNumber = tag?.tag === 42112 ||
			(!!unknownMatch && Number(unknownMatch[1]) === 42112);
		if (!matchesByNumber && !/^gdal_?metadata$/i.test(name)) { continue; }
		const parsed = parseGdalMetadataXml(String(tag.value));
		if (parsed.bands.length || Object.keys(parsed.dataset).length) { return parsed; }
	}
	return EMPTY;
}
