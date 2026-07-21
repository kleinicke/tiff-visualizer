'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');
const { URI, Utils } = require('vscode-uri');

function loadDicomDatasetModule() {
	const sourcePath = path.join(__dirname, '..', 'src', 'imagePreview', 'dicomDataset.ts');
	const source = fs.readFileSync(sourcePath, 'utf8');
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
		fileName: sourcePath,
	}).outputText;
	const vscodeStub = {
		Uri: URI,
		FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
		workspace: {
			fs: {
				async readDirectory(uri) {
					return (await fs.promises.readdir(uri.fsPath, { withFileTypes: true }))
						.map(entry => [entry.name, entry.isDirectory() ? 2 : 1]);
				},
				async readFile(uri) { return fs.promises.readFile(uri.fsPath); },
			},
		},
	};
	const originalLoad = Module._load;
	Module._load = function (request, parent, isMain) {
		if (request === 'vscode') { return vscodeStub; }
		return originalLoad.call(this, request, parent, isMain);
	};
	try {
		const loaded = new Module(sourcePath, module);
		loaded.filename = sourcePath;
		loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
		loaded._compile(output, sourcePath);
		return loaded.exports;
	} finally {
		Module._load = originalLoad;
	}
}

async function main() {
	const { parseDicomImageHeader, scanDicomFolder } = loadDicomDatasetModule();
	const synthetic = fs.readFileSync(path.join(__dirname, '..', 'test-samples', 'scientific', 'synthetic-ct.dcm'));
	const header = parseDicomImageHeader(synthetic);
	assert.ok(header?.hasPixelData);
	assert.strictEqual(header.transferSyntax, '1.2.840.10008.1.2.1');

	const realFolder = '/Users/florian/Projects/cursor/test_data/testfiles/scientific/MRT OSG Februar 2023';
	if (fs.existsSync(realFolder)) {
		const firstReal = fs.readdirSync(realFolder).map(name => path.join(realFolder, name)).find(file => fs.statSync(file).isFile());
		const realHeader = parseDicomImageHeader(fs.readFileSync(firstReal));
		assert.ok(realHeader, 'real extensionless DICOM header should parse');
		assert.ok(realHeader.hasPixelData, 'real extensionless DICOM should expose pixel data');
		const manifest = await scanDicomFolder(URI.file(realFolder));
		assert.strictEqual(manifest.kind, 'dicom');
		assert.strictEqual(manifest.series.length, 4);
		assert.deepStrictEqual(manifest.series.map(series => series.planes.length), [44, 26, 26, 36]);
		assert.ok(manifest.series.every(series => series.axes[0].key === 'z'));
		assert.ok(manifest.series.every(series => series.planes.every((plane, z) => plane.coordinates.z === z && plane.format === 'dicom')));
		assert.ok(manifest.series.flatMap(series => series.planes).every(plane => !Utils.basename(URI.parse(plane.resourceUri)).includes('.')));
		console.log('✅ Real DICOM folder: four spatially ordered MR series (44, 26, 26, 36 slices)');
	}

	const jpegFolder = '/Users/florian/Projects/cursor/test_data/testfiles/scientific';
	const jpegFixture = path.join(jpegFolder, '0002.DCM');
	if (fs.existsSync(jpegFixture)) {
		const jpegHeader = parseDicomImageHeader(fs.readFileSync(jpegFixture));
		assert.ok(jpegHeader?.hasPixelData, 'JPEG Baseline DICOM should be recognized from its header');
		assert.strictEqual(jpegHeader.transferSyntax, '1.2.840.10008.1.2.4.50');
		assert.strictEqual(jpegHeader.frames, 96);
		const manifest = await scanDicomFolder(URI.file(jpegFolder));
		const frameSeries = manifest.series.find(series => series.axes.some(axis => axis.key === 'frame'));
		assert.ok(frameSeries, 'multi-frame DICOM should expose a Frame axis');
		assert.deepStrictEqual(frameSeries.axes.map(axis => axis.key), ['frame']);
		assert.strictEqual(frameSeries.axes.find(axis => axis.key === 'frame').size, 96);
		assert.strictEqual(frameSeries.planes.length, 96);
		assert.deepStrictEqual(frameSeries.planes.map(plane => plane.frameIndex), Array.from({ length: 96 }, (_, i) => i));
		console.log('✅ Real JPEG Baseline DICOM: 96-frame dataset axis');
	}

	console.log('✅ Extensionless DICOM detection and dataset manifest grouping');
}

main().catch(error => {
	console.error('❌ DICOM dataset test failed:');
	console.error(error);
	process.exit(1);
});
