"use strict";

import { chooseScaleBarLength } from './measure/calibration.js';
import type { Calibration } from './measure/types.js';

/**
 * The scale bar of the single-image viewer and of the Xenium scene viewer.
 *
 * Each viewer owns its canvas and decides where the visible image is; this
 * module owns what is common: choosing a round length, placing the bar inside
 * the viewport, painting it, and the draggable handle that lets the user move
 * it. Placement is a pure function so it can be tested without a DOM.
 */

export interface ScaleBarPosition {
	/** Viewport-relative left edge and baseline, both in the range 0..1. */
	x: number;
	y: number;
}

export interface ScaleBarPlacement {
	/** Left end of the bar and its baseline, in viewport pixels. */
	x: number;
	y: number;
	/** Length of the bar on screen, in pixels. */
	length: number;
	label: string;
}

export interface ScaleBarInput {
	/** Image pixels visible across the viewport. */
	visibleWidth: number;
	/** Screen pixels per image pixel. */
	pixelScale: number;
	calibration: Calibration;
	/** Space the viewer keeps free along the bottom edge for its own readout. Default 0. */
	bottomClearance?: number;
	position: ScaleBarPosition | null;
	viewportWidth: number;
	viewportHeight: number;
	/** Fixed chrome at the bottom of the viewport that the bar must stay above. */
	bottomInset: number;
}

const EDGE = 8;
export const SCALE_BAR_PAD_X = 6;
export const SCALE_BAR_PAD_TOP = 16;
export const SCALE_BAR_HEIGHT = 30;

export function clampScaleBarPosition(position: ScaleBarPosition | null): ScaleBarPosition | null {
	return position && Number.isFinite(position.x) && Number.isFinite(position.y)
		? { x: Math.max(0, Math.min(1, position.x)), y: Math.max(0, Math.min(1, position.y)) }
		: null;
}

/** Where the bar goes, or null when it would be too small, too large or uncalibrated. */
export function placeScaleBar(input: ScaleBarInput): ScaleBarPlacement | null {
	const bar = chooseScaleBarLength(input.visibleWidth, input.calibration);
	if (!bar) { return null; }
	const length = bar.lengthPixels * input.pixelScale;
	if (!(length > 20) || length > input.viewportWidth * 0.6) { return null; }

	const visibleBottom = input.viewportHeight - input.bottomInset;
	// By default the bar sits in the viewer's lower-left corner and stays there
	// while the image is panned and zoomed; only its length and label change.
	const automaticX = 16;
	const automaticY = visibleBottom - (input.bottomClearance ?? 0) - 22;
	const requestedX = input.position ? input.position.x * input.viewportWidth : automaticX;
	const requestedY = input.position ? input.position.y * visibleBottom : automaticY;
	return {
		x: Math.max(EDGE, Math.min(input.viewportWidth - length - EDGE, requestedX)),
		y: Math.max(20, Math.min(visibleBottom - EDGE, requestedY)),
		length,
		label: bar.label,
	};
}

export function paintScaleBar(ctx: CanvasRenderingContext2D, placement: ScaleBarPlacement): void {
	const { x, y, length, label } = placement;
	ctx.save();
	ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
	ctx.fillRect(x - SCALE_BAR_PAD_X, y - SCALE_BAR_PAD_TOP, length + 2 * SCALE_BAR_PAD_X, SCALE_BAR_HEIGHT);
	ctx.strokeStyle = '#ffffff';
	ctx.fillStyle = '#ffffff';
	ctx.lineWidth = 3;
	ctx.beginPath();
	ctx.moveTo(x, y);
	ctx.lineTo(x + length, y);
	ctx.stroke();
	ctx.font = '11px var(--vscode-editor-font-family, monospace)';
	ctx.textAlign = 'center';
	ctx.fillText(label, x + length / 2, y - 5);
	ctx.restore();
}

/** The CSS variable a host sets to keep the bar above its own fixed chrome (the standalone site's status bar). */
function readBottomInset(): number {
	const configured = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--measure-scale-bar-bottom-inset'));
	return Number.isFinite(configured) ? Math.max(0, configured) : 0;
}

export interface ScaleBarHost {
	/** The bar was dragged: repaint. */
	onMove: () => void;
	/** A drag ended or the position was reset: persist it. */
	onChange: () => void;
}

/**
 * Position state and the invisible drag handle laid over the painted bar. The
 * viewer calls `draw` from its own render pass; the handle follows the bar.
 */
export class ScaleBarControl {
	private readonly handle: HTMLDivElement;
	private position: ScaleBarPosition | null = null;
	private dragOffset: { x: number; y: number } | null = null;

	constructor(private readonly host: ScaleBarHost, parent: HTMLElement = document.body) {
		this.handle = document.createElement('div');
		this.handle.className = 'measure-scale-bar-handle';
		this.handle.title = 'Drag to move the scale bar; double-click to restore automatic placement';
		parent.appendChild(this.handle);
		this.handle.addEventListener('mousedown', event => this.beginDrag(event));
		this.handle.addEventListener('dblclick', event => {
			event.preventDefault();
			event.stopPropagation();
			this.reset();
		});
		window.addEventListener('mousemove', this.moveDrag);
		window.addEventListener('mouseup', this.endDrag);
	}

	dispose(): void {
		window.removeEventListener('mousemove', this.moveDrag);
		window.removeEventListener('mouseup', this.endDrag);
		this.handle.remove();
	}

	getPosition(): ScaleBarPosition | null { return this.position ? { ...this.position } : null; }
	hasCustomPosition(): boolean { return this.position !== null; }

	setPosition(position: ScaleBarPosition | null): void {
		this.position = clampScaleBarPosition(position);
		this.host.onMove();
	}

	reset(): void {
		if (!this.position) { return; }
		this.position = null;
		this.host.onChange();
		this.host.onMove();
	}

	hideHandle(): void { this.handle.style.display = 'none'; }

	/** Paint the bar, if it fits, and move the handle onto it. */
	draw(ctx: CanvasRenderingContext2D, input: Omit<ScaleBarInput, 'position' | 'viewportWidth' | 'viewportHeight' | 'bottomInset'>): void {
		const placement = placeScaleBar({
			...input, position: this.position,
			viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, bottomInset: readBottomInset(),
		});
		if (!placement) { return; }
		paintScaleBar(ctx, placement);
		this.handle.style.left = `${placement.x - SCALE_BAR_PAD_X}px`;
		this.handle.style.top = `${placement.y - SCALE_BAR_PAD_TOP}px`;
		this.handle.style.width = `${placement.length + 2 * SCALE_BAR_PAD_X}px`;
		this.handle.style.height = `${SCALE_BAR_HEIGHT}px`;
		this.handle.style.display = 'block';
	}

	private beginDrag(event: MouseEvent): void {
		if (event.button !== 0) { return; }
		const bounds = this.handle.getBoundingClientRect();
		this.dragOffset = { x: event.clientX - (bounds.left + SCALE_BAR_PAD_X), y: event.clientY - (bounds.top + SCALE_BAR_PAD_TOP) };
		event.preventDefault();
		event.stopPropagation();
	}

	private moveDrag = (event: MouseEvent): void => {
		if (!this.dragOffset) { return; }
		const visibleBottom = Math.max(1, window.innerHeight - readBottomInset());
		const x = event.clientX - this.dragOffset.x;
		const y = event.clientY - this.dragOffset.y;
		this.position = {
			x: Math.max(0, Math.min(1, x / Math.max(1, window.innerWidth))),
			y: Math.max(0, Math.min(1, y / visibleBottom)),
		};
		this.host.onMove();
	};

	private endDrag = (): void => {
		if (!this.dragOffset) { return; }
		this.dragOffset = null;
		this.host.onChange();
	};
}
