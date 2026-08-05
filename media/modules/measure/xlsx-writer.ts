"use strict";

import { writeRoiZip } from './imagej-roi.js';

/**
 * Minimal `.xlsx` writer.
 *
 * An `.xlsx` file is a ZIP of XML parts, and the ZIP writer already exists for
 * `RoiSet.zip`, so this costs one small module rather than a dependency.
 *
 * Why bother when CSV exists: CSV forces an import dialog, and German-locale
 * Excel silently reinterprets `412.7` as a date. That misparse is itself one of
 * the reasons measurement results get retyped by hand, so writing a real
 * spreadsheet removes a failure mode rather than adding a convenience.
 *
 * Only what a results table needs is emitted: one sheet, a header row, inline
 * strings, and numbers. No styles, no shared-string table, no formulas.
 */

export type CellValue = string | number | null | undefined;

function escapeXml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		// Control characters are illegal in XML 1.0 and would make Excel refuse
		// the whole file; drop them rather than producing an unopenable export.
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** Convert a zero-based column index to a spreadsheet column name (A, B, …). */
function columnName(index: number): string {
	let name = '';
	let value = index;
	do {
		name = String.fromCharCode(65 + (value % 26)) + name;
		value = Math.floor(value / 26) - 1;
	} while (value >= 0);
	return name;
}

function cellXml(row: number, column: number, value: CellValue): string {
	if (value === null || value === undefined || value === '') { return ''; }
	const reference = `${columnName(column)}${row}`;
	if (typeof value === 'number') {
		// Excel has no representation for NaN or Infinity in a numeric cell, so
		// they become text and stay visible instead of turning into zeros.
		if (!Number.isFinite(value)) {
			const text = Number.isNaN(value) ? 'NaN' : (value > 0 ? 'Inf' : '-Inf');
			return `<c r="${reference}" t="inlineStr"><is><t>${text}</t></is></c>`;
		}
		return `<c r="${reference}"><v>${value}</v></c>`;
	}
	return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
}

export interface SheetData {
	name: string;
	rows: CellValue[][];
}

/** Build a single-sheet workbook. */
export function buildXlsx(sheet: SheetData): Uint8Array {
	const encoder = new TextEncoder();
	const sheetName = escapeXml(sheet.name.replace(/[\\/*?:[\]]/g, '_').slice(0, 31) || 'Results');

	const rowsXml = sheet.rows.map((cells, rowIndex) => {
		const rowNumber = rowIndex + 1;
		const cellsXml = cells.map((value, columnIndex) => cellXml(rowNumber, columnIndex, value)).join('');
		return `<row r="${rowNumber}">${cellsXml}</row>`;
	}).join('');

	const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;

	const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

	const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

	const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

	const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;

	return writeRoiZip([
		{ name: '[Content_Types].xml', bytes: encoder.encode(contentTypesXml) },
		{ name: '_rels/.rels', bytes: encoder.encode(rootRelsXml) },
		{ name: 'xl/workbook.xml', bytes: encoder.encode(workbookXml) },
		{ name: 'xl/_rels/workbook.xml.rels', bytes: encoder.encode(workbookRelsXml) },
		{ name: 'xl/worksheets/sheet1.xml', bytes: encoder.encode(sheetXml) },
	]);
}
