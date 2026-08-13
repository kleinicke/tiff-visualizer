/**
 * Keeps the format registry and package.json's editor selectors in agreement.
 *
 * Adding a format used to mean editing the dispatch chain in imagePreview.ts,
 * the worker's switch, and the `customEditors` selectors in package.json, with
 * nothing checking that they matched. A format registered in package.json but
 * missing from the dispatch opens an editor that cannot decode the file; one
 * present in the dispatch but missing from package.json is simply never
 * reachable. Both failures are silent.
 *
 * Run with: node test/format-registry-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function selectorExtensions(packageJson) {
	const found = new Set();
	for (const editor of packageJson.contributes.customEditors) {
		for (const selector of editor.selector) {
			// "*.{tif,tiff,...}" or "*.ext"
			const match = /\*\.\{([^}]*)\}|\*\.([A-Za-z0-9]+)$/.exec(selector.filenamePattern);
			if (!match) { continue; }
			const list = match[1] ? match[1].split(',') : [match[2]];
			for (const raw of list) {
				const extension = raw.trim().toLowerCase();
				if (extension) { found.add(extension); }
			}
		}
	}
	return found;
}

async function main() {
	const registryPath = path.join(__dirname, '..', 'out', 'media', 'modules', 'format-registry.js');
	if (!fs.existsSync(registryPath)) {
		console.log('⚠️  out/media/modules/format-registry.js not found — run `npm run compile` first. Skipping.');
		return;
	}
	const { FORMATS, allExtensions, resolveFormat, extensionOf, isTiffPath, layeredFormatOf } =
		await import(registryPath.replace(/\\/g, '/'));
	const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

	console.log('🧪 Running format registry tests...\n');
	let count = 0;

	// --- registry internal consistency ---------------------------------------
	{
		const seen = new Map();
		for (const entry of FORMATS) {
			assert.ok(entry.kind && entry.label && entry.extensions.length > 0,
				`every entry needs a kind, label and at least one extension: ${JSON.stringify(entry)}`);
			for (const extension of entry.extensions) {
				assert.ok(!extension.startsWith('.'), `extensions are stored without a dot: '${extension}'`);
				assert.strictEqual(extension, extension.toLowerCase(), `extensions are lower-case: '${extension}'`);
				assert.ok(!seen.has(extension),
					`'.${extension}' is claimed twice (${seen.get(extension)} and ${entry.label})`);
				seen.set(extension, entry.label);
			}
			if (entry.kind === 'layered') {
				assert.ok(entry.layeredFormat, `layered entry '${entry.label}' needs a layeredFormat discriminator`);
			} else {
				assert.ok(!entry.layeredFormat, `non-layered entry '${entry.label}' must not set layeredFormat`);
			}
		}
		console.log(`✅ registry is internally consistent (${FORMATS.length} entries, ${seen.size} extensions)`);
		count++;
	}

	// --- package.json agreement ----------------------------------------------
	{
		const declared = selectorExtensions(packageJson);
		const registered = new Set(allExtensions());

		const missingFromPackage = [...registered].filter(e => !declared.has(e)).sort();
		assert.deepStrictEqual(missingFromPackage, [],
			`the registry decodes these but package.json never opens them: ${missingFromPackage.join(', ')}`);

		const missingFromRegistry = [...declared].filter(e => !registered.has(e)).sort();
		assert.deepStrictEqual(missingFromRegistry, [],
			`package.json opens these but no decoder is registered, so they would fail to load: ${missingFromRegistry.join(', ')}`);

		console.log(`✅ package.json selectors and the registry agree on all ${declared.size} extensions`);
		count++;
	}

	// --- resolution behaviour -------------------------------------------------
	{
		assert.strictEqual(resolveFormat('/x/a.TIF').kind, 'tiff', 'extension match is case-insensitive');
		assert.strictEqual(resolveFormat('/x/a.ome.tif').kind, 'tiff', 'compound names use the last extension');
		assert.strictEqual(resolveFormat('/x/a.psd').layeredFormat, 'psd');
		assert.strictEqual(layeredFormatOf('/x/a.afphoto'), 'affinity');
		assert.strictEqual(layeredFormatOf('/x/a.tif'), null, 'a TIFF is not a layered document');
		assert.ok(isTiffPath('/x/a.btf'), 'BigTIFF spellings count as TIFF');
		assert.strictEqual(resolveFormat('/x/unknown.xyz'), null, 'unknown extensions resolve to null');
		assert.strictEqual(extensionOf('/x/noextension'), '', 'a name without a dot has no extension');

		// The extensionless-DICOM heuristic is deliberate and narrow; it used to
		// be the trailing arm of a long if/else chain where it read as a general
		// catch-all.
		assert.strictEqual(resolveFormat('/x/IM00001').kind, 'dicom',
			'extensionless files are treated as DICOM instances');
		assert.strictEqual(resolveFormat('/x/a.png', 'dicom').kind, 'dicom',
			'an explicit format hint overrides the extension');
		console.log('✅ resolution handles case, compound names, hints and the extensionless-DICOM rule');
		count++;
	}

	console.log(`\n🎉 All ${count} format registry checks passed.\n`);
}

main().catch(error => {
	console.error('❌ Format registry test failed:');
	console.error(error);
	process.exit(1);
});
