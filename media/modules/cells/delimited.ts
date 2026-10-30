/**
 * Comma-, tab- or semicolon-separated tables (CSV/TSV exports of per-cell measurements) as named
 * columns, in the shapes `buildCellTable` expects: text stays text, whole numbers are bigints
 * (so a column with few distinct values becomes categories), other numbers are doubles.
 */

const MISSING = new Set(['', 'na', 'n/a', 'nan', 'null', 'none']);
const DELIMITERS = [',', '\t', ';'];

export interface Delimited {
	header: string[];
	/** Raw cell text by column, in header order. */
	raw: string[][];
}

/** The delimiter that splits the header line into the most fields, ignoring quoted text. */
export function detectDelimiter(line: string): string {
	let best = ',', most = 0;
	for (const candidate of DELIMITERS) {
		let count = 0, quoted = false;
		for (const char of line) {
			if (char === '"') { quoted = !quoted; } else if (char === candidate && !quoted) { count++; }
		}
		if (count > most) { most = count; best = candidate; }
	}
	return best;
}

export function parseDelimited(input: string): Delimited {
	const text = input.charCodeAt(0) === 0xFEFF ? input.slice(1) : input;
	const firstLineEnd = text.search(/\r|\n/);
	const delimiter = detectDelimiter(firstLineEnd < 0 ? text : text.slice(0, firstLineEnd));
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	const endField = (): void => { row.push(field); field = ''; };
	const endRow = (): void => { endField(); if (row.length > 1 || row[0] !== '') { rows.push(row); } row = []; };
	for (let at = 0; at < text.length; at++) {
		const char = text[at];
		if (quoted) {
			if (char === '"') { if (text[at + 1] === '"') { field += '"'; at++; } else { quoted = false; } } else { field += char; }
		} else if (char === '"' && field === '') { quoted = true; }
		else if (char === delimiter) { endField(); }
		else if (char === '\n') { endRow(); }
		else if (char === '\r') { if (text[at + 1] === '\n') { at++; } endRow(); }
		else { field += char; }
	}
	if (field !== '' || row.length > 0) { endRow(); }
	if (rows.length === 0) { return { header: [], raw: [] }; }
	const header = rows[0].map((name, index) => name.trim() || `column ${index + 1}`);
	const raw = header.map(() => new Array<string>(rows.length - 1));
	for (let r = 1; r < rows.length; r++) {
		for (let c = 0; c < header.length; c++) { raw[c][r - 1] = rows[r][c] ?? ''; }
	}
	return { header, raw };
}

export const isMissing = (value: string): boolean => MISSING.has(value.trim().toLowerCase());

/** A column as numbers when every present value is one, else as text; blank, NA and NaN are missing. */
export function typedColumn(values: readonly string[]): Float64Array | (bigint | null)[] | (string | null)[] {
	let numeric = true, whole = true;
	for (const value of values) {
		if (isMissing(value)) { continue; }
		const number = Number(value);
		if (value.trim() === '' || !Number.isFinite(number)) { numeric = false; break; }
		if (!Number.isInteger(number) || !/^[+-]?\d+$/.test(value.trim())) { whole = false; }
	}
	if (!numeric) { return values.map(value => isMissing(value) ? null : value); }
	if (whole && values.some(value => !isMissing(value))) {
		return values.map(value => isMissing(value) ? null : BigInt(value.trim().replace(/^\+/, '')));
	}
	return Float64Array.from(values, value => isMissing(value) ? NaN : Number(value));
}
