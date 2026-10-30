#!/usr/bin/env node
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const { performance: P } = require('perf_hooks');
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const opt = name => { const a = args.find(x => x === '--' + name || x.startsWith('--' + name + '=')); return a === undefined ? undefined : (a.split('=')[1] ?? true); };
const top = +(opt('top') || 6), latency = +(opt('latency') || 0), showNames = !!opt('names'), baseline = opt('baseline');
const workers = +(opt('workers') || 0);
if (!file) { console.error('usage: node profile-transcripts.cjs <transcripts.parquet> [--top=6] [--latency=ms] [--baseline[=rev]] [--workers=N] [--names]'); process.exit(1); }
const repo = process.env.REPO || process.cwd();
const esbuild = require(path.join(repo, 'node_modules', 'esbuild'));
const { patchHyparquetEncoding } = require(path.join(repo, 'esbuild-hyparquet-patch.js'));
const src = path.join(repo, 'media/modules/transcripts');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'txprof-'));
const s = ms => (ms / 1000).toFixed(2) + 's';

// Decoder workers (Node worker threads), built from the working tree: the same pool the viewer uses.
let poolModule = null, workerFile = null;
async function buildPool() {
	const common = { bundle: true, platform: 'node', format: 'cjs', nodePaths: [path.join(repo, 'node_modules')], plugins: [patchHyparquetEncoding()], logLevel: 'error' };
	const poolOut = path.join(tmp, 'pool.cjs');
	await esbuild.build({ ...common, entryPoints: [path.join(src, 'transcript-pool.ts')], outfile: poolOut });
	poolModule = require(poolOut);
	workerFile = path.join(tmp, 'pool-worker.cjs');
	await esbuild.build({
		...common, outfile: workerFile,
		stdin: {
			contents: `
				import { parentPort } from 'node:worker_threads';
				import { DecoderHost } from './transcript-pool.ts';
				const waiters = new Map();
				let counter = 0;
				const host = new DecoderHost(byteLength => ({ byteLength, slice: (start, end) => new Promise((resolve, reject) => { const rid = ++counter; waiters.set(rid, { resolve, reject }); parentPort.postMessage({ type: 'range', rid, start, end: end ?? byteLength }); }) }));
				parentPort.on('message', async data => {
					if (data.type === 'rangeData') { const waiter = waiters.get(data.rid); waiters.delete(data.rid); if (data.error) { waiter.reject(new Error(data.error)); } else { waiter.resolve(data.buffer); } return; }
					const out = await host.handle(data);
					if (out) { parentPort.postMessage(out.reply, out.transfer); }
				});`,
			resolveDir: src, loader: 'ts',
		},
	});
}
function spawnWorker() {
	const { Worker } = require('worker_threads');
	const worker = new Worker(workerFile);
	const adapter = { onmessage: null, onerror: null, postMessage: (message, transfer) => worker.postMessage(message, transfer), terminate: () => { void worker.terminate(); } };
	worker.on('message', data => adapter.onmessage?.({ data }));
	worker.on('error', error => adapter.onerror?.({ message: String(error) }));
	return adapter;
}

async function build(label, reader) {
	const dir = path.join(tmp, label); fs.mkdirSync(dir);
	fs.copyFileSync(path.join(src, 'transcript-data.ts'), path.join(dir, 'transcript-data.ts'));
	fs.writeFileSync(path.join(dir, 'transcript-reader.ts'), reader.replace("'./transcript-data.js'", "'./transcript-data.ts'"));
	const out = path.join(dir, 'bundle.cjs');
	await esbuild.build({ entryPoints: [path.join(dir, 'transcript-reader.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, nodePaths: [path.join(repo, 'node_modules')], plugins: [patchHyparquetEncoding()], logLevel: 'error' });
	return require(out);
}

async function run(label, mod) {
	const usePool = workers > 0 && poolModule && label === 'current';
	const factory = () => usePool ? (setup => poolModule.createPool(setup, rangeFile, spawnWorker, Math.min(workers, setup.groups.length))) : undefined;
	const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size;
	const st = { bytes: 0, reqs: 0, io: 0 };
	const rangeFile = {
		byteLength: size,
		slice: async (a, b) => {
			b = b ?? size; const t = P.now();
			const buf = Buffer.allocUnsafe(b - a); fs.readSync(fd, buf, 0, b - a, a);
			if (latency) { await new Promise(r => setTimeout(r, latency)); }
			st.bytes += b - a; st.reqs++; st.io += P.now() - t;
			return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
		},
	};
	const phase = async (title, fn) => {
		st.bytes = st.reqs = st.io = 0; const t = P.now(); const result = await fn(); const ms = P.now() - t;
		console.log(`  ${title.padEnd(44)} ${s(ms).padStart(8)}   read ${(st.bytes / 1e6).toFixed(0).padStart(5)} MB in ${String(st.reqs).padStart(4)} requests`);
		return { result, ms };
	};
	console.log(`\n== ${label}${usePool ? ` with ${workers} decoder workers` : ' (one thread)'} ==`);
	const { result: handle } = await phase('open (count genes, index row groups)', () => mod.openTranscripts(rangeFile, 1, undefined, factory()));
	const order = handle.index.genes.map((g, i) => [g, handle.index.counts[i]]).sort((a, b) => b[1] - a[1]);
	const pick = (from, n) => order.slice(from, from + n).map(x => x[0]);
	const points = out => [...out.values()].reduce((sum, p) => sum + p.x.length, 0);
	const tag = name => showNames ? name : '#' + (order.findIndex(x => x[0] === name) + 1);

	const batch = pick(0, top);
	const first = await phase(`read ${batch.length} commonest genes together`, () => mod.readGenes(handle, batch));
	console.log(`    -> ${points(first.result).toLocaleString()} points`);

	if (usePool) { mod.closeTranscripts(handle); }
	const fresh = await mod.openTranscripts(rangeFile, 1, undefined, factory());
	console.log(`  one at a time, fresh handle (commonest first):`);
	for (const name of pick(0, top)) {
		await phase(`    gene ${tag(name)} (${order.find(x => x[0] === name)[1].toLocaleString()} points)`, () => mod.readGenes(fresh, [name]));
	}
	if (order.length > 110) { await phase('10 mid-frequency genes together', () => mod.readGenes(fresh, pick(100, 10))); }
	const m = process.memoryUsage();
	if (usePool) { mod.closeTranscripts(fresh); }
	return { handle, rss: m.rss, heap: m.heapUsed };
}

(async () => {
	const size = fs.statSync(file).size;
	if (workers > 0) { await buildPool(); }
	const current = await build('current', fs.readFileSync(path.join(src, 'transcript-reader.ts'), 'utf8'));
	let old = null;
	if (baseline) {
		const rev = baseline === true ? 'HEAD' : baseline;
		try { old = await build('baseline', cp.execFileSync('git', ['show', `${rev}:media/modules/transcripts/transcript-reader.ts`], { cwd: repo, encoding: 'utf8' })); }
		catch (error) { console.log('baseline unavailable:', String(error.message).split('\n')[0]); }
	}
	console.log(`file ${(size / 1e6).toFixed(0)} MB, simulated latency ${latency} ms, node ${process.version}, ${os.cpus().length} cores (${os.cpus()[0].model})`);
	for (const [label, mod] of [['baseline', old], ['current', current]]) {
		if (!mod) { continue; }
		const { handle, rss } = await run(label, mod);
		if (label === 'current' || !old) {
			const meta = handle.metadata;
			const columns = new Set(['feature_name', 'x_location', 'y_location', 'qv', 'is_gene']);
			console.log(`\n  file layout: ${handle.groups.length} row groups, ${handle.index.total.toLocaleString()} gene transcripts, ${handle.index.genes.length} genes, ~${Math.round(handle.groups[0].end - handle.groups[0].start).toLocaleString()} rows in the first group`);
			for (const column of meta.row_groups[0].columns) {
				const md = column.meta_data;
				if (!columns.has(md.path_in_schema.join('.'))) { continue; }
				console.log(`    ${md.path_in_schema.join('.').padEnd(14)} ${String(md.codec).padEnd(13)} ${md.encodings.join(',').padEnd(30)} ${(Number(md.total_compressed_size) / 1e6).toFixed(2)} MB compressed / ${(Number(md.total_uncompressed_size) / 1e6).toFixed(2)} MB raw (first row group)`);
			}
		}
		console.log(`  process memory after: ${(rss / 1e6).toFixed(0)} MB`);
	}
	fs.rmSync(tmp, { recursive: true, force: true });
	process.exit(0);
})();
