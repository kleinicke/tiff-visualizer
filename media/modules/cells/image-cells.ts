/**
 * The Cells feature of the single-image viewer: panel, workspace and overlay.
 *
 * Loaded on first use, so an image nobody asks cells for pays for none of it.
 * Opening the panel is a view action and creates nothing: the workspace (and
 * with it the overlay canvas) appears on the first thing that needs one, such
 * as adding a segmentation.
 */

import { CellsWorkspace, type CellsWorkspaceHost, type WorkspaceFile } from './cells-workspace.js';
import type { CellsPanelModel } from './cells-model.js';
import { CellsPanel } from './cells-panel.js';
import { ImageCellsOverlay } from './image-cells-overlay.js';

export interface ImageCellsHost {
	getImageElement: () => HTMLElement | null;
	getImageSize: () => { width: number; height: number } | null;
	/** Microns per pixel, or null when the image has no micron scale. */
	getMicronsPerPixel: () => number | null;
	postMessage: (message: { type: 'resolveCell'; requestId: number; text: string } | { type: 'browseCell'; requestId: number }) => void;
	/** The panel opened or closed, or the workspace changed. */
	onChange: () => void;
}

const UNSCALED = 'This image has no micron scale, so cell coordinates are read as pixels.';

export class ImageCells {
	private workspace: CellsWorkspace | null = null;
	private resource: string | null = null;
	private readonly overlay: ImageCellsOverlay;
	private readonly panel: CellsPanel;
	private readonly requests = new Map<number, { resolve: (file: WorkspaceFile | null) => void; reject: (error: Error) => void }>();
	private counter = 0;

	constructor(private readonly host: ImageCellsHost) {
		this.overlay = new ImageCellsOverlay(host);
		this.panel = new CellsPanel(() => this.model(), () => host.onChange());
	}

	show(): void { this.panel.show(); }
	hide(): void { this.panel.hide(); }
	toggle(): void { this.panel.toggle(); }
	isVisible(): boolean { return this.panel.isVisible(); }
	hasWorkspace(): boolean { return this.workspace !== null; }
	redraw(): void { this.overlay.scheduleRedraw(); }

	/** Tell the panel which file is open. Cells belong to a file, so a different one starts clean. */
	setResource(resource: string): void {
		if (resource === this.resource) { return; }
		this.resource = resource;
		this.workspace = null;
		this.overlay.clear();
		this.panel.render();
	}

	/** A reply to `resolveCell` or `browseCell`. */
	onHostFile(message: { requestId: number; spec?: unknown; error?: string; cancelled?: boolean }): void {
		const request = this.requests.get(message.requestId);
		this.requests.delete(message.requestId);
		if (!request) { return; }
		if (message.error) { request.reject(new Error(message.error)); }
		else { request.resolve(message.cancelled || !message.spec ? null : message.spec as WorkspaceFile); }
	}

	dispose(): void { this.overlay.clear(); this.panel.dispose(); }

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
			load: async file => (await import('../scene/xenium-cells.js')).loadCellSource({ src: file.src, bytes: file.bytes, kind: file.kind }, pixelSize),
			resolve: async text => {
				const file = await this.ask('resolveCell', text);
				if (!file) { throw new Error('Cancelled'); }
				return file;
			},
			browse: () => this.ask('browseCell'),
			addOverlay: layer => this.overlay.add(layer),
			removeOverlay: layer => this.overlay.remove(layer),
			requestRender: () => this.overlay.scheduleRedraw(),
			notify: () => { this.panel.render(); this.host.onChange(); },
		};
		this.workspace = new CellsWorkspace(host, pixelSize);
		return this.workspace;
	}

	private model(): CellsPanelModel {
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
