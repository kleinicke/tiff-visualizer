/**
 * The transcripts shown over an image: a list of genes (each on or off) and
 * groups of genes that switch many at once. Nothing is listed by default; the
 * file may hold thousands of genes, so the user adds the ones they want.
 *
 * Independent of Xenium: the viewer supplies loading and the overlay.
 */

import { GENE_COLORS, GROUP_COLORS, paletteColor } from './transcript-colors.js';
import { TranscriptsLayer } from './transcripts-layer.js';
import type { GenePoints, TranscriptIndex } from './transcript-data.js';
import type { TranscriptGeneRow, TranscriptGroupRow, TranscriptsPanelModel } from './transcripts-model.js';

export interface TranscriptGroupDefinition { name: string; genes: string[]; color: string }

interface Group extends TranscriptGroupDefinition { palette: boolean; added: boolean; user: boolean }
interface Gene { name: string; visible: boolean; color: string }

export interface TranscriptsWorkspaceHost {
	/** Whether the bundle has a transcripts file. */
	available: boolean;
	/** Read the gene list and counts; `progress` reports row groups done. */
	open(progress: (done: number, total: number) => void): Promise<TranscriptIndex>;
	/** Read the positions of these genes. */
	genes(names: string[], progress: (done: number, total: number) => void): Promise<Map<string, GenePoints>>;
	addOverlay(layer: TranscriptsLayer): void;
	removeOverlay(layer: TranscriptsLayer): void;
	requestRender(): void;
	/** Re-render the panel and save state. */
	notify(): void;
}

export interface TranscriptsWorkspaceState {
	groups: { name: string; genes: string[]; color: string; palette: boolean; added: boolean; user: boolean }[];
	genes: Gene[];
	filter: string[];
	minQv: number;
	size: number;
}

/** Groups from the settings: name → gene list, or name → {genes, color}. */
export function parseTranscriptGroups(raw: unknown): TranscriptGroupDefinition[] {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return []; }
	const out: TranscriptGroupDefinition[] = [];
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		const record = value && typeof value === 'object' && !Array.isArray(value) ? value as { genes?: unknown; color?: unknown } : null;
		const list = Array.isArray(value) ? value : record?.genes;
		if (!Array.isArray(list)) { continue; }
		const genes = list.filter((gene): gene is string => typeof gene === 'string' && gene.trim() !== '').map(gene => gene.trim());
		const color = typeof record?.color === 'string' && /^#[0-9a-f]{6}$/i.test(record.color) ? record.color : GROUP_COLORS[out.length % GROUP_COLORS.length];
		if (name.trim()) { out.push({ name: name.trim(), genes, color }); }
	}
	return out;
}

export class TranscriptsWorkspace {
	private readonly layer: TranscriptsLayer;
	private index: TranscriptIndex | null = null;
	private geneIndex = new Map<string, number>();
	/** Positions of the genes read so far; dropped when a gene leaves the list. */
	private points = new Map<string, GenePoints>();
	private fetching = new Set<string>();
	private reading: Promise<void> | null = null;
	private readProgress: string | null = null;
	private lowerIndex = new Map<string, string>();
	private status: TranscriptsPanelModel['status'];
	private message: string | null = null;
	private groups: Group[];
	private genes: Gene[] = [];
	private filter: string[] = [];
	private minQv = 20;
	private size = 1;
	private loading: Promise<void> | null = null;

	constructor(private readonly host: TranscriptsWorkspaceHost, private readonly pixelSizeUm: number, definitions: TranscriptGroupDefinition[]) {
		this.layer = new TranscriptsLayer(() => this.host.requestRender(), 0.8 / pixelSizeUm);
		this.host.addOverlay(this.layer);
		this.status = host.available ? 'idle' : 'unavailable';
		this.groups = definitions.map(definition => ({ ...definition, palette: false, added: false, user: false }));
	}

	get loaded(): boolean { return this.index !== null; }

	/** Whether there is anything worth loading the file for on start-up. */
	get wanted(): boolean { return this.genes.length > 0 || this.groups.some(group => group.added); }

	/** Resolves when no gene positions are being read (for tests). */
	async settled(): Promise<void> { while (this.reading) { await this.reading; } }

	load(): Promise<void> {
		if (this.index || !this.host.available) { return Promise.resolve(); }
		if (this.loading) { return this.loading; }
		this.status = 'loading';
		this.message = 'Reading gene names…';
		this.host.notify();
		this.loading = this.host.open((done, total) => { this.message = `Reading gene names… ${done} of ${total}`; this.host.notify(); }).then(index => {
			this.index = index;
			index.genes.forEach((gene, position) => { this.geneIndex.set(gene, position); this.lowerIndex.set(gene.toLowerCase(), gene); });
			this.status = 'ready';
			this.message = null;
			this.layer.setMinQv(this.minQv);
			this.layer.setSize(this.size);
			this.sync();
		}).catch((error: unknown) => {
			this.status = 'error';
			this.message = `Transcripts could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
			this.host.notify();
		}).finally(() => { this.loading = null; });
		return this.loading;
	}

	dispose(): void { this.host.removeOverlay(this.layer); }

	// --- colours ------------------------------------------------------------

	private colorOf(gene: Gene): { color: string; grouped: boolean } {
		for (const group of this.groups) {
			if (!group.added) { continue; }
			const at = group.genes.indexOf(gene.name);
			if (at >= 0) { return { color: group.palette ? paletteColor(group.color, at) : group.color, grouped: true }; }
		}
		return { color: gene.color, grouped: false };
	}

	private found(group: Group): string[] { return group.genes.filter(gene => this.index ? this.geneIndex.has(gene) : true); }

	private sync(): void {
		if (this.index) {
			const listed = new Set(this.genes.map(gene => gene.name));
			for (const name of this.points.keys()) { if (!listed.has(name)) { this.points.delete(name); } }
			this.layer.setGenes(this.genes.flatMap(gene => {
				const points = this.points.get(gene.name);
				return gene.visible && points ? [{ points, color: this.colorOf(gene).color }] : [];
			}));
			this.readMissing();
		}
		this.host.notify();
	}

	/** Read the positions of shown genes that have none yet, in one request. */
	private readMissing(): void {
		if (this.reading) { return; }
		const names = this.genes.filter(gene => gene.visible && this.geneIndex.has(gene.name) && !this.points.has(gene.name)).map(gene => gene.name);
		if (names.length === 0) { return; }
		for (const name of names) { this.fetching.add(name); }
		this.readProgress = null;
		this.reading = this.host.genes(names, (done, total) => { this.readProgress = `${done} of ${total} row groups`; this.host.notify(); }).then(found => {
			for (const [name, points] of found) { this.points.set(name, points); }
		}).catch((error: unknown) => {
			this.message = `Transcripts could not be read: ${error instanceof Error ? error.message : String(error)}`;
			// Give these genes up rather than ask again for ever; hiding and showing a gene tries again.
			for (const gene of this.genes) { if (names.includes(gene.name)) { gene.visible = false; } }
		}).finally(() => {
			for (const name of names) { this.fetching.delete(name); }
			this.reading = null;
			this.readProgress = null;
			this.sync();
		});
		this.host.notify();
	}

	// --- changes ------------------------------------------------------------

	private ensure(name: string, visible: boolean): void {
		const existing = this.genes.find(gene => gene.name === name);
		if (existing) { existing.visible = visible || existing.visible; return; }
		this.genes.push({ name, visible, color: GENE_COLORS[this.genes.length % GENE_COLORS.length] });
	}

	private resolve(text: string): { found: string[]; missing: string[] } {
		const found: string[] = [], missing: string[] = [];
		for (const token of text.split(/[\s,;]+/).filter(Boolean)) {
			const gene = this.lowerIndex.get(token.toLowerCase()) ?? (this.geneIndex.has(token) ? token : undefined);
			const into = gene ?? token;
			if (!(gene ? found : missing).includes(into)) { (gene ? found : missing).push(into); }
		}
		return { found, missing };
	}

	private createFrom(name: string, text: string): string | null {
		const clean = name.trim();
		if (!clean) { return 'Name the group.'; }
		if (this.groups.some(group => group.name === clean)) { return `There is already a group called ${clean}.`; }
		const { found, missing } = this.resolve(text);
		if (found.length + missing.length === 0) { return 'Name at least one gene.'; }
		this.groups.push({ name: clean, genes: [...found, ...missing], color: GROUP_COLORS[this.groups.length % GROUP_COLORS.length], palette: false, added: true, user: true });
		this.sync();
		return null;
	}

	private group(name: string): Group | undefined { return this.groups.find(group => group.name === name); }

	private rowOfGene(gene: Gene): TranscriptGeneRow {
		const { color, grouped } = this.colorOf(gene);
		const index = this.geneIndex.get(gene.name);
		return {
			name: gene.name, color, grouped, visible: gene.visible,
			count: index !== undefined && this.index ? this.index.counts[index] : 0,
			loading: gene.visible && this.fetching.has(gene.name),
			setVisible: visible => { gene.visible = visible; this.sync(); },
			setColor: next => { gene.color = next; this.sync(); },
			remove: () => { this.genes = this.genes.filter(entry => entry !== gene); this.sync(); },
		};
	}

	private rowOfGroup(group: Group): TranscriptGroupRow {
		const found = this.found(group);
		const visible = new Set(this.genes.filter(gene => gene.visible).map(gene => gene.name));
		const on = found.filter(gene => visible.has(gene)).length;
		return {
			name: group.name, color: group.color, total: group.genes.length, found: found.length, on,
			missing: this.index ? group.genes.filter(gene => !this.geneIndex.has(gene)) : [],
			state: on === 0 ? 'none' : on === found.length ? 'all' : 'some',
			palette: group.palette, filtering: this.filter.includes(group.name),
			toggle: () => {
				if (on === found.length && found.length > 0) {
					const members = new Set(found);
					for (const gene of this.genes) { if (members.has(gene.name)) { gene.visible = false; } }
				} else { for (const gene of found) { this.ensure(gene, true); } for (const gene of this.genes) { if (found.includes(gene.name)) { gene.visible = true; } } }
				void this.load();
				this.sync();
			},
			setColor: color => { group.color = color; this.sync(); },
			setPalette: palette => { group.palette = palette; this.sync(); },
			toggleFilter: () => { this.filter = this.filter.includes(group.name) ? this.filter.filter(name => name !== group.name) : [...this.filter, group.name]; this.sync(); },
			removeAll: () => { const members = new Set(group.genes); this.genes = this.genes.filter(gene => !members.has(gene.name)); this.sync(); },
			remove: () => {
				if (group.user) { this.groups = this.groups.filter(entry => entry !== group); } else { group.added = false; }
				this.filter = this.filter.filter(name => name !== group.name);
				this.sync();
			},
		};
	}

	// --- model --------------------------------------------------------------

	snapshot(): TranscriptsPanelModel {
		const genes = this.genes.map(gene => this.rowOfGene(gene));
		const active = this.groups.filter(group => group.added && this.filter.includes(group.name));
		const listedNames = active.length ? new Set(active.flatMap(group => group.genes)) : null;
		const listed = listedNames ? genes.filter(gene => listedNames.has(gene.name)) : genes;
		return {
			status: this.status, message: this.message, readProgress: this.readProgress,
			points: this.index ? this.index.total : 0, fetching: this.fetching.size,
			genes, listed,
			groups: this.groups.filter(group => group.added).map(group => this.rowOfGroup(group)),
			groupChoices: this.groups.filter(group => !group.added).map(group => ({ name: group.name, size: group.genes.length })),
			geneChoices: () => {
				if (!this.index) { return []; }
				const listedAlready = new Set(this.genes.map(gene => gene.name));
				return this.index.genes.filter(gene => !listedAlready.has(gene));
			},
			geneCount: name => { const index = this.geneIndex.get(name); return index !== undefined && this.index ? this.index.counts[index] : 0; },
			filtering: active.length > 0,
			minQv: this.minQv, size: this.size,
			load: () => { void this.load(); },
			addGene: name => { this.ensure(name, true); this.sync(); },
			addGroup: name => { const group = this.group(name); if (group) { group.added = true; void this.load(); this.sync(); } },
			createGroup: (name, text) => this.createFrom(name, text),
			groupFromListed: name => this.createFrom(name, this.genes.map(gene => gene.name).join(' ')),
			clearGenes: () => { this.genes = []; this.sync(); },
			showAllListed: visible => {
				const names = new Set(listed.map(gene => gene.name));
				for (const gene of this.genes) { if (names.has(gene.name)) { gene.visible = visible; } }
				this.sync();
			},
			clearFilter: () => { this.filter = []; this.sync(); },
			setMinQv: value => { this.minQv = value; this.layer.setMinQv(value); this.host.notify(); },
			setSize: value => { this.size = value; this.layer.setSize(value); this.host.notify(); },
		};
	}

	// --- persistence --------------------------------------------------------

	getState(): TranscriptsWorkspaceState {
		return {
			groups: this.groups.map(group => ({ name: group.name, genes: group.genes, color: group.color, palette: group.palette, added: group.added, user: group.user })),
			genes: this.genes.map(gene => ({ ...gene })), filter: this.filter, minQv: this.minQv, size: this.size,
		};
	}

	restore(state: TranscriptsWorkspaceState | undefined): void {
		if (!state) { return; }
		for (const saved of state.groups ?? []) {
			const existing = this.group(saved.name);
			if (existing) { Object.assign(existing, { color: saved.color, palette: saved.palette, added: saved.added }); }
			else if (saved.user) { this.groups.push({ ...saved }); }
		}
		this.genes = (state.genes ?? []).map(gene => ({ ...gene }));
		this.filter = (state.filter ?? []).filter(name => this.group(name));
		this.minQv = state.minQv ?? 20;
		this.size = state.size ?? 1;
		this.layer.setMinQv(this.minQv);
		this.layer.setSize(this.size);
		this.sync();
	}
}
