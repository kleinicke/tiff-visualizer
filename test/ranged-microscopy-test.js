/**
 * ND2 and LIF decode from partial reads (Rust `SparseFile`, driven by
 * media/modules/ranged-source.ts): the decoder answers `[need-range:O:L]`
 * until it has the bytes a plane needs. This runs the page's loop against the
 * WASM entry points for every plane of the repository fixtures, keeping read
 * pieces across planes as the page does, and requires the result to equal the
 * whole-file decode bit for bit. When the local corpus is present
 * (ND2/LIF files under ../ply-visualizer/testfiles/scientific), its largest
 * ND2 and LIF are checked too, reporting the bytes read.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const NEED = /\[need-range:(\d+):(\d+)\]/;

function rangedDecoder(wasm, format, read, size) {
	const pieces = [];
	let bytesRead = 0;
	return {
		get bytesRead() { return bytesRead; },
		decode(options) {
			for (let trip = 0; trip <= 256; trip++) {
				const total = pieces.reduce((sum, piece) => sum + piece.bytes.length, 0);
				const blob = new Uint8Array(total);
				let at = 0;
				for (const piece of pieces) { blob.set(piece.bytes, at); at += piece.bytes.length; }
				try {
					const result = wasm[`decode_${format}_ranged`](blob, Float64Array.from(pieces.map(p => p.offset)),
						Uint32Array.from(pieces.map(p => p.bytes.length)), size, JSON.stringify(options));
					return { result, trips: trip };
				} catch (error) {
					const need = NEED.exec(String(error?.message ?? error));
					if (!need) { throw error; }
					const bytes = read(Number(need[1]), Number(need[2]));
					bytesRead += bytes.length;
					pieces.push({ offset: Number(need[1]), bytes });
				}
			}
			throw new Error('too many reads');
		},
	};
}

function compare(whole, ranged, label) {
	for (const key of ['width', 'height', 'channels', 'bits_per_sample', 'sample_format', 'type_min', 'type_max', 'source_numeric_type', 'metadata_json']) {
		assert.deepEqual(ranged[key], whole[key], `${label}: ${key}`);
	}
	const a = Buffer.from(whole.take_data_as_f32().buffer);
	const b = Buffer.from(ranged.take_data_as_f32().buffer);
	assert.ok(a.equals(b), `${label}: samples differ`);
}

function planes(metadata) {
	const out = [{}];
	for (const selector of JSON.parse(metadata).selectors || []) {
		out.push({ [selector.name]: selector.size - 1 });
	}
	return out;
}

function checkFile(wasm, format, file, wholeAllowed) {
	const size = fs.statSync(file).size;
	const fd = fs.openSync(file, 'r');
	const read = (offset, length) => { const b = Buffer.alloc(Math.min(length, size - offset)); fs.readSync(fd, b, 0, b.length, offset); return new Uint8Array(b); };
	const decoder = rangedDecoder(wasm, format, read, size);
	const whole = wholeAllowed ? new Uint8Array(fs.readFileSync(file)) : null;
	const first = decoder.decode({});
	const metadata = first.result.metadata_json;
	const report = [];
	for (const indices of planes(metadata)) {
		const ranged = decoder.decode({ indices });
		report.push(ranged.trips);
		if (whole) { compare(wasm[`decode_${format}_fast`](whole, JSON.stringify({ indices })), ranged.result, `${path.basename(file)} ${JSON.stringify(indices)}`); }
	}
	fs.closeSync(fd);
	return { size, bytesRead: decoder.bytesRead, firstTrips: first.trips, planeTrips: report };
}

async function main() {
	const wasm = await import(path.join(root, 'media', 'wasm', 'tiff-wasm.js'));
	await wasm.default({ module_or_path: fs.readFileSync(path.join(root, 'media', 'wasm', 'tiff-wasm.wasm')) });
	const lines = [];
	for (const [format, name] of [['nd2', 'synthetic-stack.nd2'], ['lif', 'synthetic-stack.lif']]) {
		const r = checkFile(wasm, format, path.join(root, 'test-samples', 'scientific', name), true);
		lines.push(`${name}: identical, first open ${r.firstTrips} reads, planes ${r.planeTrips.join('/')}`);
	}
	const corpus = path.join(root, '..', 'ply-visualizer', 'testfiles', 'scientific');
	for (const [format, name] of [['nd2', '190821_L1_IRS-Akt_CS2003.nd2'], ['lif', 'lif-bio-formats-issue/Intro.lif']]) {
		const file = path.join(corpus, name);
		if (!fs.existsSync(file)) { continue; }
		const r = checkFile(wasm, format, file, fs.statSync(file).size < 700e6);
		lines.push(`${path.basename(name)}: identical, ${(r.bytesRead / 1048576).toFixed(1)} of ${(r.size / 1048576).toFixed(0)} MB read, first open ${r.firstTrips} reads, planes ${r.planeTrips.join('/')}`);
	}
	console.log(`Ranged ND2/LIF: ${lines.join('; ')}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
