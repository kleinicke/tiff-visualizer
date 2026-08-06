"use strict";

import {
	autoRange,
	channelStats,
	CHANNEL_PALETTE,
	type ChannelPlane,
	type ChannelSettings,
} from './channel-composite.js';
import { COLORMAP_NAMES } from './colormaps.js';

/**
 * The Channels panel: one row per channel, the way every acquisition package
 * presents it.
 *
 * Same construction as `debayer-panel.ts` / `measure-panel.ts` — its own DOM on
 * `document.body`, theme variables, dragged by the header — so this adds a
 * surface rather than a paradigm. It appears only for images that actually have
 * several channels, and compositing stays off until switched on, so
 * single-channel viewing is untouched.
 */

export interface ChannelsPanelHost {
	getPlanes: () => ChannelPlane[];
	getSettings: () => ChannelSettings[];
	setSettings: (settings: ChannelSettings[]) => void;
	isComposite: () => boolean;
	setComposite: (enabled: boolean) => void;
	getSolo: () => number | null;
	setSolo: (index: number | null) => void;
	/** Re-render the image with the current settings. */
	onChange: (options?: { interactive?: boolean }) => void;
	/** Which backend drew the last composite, for the status line. */
	getBackend?: () => 'webgpu' | 'cpu';
}

export class ChannelsPanel {
	private root: HTMLDivElement;
	private body: HTMLDivElement;
	private host: ChannelsPanelHost;
	private isDragging = false;
	private dragOffset = { x: 0, y: 0 };

	constructor(host: ChannelsPanelHost) {
		this.host = host;

		this.root = document.createElement('div');
		this.root.className = 'channels-panel';
		this.root.style.display = 'none';

		const header = document.createElement('div');
		header.className = 'channels-header';
		const title = document.createElement('div');
		title.className = 'channels-title';
		title.textContent = 'Channels';
		const spacer = document.createElement('div');
		spacer.className = 'channels-spacer';

		const compositeToggle = document.createElement('button');
		compositeToggle.className = 'measure-chip';
		compositeToggle.textContent = 'Composite';
		compositeToggle.title = 'Show all visible channels at once, additively blended (C)';
		compositeToggle.onclick = () => {
			this.host.setComposite(!this.host.isComposite());
			this.render();
		};
		this.compositeToggle = compositeToggle;

		const closeButton = document.createElement('button');
		closeButton.className = 'measure-close';
		closeButton.textContent = '×';
		closeButton.title = 'Close the channels panel';
		closeButton.onclick = () => this.hide();

		header.append(title, spacer, compositeToggle, closeButton);
		header.style.cursor = 'move';
		header.onmousedown = event => this.startDrag(event);

		this.body = document.createElement('div');
		this.body.className = 'channels-body';

		this.root.append(header, this.body);

		// Keep panel interaction away from the image's pan/zoom handlers.
		// 'mouseup' is deliberately absent, as in the other panels: swallowing it
		// strands the drag listeners and glues the panel to the cursor.
		for (const type of ['mousedown', 'click', 'dblclick', 'wheel', 'contextmenu']) {
			this.root.addEventListener(type, event => event.stopPropagation());
		}

		document.body.appendChild(this.root);
	}

	private compositeToggle: HTMLButtonElement;

	show(): void {
		this.root.style.display = 'flex';
		this.render();
	}

	hide(): void { this.root.style.display = 'none'; }
	isVisible(): boolean { return this.root.style.display !== 'none'; }
	toggle(): void { if (this.isVisible()) { this.hide(); } else { this.show(); } }

	render(): void {
		this.compositeToggle.classList.toggle('active', this.host.isComposite());
		this.body.textContent = '';

		const planes = this.host.getPlanes();
		if (planes.length < 2) {
			const note = document.createElement('div');
			note.className = 'measure-note';
			note.textContent = 'This image has a single channel.';
			this.body.appendChild(note);
			return;
		}

		const settings = this.host.getSettings();
		const solo = this.host.getSolo();

		for (let i = 0; i < planes.length; i++) {
			this.body.appendChild(this.buildRow(planes[i], settings[i], i, solo));
		}

		const actions = document.createElement('div');
		actions.className = 'measure-button-row';
		actions.append(
			this.button('Auto range all', () => {
				const next = this.host.getSettings().map((setting, index) => ({
					...setting,
					...autoRange(planes[index]),
				}));
				this.host.setSettings(next);
				this.host.onChange();
				this.render();
			}),
			this.button('Full range all', () => {
				const next = this.host.getSettings().map((setting, index) => {
					const stats = channelStats(planes[index]);
					return { ...setting, min: stats.min, max: stats.max };
				});
				this.host.setSettings(next);
				this.host.onChange();
				this.render();
			}),
			this.button('Show all', () => {
				this.host.setSolo(null);
				this.host.setSettings(this.host.getSettings().map(setting => ({ ...setting, visible: true })));
				this.host.onChange();
				this.render();
			}),
		);
		this.body.appendChild(actions);

		const hint = document.createElement('div');
		hint.className = 'measure-note';
		const backend = this.host.getBackend?.() ?? 'cpu';
		hint.textContent = this.host.isComposite()
			? `Channels are added together, each scaled by its own range — the way emission combines at the detector. Compositing on ${backend === 'webgpu' ? 'the GPU (WebGPU)' : 'the CPU'}.`
			: 'Composite is off; the image is shown as decoded. Turn it on to blend the channels.';
		this.body.appendChild(hint);
	}

	private buildRow(
		plane: ChannelPlane,
		setting: ChannelSettings,
		index: number,
		solo: number | null,
	): HTMLElement {
		const row = document.createElement('div');
		row.className = 'channel-row';
		if (solo !== null && solo !== plane.index) { row.classList.add('dimmed'); }

		const top = document.createElement('div');
		top.className = 'channel-row-top';

		const visible = document.createElement('input');
		visible.type = 'checkbox';
		visible.checked = setting.visible;
		visible.title = 'Include this channel in the composite';
		visible.onchange = () => this.update(index, { visible: visible.checked });

		const swatch = document.createElement('input');
		swatch.type = 'color';
		swatch.className = 'channel-swatch';
		swatch.value = setting.color;
		swatch.title = 'Channel tint';
		swatch.oninput = () => this.update(index, { color: swatch.value }, { interactive: true });
		swatch.onchange = () => this.update(index, { color: swatch.value });

		const name = document.createElement('span');
		name.className = 'channel-name';
		name.textContent = plane.name;
		name.title = plane.name;

		const soloButton = document.createElement('button');
		soloButton.className = 'measure-chip channel-solo';
		soloButton.textContent = 'Solo';
		soloButton.title = 'Show only this channel. Solo is a view, not a change to the settings.';
		soloButton.classList.toggle('active', solo === plane.index);
		soloButton.onclick = () => {
			this.host.setSolo(solo === plane.index ? null : plane.index);
			this.host.onChange();
			this.render();
		};

		top.append(visible, swatch, name, soloButton);
		row.appendChild(top);

		// Range. Sliders are laid over the channel's own statistics, so the ends
		// of the track mean something rather than being arbitrary.
		const stats = channelStats(plane, Math.max(1, Math.floor(plane.data.length / 200_000)));
		const span = stats.max - stats.min || 1;
		const rangeRow = document.createElement('div');
		rangeRow.className = 'channel-range';

		const makeSlider = (which: 'min' | 'max') => {
			const slider = document.createElement('input');
			slider.type = 'range';
			slider.min = '0';
			slider.max = '1000';
			slider.step = '1';
			slider.className = 'channel-slider';
			slider.value = String(Math.round(((setting[which] - stats.min) / span) * 1000));
			slider.title = which === 'min' ? 'Black point' : 'White point';
			const apply = (interactive: boolean) => {
				const value = stats.min + (Number(slider.value) / 1000) * span;
				const current = this.host.getSettings()[index];
				// Keep the two handles ordered; crossing them would invert the
				// channel silently rather than doing nothing.
				const next = which === 'min'
					? { min: Math.min(value, current.max) }
					: { max: Math.max(value, current.min) };
				this.update(index, next, { interactive, skipRender: interactive });
			};
			slider.oninput = () => apply(true);
			slider.onchange = () => apply(false);
			return slider;
		};

		rangeRow.append(makeSlider('min'), makeSlider('max'));
		row.appendChild(rangeRow);

		const readout = document.createElement('div');
		readout.className = 'channel-readout';
		readout.textContent = `${formatShort(setting.min)} – ${formatShort(setting.max)}`;
		row.appendChild(readout);

		const controls = document.createElement('div');
		controls.className = 'channel-controls';

		const opacity = document.createElement('input');
		opacity.type = 'range';
		opacity.min = '0';
		opacity.max = '100';
		opacity.value = String(Math.round(setting.opacity * 100));
		opacity.className = 'channel-slider';
		opacity.title = 'Channel opacity';
		opacity.oninput = () => this.update(index, { opacity: Number(opacity.value) / 100 }, { interactive: true, skipRender: true });
		opacity.onchange = () => this.update(index, { opacity: Number(opacity.value) / 100 });

		const colormap = document.createElement('select');
		colormap.className = 'measure-select channel-colormap';
		colormap.title = 'Use a colormap instead of a flat tint';
		for (const option of ['none', ...COLORMAP_NAMES]) {
			const element = document.createElement('option');
			element.value = option;
			element.textContent = option === 'none' ? 'Tint' : option;
			colormap.appendChild(element);
		}
		colormap.value = setting.colormap || 'none';
		colormap.onchange = () => this.update(index, { colormap: colormap.value });

		controls.append(opacity, colormap);
		row.appendChild(controls);

		// Auto-range per channel, because ranges are rarely wrong for all of them
		// at once — usually one dim channel needs pulling up.
		const autoButton = this.button('Auto', () => {
			this.update(index, autoRange(plane));
		});
		autoButton.classList.add('channel-auto');
		row.appendChild(autoButton);

		return row;
	}

	private update(
		index: number,
		patch: Partial<ChannelSettings>,
		options: { interactive?: boolean; skipRender?: boolean } = {},
	): void {
		const settings = this.host.getSettings().slice();
		settings[index] = { ...settings[index], ...patch };
		this.host.setSettings(settings);
		this.host.onChange({ interactive: options.interactive });
		// Rebuilding the panel mid-drag would recreate the slider under the
		// cursor and end the gesture.
		if (!options.skipRender) { this.render(); }
	}

	private button(label: string, onClick: () => void): HTMLButtonElement {
		const button = document.createElement('button');
		button.className = 'measure-button';
		button.textContent = label;
		button.onclick = onClick;
		return button;
	}

	private startDrag(event: MouseEvent): void {
		const rect = this.root.getBoundingClientRect();
		this.isDragging = true;
		this.dragOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top };

		const onMouseMove = (moveEvent: MouseEvent) => {
			if (!this.isDragging) { return; }
			const x = moveEvent.clientX - this.dragOffset.x;
			const y = moveEvent.clientY - this.dragOffset.y;
			this.root.style.left = `${Math.max(0, Math.min(x, window.innerWidth - this.root.offsetWidth))}px`;
			this.root.style.top = `${Math.max(0, Math.min(y, window.innerHeight - this.root.offsetHeight))}px`;
			this.root.style.right = 'auto';
			this.root.style.bottom = 'auto';
		};
		const onMouseUp = () => {
			this.isDragging = false;
			document.removeEventListener('mousemove', onMouseMove, true);
			document.removeEventListener('mouseup', onMouseUp, true);
			window.removeEventListener('blur', onMouseUp);
		};
		document.addEventListener('mousemove', onMouseMove, true);
		document.addEventListener('mouseup', onMouseUp, true);
		window.addEventListener('blur', onMouseUp);
	}
}

function formatShort(value: number): string {
	if (!Number.isFinite(value)) { return '—'; }
	const magnitude = Math.abs(value);
	if (magnitude !== 0 && (magnitude < 0.01 || magnitude >= 100000)) { return value.toExponential(2); }
	return String(Math.round(value * 100) / 100);
}
