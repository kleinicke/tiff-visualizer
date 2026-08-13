/**
 * Read/write helpers for the golden JSON files under test/goldens/, used by
 * scripts/capture-goldens.js (writer) and the three rewired conformance
 * suites (reader).
 *
 * The whole point of these goldens is to freeze today's Rust/WASM output so
 * that later, when the TypeScript parsers are deleted and the TS-vs-Rust
 * comparison goes with them, a regression in the Rust decoders is still
 * caught. That only works if non-finite values and -0 survive the JSON
 * round-trip EXACTLY — JSON itself cannot represent NaN/+-Infinity, and a
 * naive `JSON.stringify`/`Number()` round-trip silently corrupts NaN -> null
 * and -0 -> 0. This module is the one place that encoding/decoding happens.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');

const goldensDir = path.join(__dirname, '..', 'goldens');
const externalGoldensDir = path.join(goldensDir, 'external');

function goldenDir(external) {
	return external ? externalGoldensDir : goldensDir;
}

function goldenPath(id, external) {
	return path.join(goldenDir(external), `${id}.json`);
}

/** Encodes a single numeric sample for JSON. Order of checks matters:
 * Number.isNaN before !Number.isFinite (Infinity is finite=false but not
 * NaN), and Object.is(v, -0) must be checked before the generic numeric
 * case, since `-0 === 0` is true in JS and would otherwise be lost. */
function encodeValue(v) {
	if (typeof v !== 'number') { throw new Error(`golden-io: encodeValue expected a number, got ${typeof v}`); }
	if (Number.isNaN(v)) { return 'NaN'; }
	if (v === Infinity) { return 'Infinity'; }
	if (v === -Infinity) { return '-Infinity'; }
	if (Object.is(v, -0)) { return '-0'; }
	return v;
}

/** Inverse of encodeValue. */
function decodeValue(v) {
	if (v === 'NaN') { return NaN; }
	if (v === 'Infinity') { return Infinity; }
	if (v === '-Infinity') { return -Infinity; }
	if (v === '-0') { return -0; }
	if (typeof v !== 'number') { throw new Error(`golden-io: decodeValue got unexpected encoded value ${JSON.stringify(v)}`); }
	return v;
}

/** Picks ~`count` indices spread evenly across [0, length), always including
 * index 0 and index length-1 (deduplicated, ascending). Used both to choose
 * which samples get captured into the golden's `samples` array and, at
 * comparison time, which live-decoded samples to check against it. */
function spreadIndices(length, count = 24) {
	if (length <= 0) { return []; }
	if (length <= count) { return Array.from({ length }, (_, i) => i); }
	const indices = new Set();
	indices.add(0);
	indices.add(length - 1);
	for (let i = 0; i < count; i++) {
		const idx = Math.floor((i * (length - 1)) / (count - 1));
		indices.add(idx);
	}
	return Array.from(indices).sort((a, b) => a - b);
}

/** Builds the `samples` array for a golden: [{i, v}, ...] with `v` encoded
 * via encodeValue. `typedArray` must be the SAME reference used for every
 * other read of this decode result — take_data_as_* methods on the wasm
 * result objects are destructive (a second call returns an empty vector),
 * so callers must decode once and reuse that array everywhere, including
 * here. */
function buildSamples(typedArray, indices) {
	return indices.map(i => ({ i, v: encodeValue(typedArray[i]) }));
}

/** Computes the digest over the RAW LITTLE-ENDIAN BYTES backing a typed
 * array (as returned by take_data_as_f32/u8/u16), not over any JSON/string
 * serialization of the numeric values. This is deliberate: it is the only
 * way to distinguish different NaN bit patterns and -0 from +0, both of
 * which collapse to indistinguishable values (or the same JSON encoding)
 * under a naive numeric digest. */
function computeDigest(typedArray) {
	const buf = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
	const hash = crypto.createHash('sha256').update(buf).digest('hex');
	return `sha256:${hash}`;
}

/**
 * Serializes a golden record to a JSON string with a FIXED key order (not
 * insertion order from object spreads elsewhere), so that
 * `npm run goldens:capture` run twice with nothing changed produces
 * byte-identical files. `record` fields not applicable to a given format are
 * simply omitted by the caller before this is invoked.
 */
function serializeGolden(record) {
	const KEY_ORDER = [
		'id', 'format', 'error',
		'width', 'height', 'channels',
		'metadata', 'numericDomain', 'formatLabel',
		'dataLength', 'dataDigest', 'data', 'samples',
	];
	const ordered = {};
	for (const key of KEY_ORDER) {
		if (Object.prototype.hasOwnProperty.call(record, key)) {
			ordered[key] = record[key];
		}
	}
	// JSON.stringify's float formatting is deterministic in V8 (shortest
	// round-tripping representation), so no manual number formatting is
	// introduced here — that would risk being the non-deterministic part.
	return JSON.stringify(ordered, null, 2) + '\n';
}

function writeGolden(id, external, record) {
	const dir = goldenDir(external);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(goldenPath(id, external), serializeGolden(record), 'utf8');
}

function readGolden(id, external) {
	const p = goldenPath(id, external);
	if (!fs.existsSync(p)) { return null; }
	return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Compares a LIVE decode result (from the Rust/WASM module, decoded by the
 * caller — same shape as scripts/capture-goldens.js's `decoded` object:
 * {width, height, channels, data, metadata?, numericDomain?, formatLabel?}
 * for a successful decode, or {error: string} for a rejected one) against
 * the stored golden for
 * `kase.id`/`kase.external`.
 *
 * Returns { kind: 'ok' }, or throws an Error whose message is prefixed with
 * either "[NO GOLDEN]" or "[GOLDEN MISMATCH]" — deliberately different
 * prefixes so a developer reading test output can immediately tell "no
 * golden captured yet, run `npm run goldens:capture`" apart from "the Rust
 * decoder's output actually changed since the golden was captured" without
 * reading any source.
 *
 * `live.data`, when present, must be the SAME typed-array reference the
 * caller used for every other comparison in this case (take_data_as_* is
 * destructive on the wasm result object — see decoder-cases.js/
 * capture-goldens.js file-header comments).
 */
/**
 * Whether a rejection is the expected outcome for this case.
 *
 * Two sources, because there are two kinds of negative case: synthesized ones
 * declare `expectError` up front, while some real corpus files are only known
 * to be unsupported empirically (a FITS holding only tables, a DICOM with a
 * compressed transfer syntax). For those the golden's recorded `error` is the
 * authority — that is exactly the verdict the golden exists to preserve.
 */
function expectsRejection(kase) {
	if (kase.expectError) { return true; }
	const golden = readGolden(kase.id, kase.external);
	return !!(golden && typeof golden.error === 'string');
}

function assertMatchesGolden(kase, live) {
	const golden = readGolden(kase.id, kase.external);
	if (golden === null) {
		throw new Error(
			`[NO GOLDEN] test/goldens/${kase.external ? 'external/' : ''}${kase.id}.json is missing. ` +
			`Run \`npm run goldens:capture\` to generate it.`
		);
	}

	const mismatch = (why) => {
		throw new Error(`[GOLDEN MISMATCH] ${kase.id}: ${why}`);
	};

	const goldenHasError = Object.prototype.hasOwnProperty.call(golden, 'error');
	const liveHasError = Object.prototype.hasOwnProperty.call(live, 'error');
	if (goldenHasError !== liveHasError) {
		mismatch(`golden ${goldenHasError ? 'records an error' : 'records success'} but live decode ` +
			`${liveHasError ? 'errored' : 'succeeded'}`);
	}
	if (goldenHasError) {
		if (golden.error !== live.error) {
			mismatch(`error text differs (golden="${golden.error}", live="${live.error}")`);
		}
		return { kind: 'ok' };
	}

	if (golden.width !== live.width) { mismatch(`width (golden=${golden.width}, live=${live.width})`); }
	if (golden.height !== live.height) { mismatch(`height (golden=${golden.height}, live=${live.height})`); }
	if (golden.channels !== live.channels) { mismatch(`channels (golden=${golden.channels}, live=${live.channels})`); }
	if (golden.formatLabel !== undefined && golden.formatLabel !== live.formatLabel) {
		mismatch(`formatLabel (golden=${golden.formatLabel}, live=${live.formatLabel})`);
	}
	if (golden.metadata !== undefined) {
		// Deep-equal, NOT a JSON.stringify string comparison: the Rust side's
		// metadata_json is serialized from a HashMap-backed structure whose
		// key order is not guaranteed stable across process runs (unlike a
		// BTreeMap) — same reason the TS-vs-Rust check elsewhere uses
		// assert.deepStrictEqual rather than a string compare. Only the
		// *values* are a correctness invariant, not JSON key order.
		if (!util.isDeepStrictEqual(golden.metadata, live.metadata)) {
			mismatch(`metadata differs (golden=${JSON.stringify(golden.metadata)}, live=${JSON.stringify(live.metadata)})`);
		}
	}
	if (golden.numericDomain !== undefined) {
		for (const key of Object.keys(golden.numericDomain)) {
			const g = golden.numericDomain[key];
			const l = live.numericDomain ? live.numericDomain[key] : undefined;
			if (!Object.is(g, l)) { mismatch(`numericDomain.${key} (golden=${g}, live=${l})`); }
		}
	}

	if (golden.dataLength !== live.data.length) {
		mismatch(`dataLength (golden=${golden.dataLength}, live=${live.data.length})`);
	}
	const liveDigest = computeDigest(live.data);
	if (golden.dataDigest !== liveDigest) {
		mismatch(`dataDigest (golden=${golden.dataDigest}, live=${liveDigest}) — sample data changed since capture`);
	}
	for (const { i, v } of golden.samples) {
		const expected = decodeValue(v);
		const actual = live.data[i];
		if (!Object.is(expected, actual)) {
			mismatch(`sample at index ${i} (golden=${expected}, live=${actual})`);
		}
	}

	return { kind: 'ok' };
}

module.exports = {
	goldensDir,
	externalGoldensDir,
	goldenDir,
	goldenPath,
	encodeValue,
	decodeValue,
	spreadIndices,
	buildSamples,
	computeDigest,
	serializeGolden,
	writeGolden,
	readGolden,
	expectsRejection,
	assertMatchesGolden,
};
