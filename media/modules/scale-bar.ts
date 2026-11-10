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
	/**
	 * Left edge and baseline, both in the range 0..1. Fractions of the viewport
	 * by default, or of the displayed image when `anchor` is `'image'`.
	 */
	x: number;
	y: number;
	/** Absent means viewport-relative, which is also how earlier versions saved it. */
	anchor?: 'image';
}

/** The displayed image in viewport pixels; it may extend past the viewport. */
export interface ScaleBarImageRect {
	left: number;
	top: number;
	width: number;
	height: number;
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
	/** Where the image is drawn. Only image-anchored placement uses it. */
	imageRect?: ScaleBarImageRect;
	/** Start at the bottom of the image, and keep a moved bar fixed to its place in the image. */
	anchorToImage?: boolean;
	viewportWidth: number;
	viewportHeight: number;
	/** Fixed chrome at the bottom of the viewport that the bar must stay above. */
	bottomInset: number;
}

const EDGE = 0;
export const SCALE_BAR_PAD_X = 6;
export const SCALE_BAR_PAD_TOP = 16;
export const SCALE_BAR_HEIGHT = 25;

/**
 * Gap between the image's lower-left corner and the bar's dark box, in screen
 * pixels. It shrinks with a small image so a zoomed-out bar keeps its place
 * relative to the corner instead of looking adrift on a thumbnail-sized image.
 */
export function imageCornerInset(rect: { width: number; height: number }): number {
	return 0;
}

/** Left end and baseline of the bar when it rests in the lower-left corner of the image, not held inside the viewport. */
export function imageRestingPoint(rect: ScaleBarImageRect, bottomClearance = 0): { x: number; y: number } {
	const inset = imageCornerInset(rect);
	return {
		x: rect.left + inset + SCALE_BAR_PAD_X,
		y: rect.top + rect.height - bottomClearance - inset - (SCALE_BAR_HEIGHT - SCALE_BAR_PAD_TOP),
	};
}

export function clampScaleBarPosition(position: ScaleBarPosition | null): ScaleBarPosition | null {
	return position && Number.isFinite(position.x) && Number.isFinite(position.y)
		? {
			x: Math.max(0, Math.min(1, position.x)),
			y: Math.max(0, Math.min(1, position.y)),
			...(position.anchor === 'image' ? { anchor: 'image' as const } : {}),
		}
		: null;
}

interface Frame {
	rect?: ScaleBarImageRect;
	viewportWidth: number;
	visibleBottom: number;
}

function usableRect(rect: ScaleBarImageRect | undefined): ScaleBarImageRect | undefined {
	return rect && rect.width > 0 && rect.height > 0 ? rect : undefined;
}

function toPixels(position: ScaleBarPosition, frame: Frame): { x: number; y: number } {
	return position.anchor === 'image' && frame.rect
		? { x: frame.rect.left + position.x * frame.rect.width, y: frame.rect.top + position.y * frame.rect.height }
		: { x: position.x * frame.viewportWidth, y: position.y * frame.visibleBottom };
}

function fromPixels(point: { x: number; y: number }, toImage: boolean, frame: Frame): ScaleBarPosition {
	const position = toImage && frame.rect
		? { x: (point.x - frame.rect.left) / frame.rect.width, y: (point.y - frame.rect.top) / frame.rect.height, anchor: 'image' as const }
		: { x: point.x / Math.max(1, frame.viewportWidth), y: point.y / Math.max(1, frame.visibleBottom) };
	return clampScaleBarPosition(position) ?? { x: 0, y: 0 };
}

/** Where the bar goes, or null when it would be too small, too large or uncalibrated. */
export function placeScaleBar(input: ScaleBarInput): ScaleBarPlacement | null {
	const bar = chooseScaleBarLength(input.visibleWidth, input.calibration);
	if (!bar) { return null; }
	const length = bar.lengthPixels * input.pixelScale;
	if (!(length > 20) || length > input.viewportWidth * 0.6) { return null; }

	const visibleBottom = input.viewportHeight - input.bottomInset;
	const rect = usableRect(input.imageRect);
	const anchored = input.anchorToImage && rect;
	// By default the bar sits in the viewer's lower-left corner and stays there
	// while the image is panned and zoomed; only its length and label change.
	// Anchored to the image, it starts at the image's lower-left corner instead,
	// held inside the viewer.
	const resting = anchored ? imageRestingPoint(rect, input.bottomClearance ?? 0) : null;
	const automaticX = resting ? resting.x + Math.max(0, -rect.left) : 16;
	const automaticY = resting ? Math.min(resting.y, visibleBottom - (input.bottomClearance ?? 0) - 16) : visibleBottom - (input.bottomClearance ?? 0) - 16;
	const frame: Frame = { rect, viewportWidth: input.viewportWidth, visibleBottom };
	const placed = input.position ? toPixels(input.position, frame) : null;
	const requestedX = placed ? placed.x : automaticX;
	const requestedY = placed ? placed.y : automaticY;
	// A bar pinned to a place in the image goes wherever that place goes, off
	// screen included. Every other placement stays inside the viewport.
	const pinned = Boolean(input.position?.anchor === 'image' && rect);
	return {
		x: pinned ? requestedX : Math.max(EDGE, Math.min(input.viewportWidth - length - EDGE, requestedX)),
		y: pinned ? requestedY : Math.max(20, Math.min(visibleBottom - EDGE, requestedY)),
		length,
		label: bar.label,
	};
}

/** How close, in screen pixels, a dragged bar must come to the image's lower-left corner to snap back into place. */
export const SCALE_BAR_SNAP_DISTANCE = 15;

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
	/** The image rectangle the bar is anchored to while it is anchored, as of the last draw. */
	private anchorRect: ScaleBarImageRect | undefined;
	/** Where an image-anchored bar rests by default, in viewport pixels, as of the last draw. */
	private restingPoint: { x: number; y: number } | undefined;

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
		const bottomInset = readBottomInset();
		const placement = placeScaleBar({
			...input, position: this.position,
			viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, bottomInset,
		});
		this.anchorRect = input.anchorToImage ? usableRect(input.imageRect) : undefined;
		this.restingPoint = this.anchorRect ? imageRestingPoint(this.anchorRect, input.bottomClearance ?? 0) : undefined;
		if (!placement) { return; }
		this.adoptFrame(placement, input.imageRect, window.innerWidth, window.innerHeight - bottomInset);
		paintScaleBar(ctx, placement);
		this.handle.style.left = `${placement.x - SCALE_BAR_PAD_X}px`;
		this.handle.style.top = `${placement.y - SCALE_BAR_PAD_TOP}px`;
		this.handle.style.width = `${placement.length + 2 * SCALE_BAR_PAD_X}px`;
		this.handle.style.height = `${SCALE_BAR_HEIGHT}px`;
		this.handle.style.display = 'block';
	}

	/**
	 * A bar saved in the other frame (the setting changed, or the file was
	 * saved under the other mode) is re-expressed in the current one where it
	 * is now, so changing the setting never makes it jump.
	 */
	private adoptFrame(placement: ScaleBarPlacement, imageRect: ScaleBarImageRect | undefined, viewportWidth: number, visibleBottom: number): void {
		const rect = usableRect(imageRect);
		if (!this.position || !rect) { return; }
		const wantImage = this.anchorRect !== undefined;
		if ((this.position.anchor === 'image') === wantImage) { return; }
		this.position = fromPixels(placement, wantImage, { rect, viewportWidth, visibleBottom });
		this.host.onChange();
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
		this.position = fromPixels({ x, y }, this.anchorRect !== undefined, { rect: this.anchorRect, viewportWidth: window.innerWidth, visibleBottom });
		this.host.onMove();
	};

	private endDrag = (): void => {
		if (!this.dragOffset) { return; }
		this.dragOffset = null;
		// Dropped back on the image's lower-left corner, the bar returns to its
		// automatic place, where it is kept on screen again.
		if (this.position && this.restingPoint && this.anchorRect) {
			const frame = { rect: this.anchorRect, viewportWidth: window.innerWidth, visibleBottom: 1 };
			const dropped = toPixels(this.position, frame);
			if (Math.hypot(dropped.x - this.restingPoint.x, dropped.y - this.restingPoint.y) <= SCALE_BAR_SNAP_DISTANCE) {
				this.position = null;
				this.host.onMove();
			}
		}
		this.host.onChange();
	};
}
