'use strict';

// Exercise the real host resolver and shared collection matcher with a VS Code
// filesystem double. All URI reads must retain the selected host's identity.
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { URI, Utils } = require('vscode-uri');

function load(entry, vscode) {
	const { outputFiles } = buildSync({
		entryPoints: [path.join(__dirname, '..', entry)], bundle: true,
		platform: 'node', format: 'cjs', write: false, external: ['vscode'],
	});
	const loaded = { exports: {} };
	new Function('module', 'exports', 'require', outputFiles[0].text)(loaded, loaded.exports, name => name === 'vscode' ? vscode : require(name));
	return loaded.exports;
}

async function checkHost(scheme, authority) {
	const root = URI.from({ scheme, authority, path: '/workspace/[study]' });
	const sample = Utils.joinPath(root, 'samples', 'sample1');
	const nodes = new Map();
	let settings = {};
	let reverse = false;
	let reads = 0;
	const FileType = { File: 1, Directory: 2 };
	function add(relative, mtime = 0, type = FileType.File) {
		const uri = Utils.joinPath(root, relative);
		nodes.set(uri.path, { type, mtime, ctime: 0, size: 0 });
		for (let dir = Utils.dirname(uri); !nodes.has(dir.path); dir = Utils.dirname(dir)) {
			nodes.set(dir.path, { type: FileType.Directory, mtime: 0, ctime: 0, size: 0 });
			if (dir.path === '/') break;
		}
		return uri;
	}
	function checkUri(uri) {
		reads++;
		assert.equal(uri.scheme, scheme);
		assert.equal(uri.authority, authority);
	}
	const vscode = {
		Uri: URI, FileType,
		workspace: {
			workspaceFolders: [{ uri: root }], getWorkspaceFolder: () => ({ uri: root }),
			getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }),
			fs: {
				async stat(uri) { checkUri(uri); if (!nodes.has(uri.path)) throw new Error('ENOENT'); return nodes.get(uri.path); },
				async readDirectory(uri) {
					checkUri(uri);
					if (!nodes.has(uri.path)) throw new Error('ENOENT');
					const entries = [...nodes].filter(([file]) => file !== uri.path && path.posix.dirname(file) === uri.path)
						.map(([file, stat]) => [path.posix.basename(file), stat.type]);
					return reverse ? entries.reverse() : entries;
				},
				async readFile(uri) { checkUri(uri); return new Uint8Array([1, 2, 3]); },
			},
		},
	};
	const cells = load('src/cells/cellFiles.ts', vscode);
	const glob = load('src/util/globPaths.ts', vscode);
	const runA = add('parent/output-XETG-a-sample1-v1/cell_boundaries.parquet', 10);
	const runB = add('parent/output-XETG-b-sample1-v2/cell_boundaries.parquet', 20);
	add('parent/output-XETG-a-other-v1/cell_boundaries.parquet', 99);
	const template = 'parent/output-XETG*{sample_name}*/cell_boundaries.parquet';
	assert.equal((await cells.locate(template, sample, () => 'sample1')).toString(), runB.toString());
	assert.equal((await cells.locate(runA.path, sample, () => 'sample1')).toString(), runA.toString());
	assert.equal(await cells.locate('parent/missing*/cells.csv', sample, () => 'sample1'), undefined);
	assert.equal(await cells.locate('parent', sample, () => 'sample1'), undefined, 'directories are not cell files');
	add('parent/output-XETG-b-sample1-v2/cell_boundaries.csv', 21);
	assert.equal((await cells.locate('parent/output-????-b-{sample_name}-v?/cell_boundaries.c??', sample, () => 'sample1')).path,
		runB.path.replace('.parquet', '.csv'));
	const tie = add('parent/output-XETG-c-sample1-v3/cell_boundaries.parquet', 20);
	for (reverse of [false, true]) {
		assert.equal((await cells.locate(template, sample, () => 'sample1')).toString(), runB.toString(), 'mtime ties use path order');
	}
	assert.ok(tie);

	// Sample names stay literal, including glob syntax and JS replacement tokens.
	for (const name of ['s*?[a]{x,y}]', 's$&$`$\'', 'normal']) {
		const exact = add(`literal/run-${name}-v1/${name}.csv`, 1);
		add('literal/run-normal-v1/normal.csv', 100);
		assert.equal((await cells.locate('literal/run-{sample_name}-*/{sample_name}.csv', sample, () => name)).path, exact.path);
		assert.equal((await cells.locate(`literal/run-{sample_name}-v1/{sample_name}.csv`, sample, () => name)).path, exact.path);
		assert.ok(glob.segmentToRegex(`{other,${glob.escapeGlobLiteral(name)}}`).test(name), 'literal names also work inside brace alternatives');
	}

	settings = {
		cellBoundaries: { sam2: template },
		cellData: { counts: { path: 'parent/output-*-{sample_name}-v?/cell_boundaries.csv', parent: 'sam2' } },
		nucleusBoundaries: { nuclei: { path: 'missing/{sample_name}/*.parquet', parent: 'sam2' } },
	};
	const sources = await cells.configuredSources(sample, () => 'sample1');
	assert.equal(sources.length, 3);
	const boundaries = sources.find(source => source.name === 'sam2');
	const counts = sources.find(source => source.name === 'counts');
	assert.equal(boundaries.uri.toString(), runB.toString());
	assert.equal(boundaries.path, scheme === 'file' ? runB.fsPath : runB.path, 'show the concrete path');
	assert.equal(counts.parent, 'sam2');
	assert.ok(counts.uri.path.endsWith('.csv'));
	assert.equal(sources[2].uri, undefined);
	assert.equal(sources[2].path, 'missing/sample1/*.parquet');
	settings = { cellBoundariesParquet: { legacy: template } };
	assert.equal((await cells.configuredSources(sample, () => 'sample1'))[0].uri.path, runB.path);

	const messages = [];
	const webview = { postMessage: async message => messages.push(message), asWebviewUri: uri => uri };
	await cells.answerCellRequest(webview, 'typed', sample, [root], template, () => 'sample1');
	assert.equal(messages.at(-1).spec.path, scheme === 'file' ? runB.fsPath : runB.path);
	assert.equal(messages.at(-1).spec.found, true);
	await cells.answerCellRequest(webview, 'missing', sample, [root], 'missing/*.csv', () => 'sample1');
	assert.match(messages.at(-1).error, /Not found/);
	await cells.answerCellRequest(webview, 'outside-roots', sample, [], template, () => 'sample1');
	assert.deepEqual([...new Uint8Array(messages.at(-1).spec.bytes)], [1, 2, 3]);

	// Collection callers restrict file types and retain ordering, cancellation,
	// directory expansion, and the result cap. Cell callers accept non-images.
	const image2 = add('images/image2.tif');
	const image10 = add('images/image10.tif');
	add('images/table.csv');
	const imageRoot = Utils.joinPath(root, 'images');
	const escapedRoot = glob.escapeGlobLiteral(root.path);
	const options = { acceptFile: uri => uri.path.endsWith('.tif') };
	assert.deepEqual((await glob.expandGlobPatternAsync(`${escapedRoot}/images/*`, root, () => false, options)).map(uri => uri.path), [image2.path, image10.path]);
	// The literal folder path uses no special characters in this separate fixture.
	add('../plain/image2.tif'); add('../plain/image10.tif'); add('../plain/table.csv');
	assert.equal((await glob.expandGlobPatternAsync('/workspace/plain', root, () => false, options)).length, 2);
	assert.equal((await glob.expandGlobPatternAsync(`${escapedRoot}/images/*`, root, () => false, { ...options, maxResults: 1 })).length, 1);
	assert.equal((await glob.expandGlobPatternAsync(`${escapedRoot}/images/{image2,image10}.tif`, root, () => false, options)).length, 2);
	assert.equal((await glob.expandGlobPatternAsync(`${escapedRoot}/images/image[12]*.tif`, root, () => false, options)).length, 2);
	const before = reads;
	assert.deepEqual(await glob.expandGlobPatternAsync(imageRoot.path + '/*', root, () => true), []);
	assert.equal(reads, before, 'cancelled scans do not read the filesystem');
	assert.ok(glob.segmentToRegex('incomplete[').test('incomplete['));
	assert.ok(glob.segmentToRegex('incomplete{').test('incomplete{'));
	console.log(`Cell paths and shared collection matching passed on ${scheme}.`);
}

(async () => {
	await checkHost('file', '');
	await checkHost('vscode-remote', 'ssh-remote+test');
	await checkHost('vscode-vfs', 'web-test');
})().catch(error => { console.error(error); process.exitCode = 1; });
