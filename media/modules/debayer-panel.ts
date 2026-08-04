"use strict";

import {
	DEFAULT_DEBAYER,
	PATTERNS,
	getPatternInfo,
	type DebayerSettings,
	type DebayerView,
	type DebayerAlgorithm,
} from './debayer.js';

/**
 * Floating control panel for the debayer view mode.
 *
 * Built the same way as HistogramOverlay: its own DOM tree appended to
 * document.body, styled by classes in imagePreview.css using VS Code theme
 * variables, shown/hidden by toggling display. Every control change calls back
 * with a complete settings object; the caller owns persistence and re-render.
 */
export class DebayerPanel {
	private overlay: HTMLDivElement | null = null;
	private settings: DebayerSettings = { ...DEFAULT_DEBAYER };
	private onChange: (settings: DebayerSettings) => void;
	private isDragging = false;
	private dragOffset = { x: 0, y: 0 };

	private enableCheckbox: HTMLInputElement | null = null;
	private offsetButtons: HTMLButtonElement[] = [];
	private viewButtons: HTMLButtonElement[] = [];
	private gainInputs: HTMLInputElement[] = [];
	private offsetRow: HTMLDivElement | null = null;
	private statusLine: HTMLDivElement | null = null;

	constructor(onChange: (settings: DebayerSettings) => void) {
		this.onChange = onChange;
		this.createOverlay();
	}

	getSettings(): DebayerSettings {
		return { ...this.settings };
	}

	/** Adopt externally restored settings (persisted webview state) without
	 *  firing onChange. */
	setSettings(settings: Partial<DebayerSettings>): void {
		this.settings = { ...this.settings, ...settings };
		this.syncControls();
	}

	private emit(): void {
		this.syncControls();
		this.onChange(this.getSettings());
	}

	private createOverlay(): void {
		this.overlay = document.createElement('div');
		this.overlay.className = 'debayer-panel';
		this.overlay.style.display = 'none';

		const header = document.createElement('div');
		header.className = 'debayer-header';

		const title = document.createElement('div');
		title.className = 'debayer-title';
		title.textContent = 'Debayer';

		const enableLabel = document.createElement('label');
		enableLabel.className = 'debayer-enable';
		const enable = document.createElement('input');
		enable.type = 'checkbox';
		enable.checked = this.settings.enabled;
		enable.onchange = () => {
			this.settings.enabled = enable.checked;
			this.emit();
		};
		this.enableCheckbox = enable;
		enableLabel.appendChild(enable);
		enableLabel.appendChild(document.createTextNode('On'));

		const closeBtn = document.createElement('button');
		closeBtn.className = 'debayer-close';
		closeBtn.textContent = '×';
		closeBtn.title = 'Close debayer panel';
		closeBtn.onclick = () => this.hide();

		header.appendChild(title);
		header.appendChild(enableLabel);
		header.appendChild(closeBtn);

		const body = document.createElement('div');
		body.className = 'debayer-body';

		// --- pattern ---
		const patternSelect = document.createElement('select');
		patternSelect.className = 'debayer-select';
		for (const p of PATTERNS) {
			const opt = document.createElement('option');
			opt.value = p.id;
			opt.textContent = p.label;
			opt.title = p.description;
			patternSelect.appendChild(opt);
		}
		patternSelect.value = this.settings.pattern;
		patternSelect.onchange = () => {
			this.settings.pattern = patternSelect.value;
			this.settings.enabled = true;
			// A view that the new pattern cannot supply would silently show
			// nothing, so fall back to RGB.
			const info = getPatternInfo(this.settings.pattern);
			if (this.settings.view === 'i' && info.channels < 4) {
				this.settings.view = 'rgb';
			}
			this.emit();
		};
		body.appendChild(this.row('Pattern', patternSelect));

		// --- algorithm ---
		const algoSelect = document.createElement('select');
		algoSelect.className = 'debayer-select';
		const algos: { id: DebayerAlgorithm; label: string; title: string }[] = [
			{ id: 'malvar', label: 'Malvar-He-Cutler', title: 'Gradient-corrected linear. Best quality on detail. 2×2 Bayer only; other patterns use bilinear.' },
			{ id: 'bilinear', label: 'Bilinear', title: 'Plain linear interpolation. Works for every pattern.' },
			{ id: 'nearest', label: 'Nearest (no interpolation)', title: 'Copies the nearest sampled site. Invents no values — preferred for measurement.' },
		];
		for (const a of algos) {
			const opt = document.createElement('option');
			opt.value = a.id;
			opt.textContent = a.label;
			opt.title = a.title;
			algoSelect.appendChild(opt);
		}
		algoSelect.value = this.settings.algorithm;
		algoSelect.onchange = () => {
			this.settings.algorithm = algoSelect.value as DebayerAlgorithm;
			this.emit();
		};
		body.appendChild(this.row('Method', algoSelect));

		// --- phase offset ---
		// For 2×2 patterns this is redundant with the pattern dropdown (the four
		// names ARE the four phases) but it stays visible because it is how
		// cropped ROIs get corrected, and it is essential for 4×4/6×6 layouts.
		const offsetWrap = document.createElement('div');
		offsetWrap.className = 'debayer-offset';
		this.offsetButtons = (['X', 'Y'] as const).map(axis => {
			const btn = document.createElement('button');
			btn.className = 'debayer-button';
			btn.dataset.axis = axis;
			btn.title = `Shift the CFA phase by one pixel in ${axis}. Wraps at the pattern period.`;
			btn.onclick = () => {
				const period = getPatternInfo(this.settings.pattern).period;
				if (axis === 'X') {
					this.settings.offsetX = (this.settings.offsetX + 1) % period;
				} else {
					this.settings.offsetY = (this.settings.offsetY + 1) % period;
				}
				this.settings.enabled = true;
				this.emit();
			};
			offsetWrap.appendChild(btn);
			return btn;
		});
		this.offsetRow = this.row('Phase', offsetWrap);
		body.appendChild(this.offsetRow);

		// --- levels ---
		const levelWrap = document.createElement('div');
		levelWrap.className = 'debayer-levels';
		const black = this.numberInput('Black', this.settings.blackLevel, v => {
			this.settings.blackLevel = v;
			this.emit();
		});
		const white = this.numberInput('White', this.settings.whiteLevel, v => {
			this.settings.whiteLevel = v;
			this.emit();
		});
		levelWrap.appendChild(black);
		levelWrap.appendChild(white);
		const levelRow = this.row('Levels', levelWrap);
		levelRow.title = 'Sensor black/white level in raw units, e.g. 256 / 4351 for 12-bit data in uint16. Leave both at 0 to skip.';
		body.appendChild(levelRow);

		// --- white balance ---
		const wbWrap = document.createElement('div');
		wbWrap.className = 'debayer-wb';
		const autoBtn = document.createElement('button');
		autoBtn.className = 'debayer-button';
		autoBtn.textContent = 'Auto (gray world)';
		autoBtn.title = 'Estimate gains by assuming the scene averages to neutral. Fails on strongly tinted scenes — enter gains manually there.';
		autoBtn.onclick = () => {
			this.settings.autoWb = !this.settings.autoWb;
			this.settings.enabled = true;
			this.emit();
		};
		wbWrap.appendChild(autoBtn);

		const gainWrap = document.createElement('div');
		gainWrap.className = 'debayer-gains';
		this.gainInputs = (['R', 'G', 'B'] as const).map((name, i) => {
			const input = document.createElement('input');
			input.type = 'number';
			input.step = '0.01';
			input.min = '0';
			input.className = 'debayer-number';
			input.title = `${name} gain`;
			input.value = String([this.settings.gainR, this.settings.gainG, this.settings.gainB][i]);
			input.onchange = () => {
				const v = parseFloat(input.value);
				if (!Number.isFinite(v) || v < 0) { return; }
				if (i === 0) { this.settings.gainR = v; }
				else if (i === 1) { this.settings.gainG = v; }
				else { this.settings.gainB = v; }
				// Typing a gain means the user wants that gain, not the estimate.
				this.settings.autoWb = false;
				this.settings.enabled = true;
				this.emit();
			};
			const label = document.createElement('label');
			label.className = 'debayer-gain-label';
			label.appendChild(document.createTextNode(name));
			label.appendChild(input);
			gainWrap.appendChild(label);
			return input;
		});

		body.appendChild(this.row('White balance', wbWrap));
		body.appendChild(this.row('Gains', gainWrap));

		// --- channel view ---
		const viewWrap = document.createElement('div');
		viewWrap.className = 'debayer-views';
		const views: { id: DebayerView; label: string; title: string }[] = [
			{ id: 'rgb', label: 'RGB', title: 'Full colour composite' },
			{ id: 'r', label: 'R', title: 'Red channel only' },
			{ id: 'g', label: 'G', title: 'Green channel only' },
			{ id: 'b', label: 'B', title: 'Blue channel only' },
			{ id: 'i', label: 'IR', title: 'Fourth channel (IR / clear / white), if the pattern has one' },
			{ id: 'mosaic', label: 'Raw', title: 'Undemosaiced mosaic, as stored' },
		];
		this.viewButtons = views.map(v => {
			const btn = document.createElement('button');
			btn.className = 'debayer-button debayer-view-button';
			btn.textContent = v.label;
			btn.title = v.title;
			btn.dataset.view = v.id;
			btn.onclick = () => {
				this.settings.view = v.id;
				if (v.id !== 'mosaic') { this.settings.enabled = true; }
				this.emit();
			};
			viewWrap.appendChild(btn);
			return btn;
		});
		body.appendChild(this.row('View', viewWrap));

		// Single-channel views land on channels === 1, so the existing colormap
		// command applies to them — worth saying, since it is genuinely useful
		// for IR.
		this.statusLine = document.createElement('div');
		this.statusLine.className = 'debayer-status';
		body.appendChild(this.statusLine);

		this.overlay.appendChild(header);
		this.overlay.appendChild(body);

		header.style.cursor = 'move';
		header.onmousedown = e => this.startDrag(e);

		// Keep panel interaction out of the image's pan/zoom handlers, which
		// listen on the viewport container. Without this, clicking a control or
		// scrolling over the panel also zooms the image underneath.
		// 'mouseup' is deliberately absent: swallowing it strands the drag
		// listeners below when the button is released over the panel, leaving the
		// panel glued to the cursor. A stray mouseup reaching the viewport is
		// harmless, since panning starts on mousedown.
		for (const type of ['mousedown', 'click', 'dblclick', 'wheel', 'contextmenu']) {
			this.overlay.addEventListener(type, e => e.stopPropagation());
		}

		document.body.appendChild(this.overlay);
		this.syncControls();
	}

	private row(label: string, control: HTMLElement): HTMLDivElement {
		const row = document.createElement('div');
		row.className = 'debayer-row';
		const l = document.createElement('div');
		l.className = 'debayer-label';
		l.textContent = label;
		row.appendChild(l);
		row.appendChild(control);
		return row;
	}

	private numberInput(name: string, value: number, onSet: (v: number) => void): HTMLLabelElement {
		const input = document.createElement('input');
		input.type = 'number';
		input.step = '1';
		input.className = 'debayer-number';
		input.value = String(value);
		input.onchange = () => {
			const v = parseFloat(input.value);
			if (Number.isFinite(v)) { onSet(v); }
		};
		const label = document.createElement('label');
		label.className = 'debayer-gain-label';
		label.appendChild(document.createTextNode(name));
		label.appendChild(input);
		return label;
	}

	/** Reflect current settings in the controls. */
	private syncControls(): void {
		if (!this.overlay) { return; }
		const info = getPatternInfo(this.settings.pattern);

		// Without this the checkbox never reflects state set from anywhere but a
		// click on the checkbox itself -- including the command that opens the
		// panel with the mode already on.
		if (this.enableCheckbox) { this.enableCheckbox.checked = this.settings.enabled; }

		for (const btn of this.viewButtons) {
			const view = btn.dataset.view as DebayerView;
			btn.classList.toggle('active', this.settings.view === view);
			// The fourth-channel button only means something for 4-channel patterns.
			if (view === 'i') {
				const available = info.channels === 4;
				btn.disabled = !available;
				btn.textContent = info.fourthLabel || 'IR';
				btn.style.opacity = available ? '1' : '0.4';
			}
		}

		const gains = [this.settings.gainR, this.settings.gainG, this.settings.gainB];
		this.gainInputs.forEach((input, i) => {
			if (document.activeElement !== input) { input.value = gains[i].toFixed(2); }
			// Under auto WB the boxes report what was estimated, not what to use.
			input.disabled = this.settings.autoWb;
		});

		const autoBtn = this.overlay.querySelector('.debayer-wb .debayer-button') as HTMLButtonElement | null;
		autoBtn?.classList.toggle('active', this.settings.autoWb);

		// Show the phase each button currently holds, and highlight it while it
		// is off zero -- otherwise a shifted phase is invisible state and the
		// buttons look like they did nothing.
		const period = info.period;
		for (const btn of this.offsetButtons) {
			const isX = btn.dataset.axis === 'X';
			const value = isX ? this.settings.offsetX : this.settings.offsetY;
			btn.textContent = `${btn.dataset.axis}: ${value}`;
			btn.classList.toggle('active', value !== 0);
			btn.disabled = period < 2;
		}
		if (this.offsetRow) {
			const offsetLabel = this.offsetRow.querySelector('.debayer-label');
			if (offsetLabel) {
				offsetLabel.textContent = `Phase (0-${period - 1})`;
			}
		}

		if (this.statusLine) {
			if (!this.settings.enabled) {
				this.statusLine.textContent = 'Off — showing the raw mosaic.';
			} else if (this.settings.view === 'mosaic') {
				this.statusLine.textContent = 'Showing the undemosaiced mosaic.';
			} else if (this.settings.view === 'rgb') {
				this.statusLine.textContent = `${info.label}, ${info.period}×${info.period} period.`;
			} else {
				this.statusLine.textContent = 'Single channel — Apply Colormap works on this view.';
			}
		}
	}

	/** Report the gains auto WB actually resolved to. */
	reportGains(gains: { r: number; g: number; b: number }): void {
		if (!this.settings.autoWb) { return; }
		this.settings.gainR = gains.r;
		this.settings.gainG = gains.g;
		this.settings.gainB = gains.b;
		this.syncControls();
	}

	private startDrag(e: MouseEvent): void {
		if (!this.overlay) { return; }
		const rect = this.overlay.getBoundingClientRect();
		this.isDragging = true;
		this.dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };

		const onMouseMove = (ev: MouseEvent) => {
			if (!this.isDragging || !this.overlay) { return; }
			const x = ev.clientX - this.dragOffset.x;
			const y = ev.clientY - this.dragOffset.y;
			const maxX = window.innerWidth - this.overlay.offsetWidth;
			const maxY = window.innerHeight - this.overlay.offsetHeight;
			this.overlay.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
			this.overlay.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
			this.overlay.style.right = 'auto';
			this.overlay.style.bottom = 'auto';
		};
		const onMouseUp = () => {
			this.isDragging = false;
			document.removeEventListener('mousemove', onMouseMove, true);
			document.removeEventListener('mouseup', onMouseUp, true);
			window.removeEventListener('blur', onMouseUp);
		};
		// Capture phase: these must fire even if something between the cursor and
		// the document stops propagation, or the panel stays stuck to the mouse.
		document.addEventListener('mousemove', onMouseMove, true);
		document.addEventListener('mouseup', onMouseUp, true);
		// Releasing outside the webview never delivers a mouseup; end the drag
		// rather than leaving it live until the next click.
		window.addEventListener('blur', onMouseUp);
	}

	show(): void {
		if (this.overlay) { this.overlay.style.display = 'flex'; }
	}

	hide(): void {
		if (this.overlay) { this.overlay.style.display = 'none'; }
	}

	isVisible(): boolean {
		return !!this.overlay && this.overlay.style.display !== 'none';
	}

	toggle(): void {
		if (this.isVisible()) { this.hide(); } else { this.show(); }
	}
}
