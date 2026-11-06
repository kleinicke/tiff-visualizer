const assert = require('assert');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const esbuild = require('esbuild');

async function load(relative) {
	const outfile = path.join(os.tmpdir(), `${relative.replace(/[\\/]/g, '-')}-${process.pid}.mjs`);
	await esbuild.build({ entryPoints: [path.join(__dirname, '..', `${relative}.ts`)], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
	return import(pathToFileURL(outfile).href);
}

(async () => {
	const { extractSampleName } = await load('shared/cell-paths');
	const folder = 'run001__sampleA1__20240101';
	const id = '(?<sample_name>sample[A-Z]\\d+)';

	for (const none of [undefined, '', '   ']) { assert.deepStrictEqual(extractSampleName(none, folder), { name: folder }, 'no pattern keeps the whole name, silently'); }
	assert.deepStrictEqual(extractSampleName(id, folder), { name: 'sampleA1' });
	assert.deepStrictEqual(extractSampleName(`  ${id}  `, folder), { name: 'sampleA1' }, 'the pattern is trimmed');
	assert.deepStrictEqual(extractSampleName('^run\\d+__(?<sample_name>.+?)__\\d+$', folder), { name: 'sampleA1' }, 'anchors and lazy groups work');
	assert.strictEqual(extractSampleName('(?<sample_name>S\\d)', 'S1-then-S2').name, 'S1', 'the first match wins');
	assert.strictEqual(extractSampleName('(?<other>x)(?<sample_name>y)', 'xy').name, 'y', 'other groups are ignored');
	assert.strictEqual(extractSampleName('(?<sample_name>a.b)', 'a\nb').warning !== undefined, true, '. does not cross a newline, so no match');

	const failures = [
		['(?<sample_name>', /not a valid regular expression/, 'an invalid pattern'],
		['sample\\d+', /needs a named group/, 'a pattern with no sample_name group'],
		['(sample[A-Z]\\d+)', /needs a named group/, 'a plain capture group is not enough'],
		['\\(?<sample_name>x', /needs a named group/, 'an escaped parenthesis is not a group'],
		['(?<sample_name>ZZ\\d+)', /does not match/, 'a pattern that does not match'],
		['(?<sample_name>a)?b', /captured nothing/, 'a group that took no part in the match'],
	];
	for (const [pattern, message, label] of failures) {
		const result = extractSampleName(pattern, /captured nothing/.test(String(message)) ? 'b' : folder);
		assert.strictEqual(result.name, /captured nothing/.test(String(message)) ? 'b' : folder, `${label} falls back to the whole name`);
		assert.match(result.warning ?? '', message, `${label} explains itself`);
		assert.match(result.warning, /tiffVisualizer\.cells\.sampleNamePattern/, `${label} names the setting`);
	}
	console.log('cells sample name tests passed');
})().catch(error => { console.error(error); process.exit(1); });
