'use strict';

/**
 * The DICOM -> NRRD -> 3D viewer bridge.
 *
 * The point of this test is the *handover*, not the decoding: it builds a
 * volume the way the command does, then reads the resulting NRRD back with
 * ply-visualizer's own parser where that repository is present. A contract
 * spanning two repositories is exactly the thing that breaks silently, so it
 * is checked against the real reader rather than against this file's idea of
 * what the reader wants.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Module = require('module');
const ts = require('typescript');
const { URI } = require('vscode-uri');

const REAL_DICOM_FOLDER = '/Users/florian/Projects/cursor/test_data/testfiles/scientific/MRT OSG Februar 2023';
const PLY_VISUALIZER = path.join(__dirname, '..', '..', 'ply-visualizer');

function transpile(sourcePath) {
	const source = fs.readFileSync(sourcePath, 'utf8');
	return ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
		fileName: sourcePath,
	}).outputText;
}

/** Loads a TypeScript module from src/ with `vscode` stubbed out to the real filesystem. */
function loadWithVscodeStub(relativePath) {
	const sourcePath = path.join(__dirname, '..', relativePath);
	const vscodeStub = {
		Uri: URI,
		FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
		workspace: {
			fs: {
				async readDirectory(uri) {
					return (await fs.promises.readdir(uri.fsPath, { withFileTypes: true }))
						.map(entry => [entry.name, entry.isDirectory() ? 2 : 1]);
				},
				async readFile(uri) { return new Uint8Array(await fs.promises.readFile(uri.fsPath)); },
				async writeFile(uri, data) { return fs.promises.writeFile(uri.fsPath, data); },
				async createDirectory(uri) { return fs.promises.mkdir(uri.fsPath, { recursive: true }); },
				async stat(uri) {
					const stats = await fs.promises.stat(uri.fsPath);
					return { type: stats.isDirectory() ? 2 : 1, size: stats.size, ctime: 0, mtime: 0 };
				},
			},
		},
		window: {},
		commands: {},
		extensions: {},
	};

	const originalLoad = Module._load;
	const originalCompile = Module._extensions['.js'];
	Module._load = function (request, parent, isMain) {
		if (request === 'vscode') { return vscodeStub; }
		// Relative .ts imports have to be transpiled the same way.
		if (request.startsWith('.') && parent) {
			const resolved = path.resolve(path.dirname(parent.filename), request);
			for (const candidate of [`${resolved}.ts`, path.join(resolved, 'index.ts')]) {
				if (fs.existsSync(candidate)) {
					const cached = Module._cache[candidate];
					if (cached) { return cached.exports; }
					const child = new Module(candidate, parent);
					child.filename = candidate;
					child.paths = Module._nodeModulePaths(path.dirname(candidate));
					Module._cache[candidate] = child;
					child._compile(transpile(candidate), candidate);
					child.loaded = true;
					return child.exports;
				}
			}
		}
		return originalLoad.call(this, request, parent, isMain);
	};
	try {
		const loaded = new Module(sourcePath, module);
		loaded.filename = sourcePath;
		loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
		Module._cache[sourcePath] = loaded;
		loaded._compile(transpile(sourcePath), sourcePath);
		return loaded.exports;
	} finally {
		Module._load = originalLoad;
		Module._extensions['.js'] = originalCompile;
	}
}

/** Reads an NRRD header without needing the other repository. */
function readNrrdHeader(bytes) {
	const text = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 4096))).toString('latin1');
	const end = text.indexOf('\n\n');
	assert.ok(end > 0, 'NRRD header should terminate with a blank line');
	const header = {};
	for (const line of text.slice(0, end).split('\n').slice(1)) {
		const kv = line.indexOf(':=');
		if (kv > 0) { header[line.slice(0, kv).trim()] = line.slice(kv + 2).trim(); continue; }
		const colon = line.indexOf(':');
		if (colon > 0) { header[line.slice(0, colon).trim()] = line.slice(colon + 1).trim(); }
	}
	return { header, dataStart: end + 2 };
}

function testDeriveGeometry(deriveGeometry) {
	// PixelSpacing is [between rows, between columns]. Between-rows is a step
	// along the *column* direction, so anisotropic pixels catch a swap.
	const axial = {
		orientation: [1, 0, 0, 0, 1, 0],
		pixelSpacing: [0.5, 0.75],
		position: [-100, -100, 0],
		sliceThickness: 5,
	};
	const last = { ...axial, position: [-100, -100, 60] };
	const geometry = deriveGeometry(axial, last, 31);

	assert.deepStrictEqual(geometry.iVector, [0.00075, 0, 0], 'i axis follows the row direction in metres');
	assert.deepStrictEqual(geometry.jVector, [0, 0.0005, 0], 'j axis follows the column direction in metres');
	// 60 mm over 30 gaps is 2 mm, which is NOT the 5 mm SliceThickness claims -
	// exactly the overlap case thickness gets wrong.
	assert.ok(Math.abs(geometry.kVector[2] - 0.002) < 1e-9, `k step should be 0.002 m, got ${geometry.kVector[2]}`);
	assert.deepStrictEqual(geometry.origin, [-0.1, -0.1, 0]);
	assert.strictEqual(geometry.kSource, 'positions');
	console.log('✅ deriveGeometry: spacing cross-assignment and measured slice step');

	// Without usable positions it must fall back and say so, rather than
	// silently claiming millimetres it never measured.
	const single = deriveGeometry(axial, axial, 1);
	assert.strictEqual(single.kSource, 'sliceThickness');
	assert.ok(Math.abs(single.kVector[2] - 0.005) < 1e-9);

	const bare = deriveGeometry({ orientation: [1, 0, 0, 0, 1, 0] }, {}, 1);
	assert.strictEqual(bare.kSource, 'assumed');
	console.log('✅ deriveGeometry: reports when slice spacing had to be guessed');

	// An oblique series must keep its rotation, not be flattened to axis-aligned.
	const oblique = deriveGeometry(
		{ orientation: [0.9848, 0.1736, 0, 0, 0, -1], pixelSpacing: [1, 1], position: [0, 0, 0], sliceThickness: 1 },
		{ orientation: [0.9848, 0.1736, 0, 0, 0, -1], position: [0, 0, -10] },
		11,
	);
	assert.ok(Math.abs(oblique.iVector[1] - 0.0001736) < 1e-9, 'oblique row direction should survive');
	assert.ok(Math.abs(oblique.jVector[2] + 0.001) < 1e-9, 'oblique column direction should survive');
	console.log('✅ deriveGeometry: oblique orientation preserved');
}

async function testWriteNrrd(writeNrrd) {
	const samples = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
	const geometry = {
		iVector: [0.0007, 0, 0],
		jVector: [0, 0.0007, 0],
		kVector: [0, 0, 0.0025],
		origin: [-0.01, -0.02, 0.03],
		kSource: 'positions',
	};
	const bytes = await writeNrrd(samples, [2, 2, 2], geometry, { units: 'HU', modality: 'CT' });
	const { header, dataStart } = readNrrdHeader(bytes);

	assert.strictEqual(header['type'], 'float');
	assert.strictEqual(header['sizes'], '2 2 2');
	assert.strictEqual(header['encoding'], 'gzip');
	assert.strictEqual(header['space'], 'left-posterior-superior');
	assert.strictEqual(header['space directions'], '(0.0007,0,0) (0,0.0007,0) (0,0,0.0025)');
	assert.strictEqual(header['space origin'], '(-0.01,-0.02,0.03)');
	assert.strictEqual(header['space units'], '"m" "m" "m"');
	assert.strictEqual(header['units'], 'HU');
	assert.strictEqual(header['modality'], 'CT');

	// gunzipSync returns a Buffer backed by a pooled ArrayBuffer, so the view's
	// offset has to be respected; reading `.buffer` directly yields the pool.
	const payload = zlib.gunzipSync(Buffer.from(bytes.subarray(dataStart)));
	const decoded = new Float32Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));
	assert.deepStrictEqual(Array.from(decoded), Array.from(samples));
	console.log('✅ writeNrrd: header fields and gzip payload round-trip');
}

/** Reads the produced file back with the consumer's own parser. */
async function testAgainstRealReader(bytes, expected) {
	const parserPath = path.join(PLY_VISUALIZER, 'out', 'engine', 'src', 'parsers', 'nrrdParser.js');
	if (!fs.existsSync(parserPath)) {
		console.log('⏭️  ply-visualizer is not built; skipping the cross-repository round-trip');
		return;
	}
	const { NrrdParser } = require(parserPath);
	const volume = await new NrrdParser().parse(bytes, 'bridge.nrrd');

	assert.deepStrictEqual(volume.sizes, expected.sizes);
	assert.strictEqual(volume.samples.length, expected.sizes[0] * expected.sizes[1] * expected.sizes[2]);

	// LPS in the file, RAS in the reader: x and y negate, z does not.
	assert.ok(Math.abs(volume.ijkToWorld[0] + expected.geometry.iVector[0]) < 1e-6,
		`i vector x should negate: file ${expected.geometry.iVector[0]}, read ${volume.ijkToWorld[0]}`);
	assert.ok(Math.abs(volume.ijkToWorld[10] - expected.geometry.kVector[2]) < 1e-6,
		`k vector z should pass through: file ${expected.geometry.kVector[2]}, read ${volume.ijkToWorld[10]}`);
	assert.strictEqual(volume.spaceUnits, 'm');
	console.log(`✅ Round-trip through ply-visualizer's NrrdParser: ${volume.sizes.join('x')} in ${volume.spaceUnits}`);
	return volume;
}

async function main() {
	const { deriveGeometry, writeNrrd, buildVolumeFromSeries } = loadWithVscodeStub('src/imagePreview/volumeExport.ts');

	testDeriveGeometry(deriveGeometry);
	await testWriteNrrd(writeNrrd);

	// A synthetic series proves the assembly path without needing fixtures.
	const syntheticGeometry = {
		iVector: [0.6, 0, 0], jVector: [0, 0.6, 0], kVector: [0, 0, 3],
		origin: [-15, -25, 7], kSource: 'positions',
	};
	const syntheticSamples = new Float32Array(4 * 4 * 3);
	for (let i = 0; i < syntheticSamples.length; i++) { syntheticSamples[i] = i - 1000; }
	const syntheticBytes = await writeNrrd(syntheticSamples, [4, 4, 3], syntheticGeometry, { units: 'HU' });
	const syntheticVolume = await testAgainstRealReader(syntheticBytes, { sizes: [4, 4, 3], geometry: syntheticGeometry });
	if (syntheticVolume) {
		assert.strictEqual(syntheticVolume.intensityUnits, 'HU', 'HU must survive the handover');
		assert.strictEqual(syntheticVolume.samples[0], -1000);
		assert.strictEqual(syntheticVolume.samples[syntheticSamples.length - 1], syntheticSamples.length - 1001);
		console.log('✅ Sample values and intensity units survive the handover unchanged');
	}

	if (!fs.existsSync(REAL_DICOM_FOLDER)) {
		console.log('⏭️  Real DICOM folder not present; skipping the end-to-end export');
		console.log('\n✅ Volume export tests passed');
		return;
	}

	const { scanDicomFolder } = loadWithVscodeStub('src/imagePreview/dicomDataset.ts');
	const manifest = await scanDicomFolder(URI.file(REAL_DICOM_FOLDER));
	const series = manifest.series[0];

	const result = await buildVolumeFromSeries(series);
	assert.strictEqual(result.sizes[2], series.planes.length, 'every slice should reach the volume');
	assert.ok(result.sizes[0] > 0 && result.sizes[1] > 0);
	// This is an MR series, so it must NOT be labelled Hounsfield.
	assert.strictEqual(result.intensityUnits, undefined, 'only CT carries HU');
	assert.strictEqual(result.geometry.kSource, 'positions', 'a real series has measurable slice spacing');
	console.log(`✅ Real MR series exported: ${result.sizes.join('x')}, modality ${result.modality}`);

	const remainingSizes = [];
	for (const candidate of manifest.series.slice(1)) {
		const candidateResult = await buildVolumeFromSeries(candidate);
		assert.strictEqual(
			candidateResult.sizes[2],
			candidate.planes.length,
			`every slice from ${candidate.label} should reach its volume`,
		);
		remainingSizes.push(candidateResult.sizes.join('x'));
	}
	assert.strictEqual(remainingSizes.length + 1, manifest.series.length);
	console.log(`✅ Every DICOM series exports independently: ${[result.sizes.join('x'), ...remainingSizes].join(', ')}`);

	const volume = await testAgainstRealReader(result.bytes, result);
	if (volume) {
		const isosurfacePath = path.join(PLY_VISUALIZER, 'out', 'engine', 'src', 'visualization', 'isosurface.js');
		if (fs.existsSync(isosurfacePath)) {
			const { buildVolumeMesh } = require(isosurfacePath);
			const { data, threshold } = buildVolumeMesh(volume);
			assert.ok(data.faceCount > 0, 'a real MR volume should yield a non-empty isosurface');
			console.log(`✅ Isosurface from the handed-over volume: ${data.faceCount.toLocaleString()} triangles at ${threshold.toFixed(0)}`);
		}
	}

	console.log('\n✅ Volume export tests passed');
}

main().catch(error => {
	console.error('❌ Volume export test failed:', error);
	process.exit(1);
});
