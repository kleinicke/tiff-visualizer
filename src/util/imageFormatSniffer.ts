/**
 * Small, conservative image signature detector shared by the extension host
 * and the standalone browser. It only returns a format when the leading bytes
 * are distinctive enough to override a filename. Ambiguous/headerless formats
 * deliberately return null and retain extension/native-browser routing.
 */

export interface DetectedImageFormat {
	/** A format-registry hint (normally its canonical extension). */
	hint: string;
	/** Extension used when a downloaded object needs a decoder-readable name. */
	extension: string;
	label: string;
}

export const IMAGE_HEADER_PROBE_BYTES = 4096;

function has(bytes: Uint8Array, offset: number, values: readonly number[]): boolean {
	if (offset < 0 || offset + values.length > bytes.length) { return false; }
	return values.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
	if (offset < 0 || offset + length > bytes.length) { return ''; }
	let value = '';
	for (let index = offset; index < offset + length; index++) {
		value += String.fromCharCode(bytes[index]);
	}
	return value;
}

function detected(hint: string, extension: string, label: string): DetectedImageFormat {
	return { hint, extension, label };
}

function sniffZip(bytes: Uint8Array): DetectedImageFormat | null {
	// ORA and KRA require an uncompressed `mimetype` first ZIP member. NPZ
	// normally starts with an .npy member. We inspect only that local header;
	// classifying every PK file as one of these formats would be dangerous.
	if (!has(bytes, 0, [0x50, 0x4b, 0x03, 0x04]) || bytes.length < 30) { return null; }
	const method = bytes[8] | (bytes[9] << 8);
	const nameLength = bytes[26] | (bytes[27] << 8);
	const extraLength = bytes[28] | (bytes[29] << 8);
	const name = ascii(bytes, 30, nameLength).replace(/\\/g, '/').toLowerCase();
	const payloadOffset = 30 + nameLength + extraLength;
	if (name === 'mimetype' && method === 0) {
		const payload = ascii(bytes, payloadOffset, Math.max(0, Math.min(64, bytes.length - payloadOffset)));
		if (payload.startsWith('image/openraster')) { return detected('ora', 'ora', 'OpenRaster'); }
		if (payload.startsWith('application/x-krita')) { return detected('kra', 'kra', 'Krita'); }
	}
	if (/(^|\/)[^/]+\.npy$/i.test(name)) { return detected('npz', 'npz', 'NumPy archive'); }
	return null;
}

export function sniffImageFormat(bytes: Uint8Array): DetectedImageFormat | null {
	if (has(bytes, 0, [0x49, 0x49, 0x2a, 0x00]) || has(bytes, 0, [0x4d, 0x4d, 0x00, 0x2a])
		|| has(bytes, 0, [0x49, 0x49, 0x2b, 0x00]) || has(bytes, 0, [0x4d, 0x4d, 0x00, 0x2b])) {
		return detected('tiff', 'tif', 'TIFF');
	}
	if (has(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
		return detected('png', 'png', 'PNG');
	}
	if (has(bytes, 0, [0xff, 0xd8, 0xff])) { return detected('jpg', 'jpg', 'JPEG'); }
	if (has(bytes, 0, [0x76, 0x2f, 0x31, 0x01])) { return detected('exr', 'exr', 'OpenEXR'); }
	if (has(bytes, 0, [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59])) { return detected('npy', 'npy', 'NumPy'); }
	if (ascii(bytes, 0, 10) === '#?RADIANCE' || ascii(bytes, 0, 6) === '#?RGBE') {
		return detected('hdr', 'hdr', 'Radiance HDR');
	}
	if ((ascii(bytes, 0, 2) === 'PF' || ascii(bytes, 0, 2) === 'Pf') && /\s/.test(ascii(bytes, 2, 1))) {
		return detected('pfm', 'pfm', 'PFM');
	}
	if (bytes[0] === 0x50 && bytes[1] >= 0x31 && bytes[1] <= 0x37 && /\s/.test(ascii(bytes, 2, 1))) {
		const extension = bytes[1] === 0x31 || bytes[1] === 0x34 ? 'pbm'
			: bytes[1] === 0x32 || bytes[1] === 0x35 ? 'pgm' : 'ppm';
		return detected(extension, extension, 'NetPBM');
	}
	if (ascii(bytes, 0, 2) === 'BM') { return detected('bmp', 'bmp', 'BMP'); }
	if (has(bytes, 0, [0x00, 0x00, 0x01, 0x00])) { return detected('ico', 'ico', 'ICO'); }
	if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
		return detected('webp', 'webp', 'WebP');
	}
	if (ascii(bytes, 4, 4) === 'ftyp') {
		const brands = ascii(bytes, 8, Math.min(48, bytes.length - 8));
		if (/(?:avif|avis)/.test(brands)) { return detected('avif', 'avif', 'AVIF'); }
	}
	if (has(bytes, 0, [0xff, 0x0a]) || has(bytes, 0, [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a])) {
		return detected('jxl', 'jxl', 'JPEG XL');
	}
	if (has(bytes, 0, [0x49, 0x49, 0xbc, 0x01])) { return detected('jxr', 'jxr', 'JPEG XR'); }
	if (has(bytes, 0, [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a])
		|| has(bytes, 0, [0xff, 0x4f, 0xff, 0x51])) {
		return detected('jp2', 'jp2', 'JPEG 2000');
	}
	if (ascii(bytes, 0, 9) === 'SIMPLE  =' || ascii(bytes, 0, 9) === 'XTENSION=') {
		return detected('fits', 'fits', 'FITS');
	}
	if (ascii(bytes, 128, 4) === 'DICM') { return detected('dicom', 'dcm', 'DICOM'); }
	if (ascii(bytes, 0, 3) === 'CDF' && [1, 2, 5].includes(bytes[3])) {
		return detected('netcdf', 'nc', 'NetCDF');
	}
	if (ascii(bytes, 0, 10) === 'ZISRAWFILE') { return detected('czi', 'czi', 'Zeiss CZI'); }
	if (has(bytes, 0, [0xda, 0xce, 0xbe, 0x0a])) { return detected('nd2', 'nd2', 'Nikon ND2'); }
	if (has(bytes, 0, [0x70, 0x00, 0x00, 0x00, 0x2a, 0x00, 0x00, 0x00])) {
		return detected('lif', 'lif', 'Leica LIF');
	}
	if (ascii(bytes, 0, 4) === '8BPS' && (has(bytes, 4, [0x00, 0x01]) || has(bytes, 4, [0x00, 0x02]))) {
		return bytes[5] === 0x02 ? detected('psb', 'psb', 'Photoshop Large') : detected('psd', 'psd', 'Photoshop');
	}
	if (ascii(bytes, 0, 9) === 'gimp xcf ') { return detected('xcf', 'xcf', 'GIMP XCF'); }
	return sniffZip(bytes);
}

/** Read at most `limit` bytes even when a server ignores the Range request. */
export async function readResponsePrefix(response: Response, limit = IMAGE_HEADER_PROBE_BYTES): Promise<Uint8Array> {
	if (!response.body) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		return bytes.subarray(0, limit);
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (length < limit) {
			const { done, value } = await reader.read();
			if (done) { break; }
			if (!value?.length) { continue; }
			const keep = value.subarray(0, Math.min(value.length, limit - length));
			chunks.push(keep);
			length += keep.length;
		}
	} finally {
		try { await reader.cancel(); } catch { /* the response may already be complete */ }
	}
	const prefix = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) { prefix.set(chunk, offset); offset += chunk.length; }
	return prefix;
}

export class ImageHeaderHttpError extends Error {
	constructor(readonly status: number, readonly statusText: string) {
		super(`header probe returned ${status} ${statusText}`);
		this.name = 'ImageHeaderHttpError';
	}
}

export async function sniffRemoteImageFormat(url: string, signal?: AbortSignal): Promise<DetectedImageFormat | null> {
	const response = await fetch(url, {
		signal,
		redirect: 'follow',
		headers: { Range: `bytes=0-${IMAGE_HEADER_PROBE_BYTES - 1}`, Accept: '*/*' },
	});
	if (!response.ok) { throw new ImageHeaderHttpError(response.status, response.statusText); }
	return sniffImageFormat(await readResponsePrefix(response));
}

const FORMAT_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
	tiff: ['tif', 'tiff', 'tf2', 'tf8', 'btf'], png: ['png'], jpg: ['jpg', 'jpeg'],
	exr: ['exr'], npy: ['npy'], npz: ['npz'], hdr: ['hdr'], pfm: ['pfm'],
	ppm: ['ppm'], pgm: ['pgm'], pbm: ['pbm'], bmp: ['bmp'], ico: ['ico'],
	webp: ['webp'], avif: ['avif'], jxl: ['jxl'], jxr: ['jxr', 'wdp', 'hdp'],
	jp2: ['jp2', 'jpf', 'jpx', 'j2k', 'j2c', 'jpc'], fits: ['fits', 'fit', 'fts'],
	dicom: ['dcm', 'dicom'], netcdf: ['nc', 'cdf'], czi: ['czi'], nd2: ['nd2'],
	lif: ['lif'], ora: ['ora'], kra: ['kra'], psd: ['psd'], psb: ['psb'], xcf: ['xcf'],
};

export function filenameForDetectedFormat(name: string, format: DetectedImageFormat): string {
	const lower = name.toLowerCase();
	const matches = (FORMAT_EXTENSIONS[format.hint] || [format.extension])
		.some(extension => lower.endsWith(`.${extension}`));
	return matches ? name : `${name || 'image'}.${format.extension}`;
}
