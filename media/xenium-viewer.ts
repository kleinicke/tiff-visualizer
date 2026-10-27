"use strict";

/**
 * Webview app for a Xenium output bundle (`experiment.xenium`).
 *
 * The extension host reads the manifest and posts it as a `scene` message; this
 * page opens each morphology channel as a pyramid, builds a `SceneViewer`, and
 * drives the Channels panel the single-image viewer uses (same component, same
 * arithmetic). It is a separate bundle from `imagePreview.ts` on purpose: that
 * file coordinates one decoded image, and a scene of several pyramid files
 * shares none of its load pipeline.
 */

import { openContextMenu, type MenuItem } from '../ui/context-menu';
import { ChannelsPanel } from './modules/channels-panel.js';
import { codecWasmModule } from './modules/codec-wasm-wrapper.js';
import {
	defaultChannelSettings, parseChannelGroups, resolveChannelGroups, suggestedChannelColors,
	type ChannelPlane, type ChannelSettings,
} from './modules/channel-composite.js';
import { TiffChannelSource } from './modules/scene/channel-source.js';
import { CellsController, type CellsControllerState } from './modules/cells/cells-controller.js';
import { CellsLayer } from './modules/cells/cells-layer.js';
import { statusCellsModel, type CellsModel } from './modules/cells/cells-model.js';
import { findColumn, formatValue } from './modules/cells/cell-table.js';
import { loadXeniumCells } from './modules/scene/xenium-cells.js';
import { SceneViewer } from './modules/scene/scene-viewer.js';
import type { Camera } from './modules/scene/pyramid.js';
import { omeChannelHints, purposeTint, type SceneManifest } from './modules/scene/xenium-manifest.js';
import type { ChannelDefaults } from '../shared/viewer-settings';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): any; setState(state: unknown): void };

interface PersistedState {
	names: string[];
	channelSettings: ChannelSettings[];
	camera?: Camera;
	cells?: CellsControllerState;
}

const vscode = acquireVsCodeApi();
const root = document.getElementById('scene-root')!;
const startup = JSON.parse(document.getElementById('xenium-settings')?.dataset.settings || '{}') as { channelDefaults?: ChannelDefaults };

let viewer: SceneViewer | null = null;
let pixelSizeUm = 1;
let panel: ChannelsPanel | null = null;
let cellsStatus: CellsModel | null = null;
let cellsController: CellsController | null = null;
let cellsLayer: CellsLayer | null = null;
let settings: ChannelSettings[] = [];
let soloChannel: number | null = null;
let soloGroup: string | null = null;
/** Channels a solo switched on, so ending the solo can switch them off again. */
let soloShown: number[] = [];
let started = false;

// --- loading / error overlay ------------------------------------------------

const overlay = document.createElement('div');
overlay.className = 'scene-status';
root.append(overlay);

function showStatus(text: string, error = false): void {
	overlay.textContent = text;
	overlay.classList.toggle('error', error);
	overlay.style.display = 'flex';
	if (error) {
		const button = document.createElement('button');
		button.className = 'measure-button';
		button.textContent = 'Open as text';
		button.addEventListener('click', () => vscode.postMessage({ type: 'openAsText' }));
		overlay.append(button);
	}
}

function hideStatus(): void { overlay.style.display = 'none'; }

// --- solo -------------------------------------------------------------------

function applySolo(indices: number[] | null): void {
	// Soloing shows the chosen channels even if they were off, and remembers
	// which ones it switched on so that ending the solo puts them back.
	for (const index of soloShown) { if (settings[index]) { settings[index] = { ...settings[index], visible: false }; } }
	soloShown = [];
	if (indices) {
		for (const index of indices) {
			if (settings[index] && !settings[index].visible) { settings[index] = { ...settings[index], visible: true }; soloShown.push(index); }
		}
	}
}

function soloIndices(): readonly number[] | null {
	if (soloGroup) {
		const group = resolveChannelGroups(parseChannelGroups(startup.channelDefaults?.groups), planes()).find(entry => entry.name === soloGroup);
		if (group) { return group.positions.map(position => planes()[position].index); }
	}
	return soloChannel === null ? null : [soloChannel];
}

function planes(): ChannelPlane[] { return viewer?.overviewPlanes ?? []; }

function persist(): void {
	if (!viewer) { return; }
	const state: PersistedState = { names: planes().map(plane => plane.name), channelSettings: settings, camera: viewer.currentCamera, cells: cellsController?.getState() };
	vscode.setState(state);
}

// --- cells ------------------------------------------------------------------

/** Load outlines and the cell table after the image is up, then add the layer and its section. */
async function loadCells(manifest: SceneManifest, restored: CellsControllerState | undefined): Promise<void> {
	if (!manifest.cells || !viewer) { return; }
	const scene = viewer;
	cellsStatus = statusCellsModel('Loading cells…');
	panel?.render();
	try {
		const loaded = await loadXeniumCells(manifest.cells, manifest.pixelSizeUm);
		const layer = new CellsLayer({
			cells: loaded.cells,
			nuclei: loaded.nuclei,
			rowCount: loaded.table.count,
			invalidate: () => scene.requestRender(),
			onSelectionChange: () => panel?.render(),
			describeRow: row => {
				const column = findColumn(loaded.table, cellsController?.getState().metric ?? null);
				return column ? `${loaded.table.ids[row]} · ${column.name} ${formatValue(column, row)}` : loaded.table.ids[row];
			},
		});
		cellsLayer = layer;
		cellsController = new CellsController(loaded.table, layer, () => { panel?.render(); persist(); }, restored);
		scene.addOverlay(layer);
		cellsStatus = null;
	} catch (error) {
		cellsStatus = statusCellsModel(`Cells could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
	}
	panel?.render();
}

// --- start ------------------------------------------------------------------

async function start(manifest: SceneManifest): Promise<void> {
	if (started) { return; }
	started = true;
	try {
		showStatus('Preparing the image decoder…');
		const codec = await codecWasmModule();
		let opened = 0;
		const sources = await Promise.all(manifest.channels.map(async channel => {
			const source = await TiffChannelSource.open(channel.src, codec);
			showStatus(`Opened ${++opened} of ${manifest.channels.length} channel files…`);
			return source;
		}));

		// Every file carries the same OME-XML, which names the channels and maps
		// each to its file; the file names are only the fallback.
		const hints = omeChannelHints(sources.map(source => source.description).find(Boolean));
		const hintFor = (position: number) => hints.find(hint => hint.fileName === manifest.channels[position].fileName) ?? hints[position];
		const names = manifest.channels.map((channel, position) => hintFor(position)?.name ?? channel.fallbackName);

		const persisted = vscode.getState() as PersistedState | undefined;
		const restorable = persisted && persisted.names?.length === names.length && persisted.names.every((name, index) => name === names[index])
			? persisted : undefined;

		showStatus('Reading the overview…');
		pixelSizeUm = manifest.pixelSizeUm;
		viewer = await SceneViewer.create({
			container: root,
			sources,
			names,
			pixelSizeUm: manifest.pixelSizeUm,
			getSettings: () => settings,
			getSolo: soloIndices,
			initialCamera: restorable?.camera,
			onCameraChange: persist,
		});

		const colors = suggestedChannelColors(viewer.overviewPlanes, manifest.channels.map((_channel, position) => purposeTint(hintFor(position)?.purpose)), startup.channelDefaults);
		settings = defaultChannelSettings(viewer.overviewPlanes, { colors });
		// The instrument's own suggested range is a better first view than a percentile.
		settings = settings.map((setting, position) => {
			const hint = hintFor(position);
			// Four stains are four stains: the RGBA "alpha is data" default does not apply.
			const shown = { ...setting, visible: true };
			return hint?.lutMin !== undefined && hint.lutMax !== undefined && hint.lutMax > hint.lutMin
				? { ...shown, min: hint.lutMin, max: hint.lutMax } : shown;
		});
		if (restorable?.channelSettings.length === settings.length) { settings = restorable.channelSettings; }

		panel = new ChannelsPanel({
			getPlanes: planes,
			getSettings: () => settings,
			setSettings: next => { settings = next; },
			isComposite: () => true,
			setComposite: () => undefined,
			getSolo: () => soloChannel,
			setSolo: index => { soloChannel = index; soloGroup = null; applySolo(index === null ? null : [index]); },
			onChange: () => { viewer?.invalidate(); persist(); },
			getCells: () => cellsController ? cellsController.snapshot() : cellsStatus,
			getGroups: () => resolveChannelGroups(parseChannelGroups(startup.channelDefaults?.groups), planes()),
			getGroupSolo: () => soloGroup,
			setGroupSolo: name => {
				soloGroup = name;
				if (name) { soloChannel = null; }
				applySolo(name ? [...(soloIndices() ?? [])] : null);
			},
		});
		panel.show();
		hideStatus();
		viewer.invalidate();
		if (manifest.cells) { void loadCells(manifest, restorable?.cells); }
	} catch (error) {
		started = false;
		showStatus(error instanceof Error ? error.message : String(error), true);
		vscode.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
	}
}

window.addEventListener('message', event => {
	const message = event.data;
	if (message?.type === 'scene' && message.manifest) { void start(message.manifest as SceneManifest); }
	else if (message?.type === 'error') { showStatus(String(message.message || 'The bundle could not be opened.'), true); }
	else if (message?.type === 'toggleChannels') { panel?.toggle(); }
});

document.addEventListener('contextmenu', event => {
	const target = event.target as HTMLElement | null;
	if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) { return; }
	event.preventDefault();
	const defer = (label: string, action: () => void): MenuItem => ({ label, action: () => { setTimeout(action, 0); } });
	const point = viewer?.sceneAt(event.clientX, event.clientY) ?? null;
	const micron = pixelSizeUm;
	const items: MenuItem[] = [{ heading: true, label: 'Display' }];
	items.push(defer('Fit to View', () => viewer?.fit()));
	items.push(defer('Toggle Channels Panel', () => panel?.toggle()));
	items.push({ heading: true, label: 'Inspect' });
	if (point) {
		const px = `${Math.floor(point.x)}, ${Math.floor(point.y)}`;
		items.push(defer('Copy Position (px)', () => { void navigator.clipboard?.writeText(px).catch((): void => undefined); }));
		items.push(defer('Copy Position (µm)', () => {
			void navigator.clipboard?.writeText(`${(point.x * micron).toFixed(1)}, ${(point.y * micron).toFixed(1)}`).catch((): void => undefined);
		}));
	}
	items.push({ heading: true, label: 'File' });
	items.push(defer('Open as Text', () => vscode.postMessage({ type: 'openAsText' })));
	openContextMenu(items, event.clientX, event.clientY);
});

window.addEventListener('keydown', event => {
	const target = event.target as HTMLElement | null;
	if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) { return; }
	if (event.key === 'Escape') { cellsLayer?.clearSelection(); }
	if ((event.key === 'c' || event.key === 'C') && !event.metaKey && !event.ctrlKey && !event.altKey) { panel?.toggle(); }
});

showStatus('Opening the Xenium bundle…');
vscode.postMessage({ type: 'ready' });
