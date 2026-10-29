/** Conversions from decoded column values (shared by the Parquet reader and the table). */

/** Numbers from a decoded column; bigint (INT64) and missing values are handled. */
export function toFloat64(values: ArrayLike<unknown>): Float64Array {
	const out = new Float64Array(values.length);
	for (let index = 0; index < values.length; index++) {
		const value = values[index];
		out[index] = typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : value === null || value === undefined ? NaN : Number(value);
	}
	return out;
}

export function toStrings(values: ArrayLike<unknown>): string[] {
	const out = new Array<string>(values.length);
	for (let index = 0; index < values.length; index++) {
		const value = values[index];
		out[index] = value === null || value === undefined ? '' : String(value);
	}
	return out;
}

/** Kind of a decoded column, from its first present value. */
export function columnKind(values: ArrayLike<unknown>): 'string' | 'integer' | 'float' | 'boolean' | 'empty' {
	for (let index = 0; index < values.length; index++) {
		const value = values[index];
		if (value === null || value === undefined) { continue; }
		if (typeof value === 'string') { return 'string'; }
		if (typeof value === 'boolean') { return 'boolean'; }
		if (typeof value === 'bigint') { return 'integer'; }
		if (typeof value === 'number') { return 'float'; }
		return 'string';
	}
	return 'empty';
}
