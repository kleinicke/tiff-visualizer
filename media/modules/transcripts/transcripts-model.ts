/** What the Transcripts section shows and can do; the Svelte components only see this. */

export interface TranscriptGeneRow {
	name: string;
	color: string;
	visible: boolean;
	/** Coloured by a group, so the swatch is not editable. */
	grouped: boolean;
	count: number;
	/** Shown, but its positions are still being read. */
	loading: boolean;
	setVisible: (visible: boolean) => void;
	setColor: (color: string) => void;
	remove: () => void;
}

export interface TranscriptGroupRow {
	name: string;
	color: string;
	/** Genes the group names, and how many of them the file has. */
	total: number;
	found: number;
	on: number;
	missing: string[];
	state: 'none' | 'some' | 'all';
	palette: boolean;
	filtering: boolean;
	toggle: () => void;
	setColor: (color: string) => void;
	setPalette: (palette: boolean) => void;
	toggleFilter: () => void;
	/** Take this group's genes out of the gene list. */
	removeAll: () => void;
	/** Take the group out of the viewer (its genes stay listed). */
	remove: () => void;
}

export interface TranscriptsPanelModel {
	status: 'unavailable' | 'idle' | 'loading' | 'ready' | 'error';
	/** Progress or failure text. */
	message: string | null;
	/** Genes whose positions are being read, and how far along (e.g. "3 of 24 row groups"). */
	fetching: number;
	readProgress: string | null;
	points: number;
	/** Every gene in the list, and the ones the group filters leave showing. */
	genes: TranscriptGeneRow[];
	listed: TranscriptGeneRow[];
	groups: TranscriptGroupRow[];
	/** Groups that are defined but not in the viewer. */
	groupChoices: { name: string; size: number }[];
	/** Gene names in the file that are not in the list. */
	geneChoices: () => string[];
	geneCount: (name: string) => number;
	filtering: boolean;
	minQv: number;
	size: number;
	load: () => void;
	addGene: (name: string) => void;
	addGroup: (name: string) => void;
	createGroup: (name: string, genes: string) => string | null;
	groupFromListed: (name: string) => string | null;
	clearGenes: () => void;
	showAllListed: (visible: boolean) => void;
	clearFilter: () => void;
	setMinQv: (value: number) => void;
	setSize: (value: number) => void;
}
