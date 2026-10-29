/**
 * The transcripts shown over an image: a list of genes (each on or off) and
 * groups of genes that switch many at once. Nothing is listed by default; the
 * file may hold thousands of genes, so the user adds the ones they want.
 *
 * Independent of Xenium: the viewer supplies loading and the overlay.
 */

import { GENE_COLORS, GROUP_COLORS, paletteColor } from './transcript-colors.js';
import { DEFAULT_OPACITY, TranscriptsLayer } from './transcripts-layer.js';
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
	opacity?: number;
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
	private status: TranscriptsPanelModel['status'];
	private message: string | null = null;
	private groups: Group[];
	private genes: Gene[] = [];
	private filter: string[] = [];
	private minQv = 20;
	private size = 1;
	private opacity = DEFAULT_OPACITY;
	private loading: Promise<void> | null = null;

	constructor(private readonly host: TranscriptsWorkspaceHost, private readonly pixelSizeUm: number, definitions: TranscriptGroupDefinition[]) {
		this.layer = new TranscriptsLayer(() => this.host.requestRender(), 0.8 / pixelSizeUm);
		this.host.addOverlay(this.layer);
		this.status = host.available ? 'idle' : 'unavailable';
		this.groups = definitions.map(definition => ({ ...definition, palette: false, added: false, user: false }));
	}

	get loaded(): boolean { return this.index !== null; }

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
			index.genes.forEach((gene, position) => { this.geneIndex.set(gene, position); });
			this.status = 'ready';
			this.message = null;
			this.layer.setMinQv(this.minQv);
			this.layer.setSize(this.size);
			this.layer.setOpacity(this.opacity);
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

	/** The groups from settings changed: add new ones, update the genes and colours of known ones, drop those that were removed. */
	setDefinitions(definitions: TranscriptGroupDefinition[]): void {
		const wanted = new Set(definitions.map(definition => definition.name));
		for (const definition of definitions) {
			const existing = this.group(definition.name);
			if (!existing) { this.groups.push({ ...definition, palette: false, added: false, user: false }); }
			else if (!existing.user) { existing.genes = definition.genes; existing.color = definition.color; }
		}
		this.groups = this.groups.filter(group => group.user || wanted.has(group.name));
		this.filter = this.filter.filter(name => this.group(name));
		this.sync();
	}

	// --- changes ------------------------------------------------------------

	private ensure(name: string, visible: boolean): void {
		const existing = this.genes.find(gene => gene.name === name);
		if (existing) { existing.visible = visible || existing.visible; return; }
		this.genes.push({ name, visible, color: GENE_COLORS[this.genes.length % GENE_COLORS.length] });
	}

	/** A group of the given genes, named Group N. */
	private createFromSelected(only?: string[]): string | null {
		const limit = only && new Set(only);
		const genes = this.genes.filter(gene => gene.visible && (!limit || limit.has(gene.name))).map(gene => gene.name);
		if (genes.length === 0) { return 'Switch on at least one gene first.'; }
		let number = this.groups.length + 1;
		while (this.groups.some(group => group.name === `Group ${number}`)) { number++; }
		this.groups.push({ name: `Group ${number}`, genes, color: GROUP_COLORS[this.groups.length % GROUP_COLORS.length], palette: false, added: true, user: true });
		this.sync();
		return null;
	}

	private rename(group: Group, name: string): string | null {
		const clean = name.trim();
		if (!clean) { return 'Name the group.'; }
		if (clean === group.name) { return null; }
		if (this.groups.some(other => other !== group && other.name === clean)) { return `There is already a group called ${clean}.`; }
		this.filter = this.filter.map(entry => entry === group.name ? clean : entry);
		group.name = clean;
		// A renamed group is saved with the session, whatever defined it.
		group.user = true;
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
			name: group.name, color: group.color, genes: [...group.genes], total: group.genes.length, found: found.length, on,
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
			rename: name => this.rename(group, name),
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
			minQv: this.minQv, size: this.size, opacity: this.opacity,
			load: () => { void this.load(); },
			addGene: name => { this.ensure(name, true); this.sync(); },
			addGroup: name => { const group = this.group(name); if (group) { group.added = true; void this.load(); this.sync(); } },
			groupFromSelected: names => this.createFromSelected(names),
			removeListed: names => { const drop = names && new Set(names); this.genes = drop ? this.genes.filter(gene => !drop.has(gene.name)) : []; this.sync(); },
			showAllListed: (visible, only) => {
				const names = new Set(only ?? listed.map(gene => gene.name));
				for (const gene of this.genes) { if (names.has(gene.name)) { gene.visible = visible; } }
				this.sync();
			},
			clearFilter: () => { this.filter = []; this.sync(); },
			setMinQv: value => { this.minQv = value; this.layer.setMinQv(value); this.host.notify(); },
			setSize: value => { this.size = value; this.layer.setSize(value); this.host.notify(); },
			setOpacity: value => { this.opacity = value; this.layer.setOpacity(value); this.host.notify(); },
		};
	}

	// --- persistence --------------------------------------------------------

	getState(): TranscriptsWorkspaceState {
		return {
			groups: this.groups.map(group => ({ name: group.name, genes: group.genes, color: group.color, palette: group.palette, added: group.added, user: group.user })),
			genes: this.genes.map(gene => ({ ...gene })), filter: this.filter, minQv: this.minQv, size: this.size, opacity: this.opacity,
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
		this.opacity = state.opacity ?? DEFAULT_OPACITY;
		this.layer.setOpacity(this.opacity);
		this.layer.setMinQv(this.minQv);
		this.layer.setSize(this.size);
		this.sync();
	}
}
