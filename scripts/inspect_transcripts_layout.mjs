import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
const file = process.argv.slice(2).find(a => !a.startsWith('--'));
const showNames = process.argv.includes('--names');
if (!file) { console.error('usage: node inspect-layout.mjs <transcripts.parquet> [--names]'); process.exit(1); }
const repo = process.env.REPO || process.cwd();
const { parquetMetadataAsync } = await import(pathToFileURL(path.join(repo, 'node_modules/hyparquet/src/index.js')).href);
const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size;
const source = { byteLength: size, slice: async (a, b) => { b = b ?? size; const buf = Buffer.allocUnsafe(b - a); fs.readSync(fd, buf, 0, b - a, a); return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length); } };
const md = await parquetMetadataAsync(source);
const n = v => Number(v);
const q = (list, p) => { const s = [...list].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const groups = md.row_groups;
const rows = groups.map(g => n(g.num_rows));
console.log(`writer: ${md.created_by}`);
console.log(`file ${(size / 1e6).toFixed(0)} MB, ${groups.length} row groups, ${rows.reduce((a, b) => a + b, 0).toLocaleString()} rows`);
console.log(`rows per row group: min ${q(rows, 0).toLocaleString()}, median ${q(rows, 0.5).toLocaleString()}, max ${q(rows, 0.999).toLocaleString()}`);
console.log(`row group sizes (rows): ${rows.map(r => (r / 1000).toFixed(0) + 'k').join(' ')}`);
const wanted = ['feature_name', 'x_location', 'y_location', 'qv', 'is_gene'];
const colOf = (g, name) => g.columns.find(c => c.meta_data.path_in_schema.join('.') === name);
console.log('\nper column (median row group):');
for (const name of wanted) {
	const cols = groups.map(g => colOf(g, name)).filter(Boolean);
	if (!cols.length) { console.log(`  ${name}: missing`); continue; }
	const m = cols[Math.floor(cols.length / 2)].meta_data;
	const pages = (m.encoding_stats ?? []).map(e => `${e.count} ${e.page_type.toLowerCase().replace('_page', '')} (${e.encoding})`).join(', ') || 'no encoding_stats';
	const dataPages = (m.encoding_stats ?? []).filter(e => /DATA_PAGE/.test(e.page_type)).reduce((a, e) => a + e.count, 0);
	console.log(`  ${name.padEnd(13)} ${m.codec} ${m.encodings.join('+')}  ${(n(m.total_compressed_size) / 1e6).toFixed(2)} MB (${(n(m.total_uncompressed_size) / 1e6).toFixed(2)} raw)  ${n(m.num_values).toLocaleString()} values  nulls ${m.statistics?.null_count ?? '?'}`);
	console.log(`                pages: ${pages}${dataPages ? `  => ~${Math.round(n(m.num_values) / dataPages).toLocaleString()} rows/page` : ''}`);
	console.log(`                offset_index: ${cols[0].offset_index_offset !== undefined ? 'yes' : 'no'}, column_index: ${cols[0].column_index_offset !== undefined ? 'yes' : 'no'}, dictionary page: ${m.dictionary_page_offset !== undefined ? 'yes' : 'no'}, bloom filter: ${m.bloom_filter_offset !== undefined ? 'yes' : 'no'}`);
}
const box = g => { const x = colOf(g, 'x_location')?.meta_data.statistics, y = colOf(g, 'y_location')?.meta_data.statistics; return x && y && x.min_value !== undefined ? { x0: +x.min_value, x1: +x.max_value, y0: +y.min_value, y1: +y.max_value } : null; };
const boxes = groups.map(box);
if (boxes.every(Boolean)) {
	const all = { x0: Math.min(...boxes.map(b => b.x0)), x1: Math.max(...boxes.map(b => b.x1)), y0: Math.min(...boxes.map(b => b.y0)), y1: Math.max(...boxes.map(b => b.y1)) };
	const area = b => (b.x1 - b.x0) * (b.y1 - b.y0);
	const total = area(all);
	const fractions = boxes.map(b => area(b) / total);
	console.log(`\nspatial: slide bounding box ${(all.x1 - all.x0).toFixed(0)} x ${(all.y1 - all.y0).toFixed(0)} (file units)`);
	console.log(`  each row group's x/y bounding box as a share of the slide: min ${(q(fractions, 0) * 100).toFixed(0)}%, median ${(q(fractions, 0.5) * 100).toFixed(0)}%, max ${(q(fractions, 0.999) * 100).toFixed(0)}%`);
	console.log(`  sum of shares: ${(fractions.reduce((a, b) => a + b, 0) * 100).toFixed(0)}% (about 100% = tiled by space, much more = every group covers the slide)`);
} else { console.log('\nspatial: no x/y min/max statistics in the footer'); }
const names = groups.map(g => colOf(g, 'feature_name')?.meta_data.statistics);
if (names.every(s => s && s.min_value !== undefined)) {
	const distinct = new Set(names.map(s => s.min_value + '|' + s.max_value)).size;
	console.log(`\nfeature_name min/max statistics: ${distinct} distinct (min,max) pairs over ${groups.length} groups`);
	if (showNames) { names.slice(0, 5).forEach((s, i) => console.log(`  group ${i}: ${s.min_value} .. ${s.max_value}`)); }
} else { console.log('\nfeature_name: no min/max statistics'); }
const sorting = groups[0].sorting_columns;
console.log(`sorting_columns declared: ${sorting && sorting.length ? JSON.stringify(sorting) : 'none'}`);