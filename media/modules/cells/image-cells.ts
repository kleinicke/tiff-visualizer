/**
 * The Cells feature of the single-image viewer: workspace and overlay. The
 * Cells section itself is the last section of the Channels panel.
 *
 * Loaded on first use, so an image nobody asks cells for pays for none of it.
 * Showing the section is a view action and creates nothing: the workspace (and
 * with it the overlay canvas) appears on the first thing that needs one, such
 * as adding a segmentation.
 */

import { CellsWorkspace, type CellsWorkspaceHost, type WorkspaceFile } from './cells-workspace.js';
import type { CellsPanelModel } from './cells-model.js';
import { ImageCellsOverlay } from './image-cells-overlay.js';
import { maskScaleFor } from './mask-cells.js';

export interface ImageCellsHost {
	getImageElement: () => HTMLElement | null;
	getImageSize: () => { width: number; height: number } | null;
	/** Microns per pixel, or null when the image has no micron scale. */
	getMicronsPerPixel: () => number | null;
	/** `tiffVisualizer.cells.cellIdCol`: other names for the cell id column. */
	getIdColumns: () => string[];
	postMessage: (message: { type: 'resolveCell'; requestId: number; text: string } | { type: 'browseCell'; requestId: number }) => void;
	/** The workspace changed: re-render the panel and save state. */
	onChange: () => void;
}

const UNSCALED = 'This image has no micron scale, so cell coordinates are read as pixels.';

export class ImageCells {
	private workspace: CellsWorkspace | null = null;
	private resource: string | null = null;
	private readonly overlay: ImageCellsOverlay;
	private readonly requests = new Map<number, { resolve: (file: WorkspaceFile | null) => void; reject: (error: Error) => void }>();
	private counter = 0;

	constructor(private readonly host: ImageCellsHost) {
		this.overlay = new ImageCellsOverlay(host);
	}

	hasWorkspace(): boolean { return this.workspace !== null; }
	redraw(): void { this.overlay.scheduleRedraw(); }

	/** Tell the panel which file is open. Cells belong to a file, so a different one starts clean. */
	setResource(resource: string): void {
		if (resource === this.resource) { return; }
		this.resource = resource;
		this.workspace = null;
		this.overlay.clear();
		this.host.onChange();
	}

	/** A reply to `resolveCell` or `browseCell`. */
	onHostFile(message: { requestId: number; spec?: unknown; error?: string; cancelled?: boolean }): void {
		const request = this.requests.get(message.requestId);
		this.requests.delete(message.requestId);
		if (!request) { return; }
		if (message.error) { request.reject(new Error(message.error)); }
		else { request.resolve(message.cancelled || !message.spec ? null : message.spec as WorkspaceFile); }
	}

	dispose(): void { this.overlay.clear(); }

	private ask(type: 'resolveCell' | 'browseCell', text = ''): Promise<WorkspaceFile | null> {
		return new Promise((resolve, reject) => {
			const requestId = ++this.counter;
			this.requests.set(requestId, { resolve, reject });
			this.host.postMessage(type === 'resolveCell' ? { type, requestId, text } : { type, requestId });
		});
	}

	private ensure(): CellsWorkspace {
		if (this.workspace) { return this.workspace; }
		const pixelSize = this.host.getMicronsPerPixel() ?? 1;
		const host: CellsWorkspaceHost = {
			load: async file => (await import('../scene/xenium-cells.js')).loadCellSource(
				{ src: file.src, bytes: file.bytes, kind: file.kind, name: file.path }, pixelSize,
				{ idColumns: this.host.getIdColumns(), maskScale: (width, height) => maskScaleFor({ width, height }, this.host.getImageSize()) },
			),
			resolve: async text => {
				const file = await this.ask('resolveCell', text);
				if (!file) { throw new Error('Cancelled'); }
				return file;
			},
			browse: () => this.ask('browseCell'),
			addOverlay: layer => this.overlay.add(layer),
			removeOverlay: layer => this.overlay.remove(layer),
			requestRender: () => this.overlay.scheduleRedraw(),
			notify: () => this.host.onChange(),
		};
		this.workspace = new CellsWorkspace(host, pixelSize);
		return this.workspace;
	}

	/** The Cells section's model: what is loaded, or an empty section whose first action creates the workspace. */
	model(): CellsPanelModel {
		if (this.workspace) { return this.workspace.snapshot(null); }
		return {
			status: this.host.getMicronsPerPixel() === null ? UNSCALED : null,
			sets: [], pending: [], sourceMessage: null,
			addSource: text => this.ensure().snapshot(null).addSource(text),
			browseSource: () => this.ensure().snapshot(null).browseSource(),
			loadSource: () => undefined,
			removeSource: () => undefined,
		};
	}
}
