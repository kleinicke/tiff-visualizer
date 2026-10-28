/**
 * A pool of workers that decode row groups of a transcripts.parquet in
 * parallel. Decoding is CPU-bound (zstd, then parquet), so it scales with
 * cores; the file is read by the coordinator, which answers each worker's byte
 * range requests, so workers never need file access of their own.
 *
 * Messages to a worker:   decInit { metadata, hasIsGene, byteLength, groups }
 *                         decGenes { genes }          (before any decPack)
 *                         decScan { tid, at } | decPack { tid, at }
 *                         rangeData { rid, buffer | error }   (answers its `range`)
 * Messages from a worker: decDone { tid, result } | decError { tid, error }
 *                         range { rid, start, end }
 */

import { groupsOf, packGroup, scanGroup, type DecoderSetup, type Group, type GroupDecoder, type GroupScan, type PackedGroup, type RangeFile } from './transcript-reader.js';

/** What the pool needs of a worker (a DOM Worker, or an adapter over worker_threads). */
export interface PoolWorker {
	postMessage(message: unknown, transfer?: Transferable[]): void;
	terminate(): void;
	onmessage: ((event: { data: any }) => void) | null;
	onerror: ((event: { message?: string }) => void) | null;
}

interface Task { message: Record<string, unknown>; resolve: (value: any) => void; reject: (error: Error) => void }
interface Slot { worker: PoolWorker; task: (Task & { tid: number }) | null }

/** Coordinator side: hands row groups to `count` workers made by `spawn`. */
export function createPool(setup: DecoderSetup, file: RangeFile, spawn: () => PoolWorker, count: number): GroupDecoder | null {
	const slots: Slot[] = [];
	const queue: Task[] = [];
	let broken: Error | null = null;
	let counter = 0;

	const fail = (error: Error): void => {
		broken ??= error;
		for (const slot of slots) { slot.task?.reject(error); slot.task = null; }
		for (const task of queue.splice(0)) { task.reject(error); }
	};
	const next = (slot: Slot): void => {
		if (slot.task || broken) { return; }
		const task = queue.shift();
		if (!task) { return; }
		const tid = ++counter;
		slot.task = { ...task, tid };
		slot.worker.postMessage({ ...task.message, tid });
	};

	try {
		for (let index = 0; index < count; index++) {
			const worker = spawn();
			const slot: Slot = { worker, task: null };
			worker.onerror = event => fail(new Error(event.message || 'A transcript decoder failed.'));
			worker.onmessage = event => {
				const data = event.data;
				if (data?.type === 'range') {
					file.slice(data.start, data.end).then(
						buffer => worker.postMessage({ type: 'rangeData', rid: data.rid, buffer }, [buffer]),
						(error: unknown) => worker.postMessage({ type: 'rangeData', rid: data.rid, error: error instanceof Error ? error.message : String(error) }),
					);
					return;
				}
				if ((data?.type !== 'decDone' && data?.type !== 'decError') || !slot.task || slot.task.tid !== data.tid) { return; }
				const task = slot.task;
				slot.task = null;
				if (data.type === 'decDone') { task.resolve(data.result); } else { task.reject(new Error(String(data.error))); }
				next(slot);
			};
			slots.push(slot);
			worker.postMessage({ type: 'decInit', metadata: setup.metadata, hasIsGene: setup.hasIsGene, byteLength: setup.byteLength, groups: setup.groups });
		}
	} catch {
		for (const slot of slots) { slot.worker.terminate(); }
		return null;
	}

	const submit = <T>(message: Record<string, unknown>): Promise<T> => new Promise<T>((resolve, reject) => {
		if (broken) { reject(broken); return; }
		queue.push({ message, resolve, reject });
		for (const slot of slots) { next(slot); }
	});

	return {
		size: slots.length,
		scan: at => submit<GroupScan>({ type: 'decScan', at }),
		setGenes: genes => { for (const slot of slots) { slot.worker.postMessage({ type: 'decGenes', genes }); } },
		pack: at => submit<Omit<PackedGroup, 'bytes'>>({ type: 'decPack', at }).then(packed => ({ ...packed, bytes: packed.gene.byteLength + packed.x.byteLength + packed.y.byteLength + packed.q.byteLength })),
		terminate: () => { fail(new Error('Closed')); for (const slot of slots) { slot.worker.terminate(); } },
	};
}

/** Worker side: runs the decode messages. `makeFile` reads ranges through the coordinator. */
export class DecoderHost {
	private metadata: unknown;
	private hasIsGene = false;
	private groups: Group[] = [];
	private file: RangeFile | null = null;
	private geneIndex = new Map<string, number>();

	constructor(private readonly makeFile: (byteLength: number) => RangeFile) {}

	/** The reply to post (with the buffers to transfer), or null when the message needs none. */
	async handle(data: { type: string; [key: string]: any }): Promise<{ reply: unknown; transfer: ArrayBuffer[] } | null> {
		if (data.type === 'decInit') {
			this.metadata = data.metadata; this.hasIsGene = data.hasIsGene; this.groups = data.groups as Group[] ?? groupsOf(data.metadata);
			this.file = this.makeFile(data.byteLength);
			return null;
		}
		if (data.type === 'decGenes') {
			this.geneIndex = new Map((data.genes as string[]).map((gene, position) => [gene, position]));
			return null;
		}
		const tid = data.tid;
		try {
			if (!this.file) { throw new Error('The decoder was not set up.'); }
			if (data.type === 'decScan') {
				return { reply: { type: 'decDone', tid, result: await scanGroup(this.file, this.metadata, this.groups[data.at], this.hasIsGene) }, transfer: [] };
			}
			const packed = await packGroup(this.file, this.metadata, this.groups[data.at], this.geneIndex);
			const result = { gene: packed.gene, x: packed.x, y: packed.y, q: packed.q };
			return { reply: { type: 'decDone', tid, result }, transfer: [packed.gene.buffer, packed.x.buffer, packed.y.buffer, packed.q.buffer] as ArrayBuffer[] };
		} catch (error) {
			return { reply: { type: 'decError', tid, error: error instanceof Error ? error.message : String(error) }, transfer: [] };
		}
	}
}
