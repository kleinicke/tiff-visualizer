"use strict";

import {
	distanceToPolyline,
	ellipsePoints,
	maskContour,
	rectCorners,
	roiContains,
	roiOutline,
	simplifyPolyline,
} from './geometry.js';
import type { RoiManager } from './roi-manager.js';
import { brushStroke, gradientMagnitude, growRegion, growRegionAuto, traceBoundary } from './segmentation.js';
import { chooseScaleBarLength, formatNumber } from './calibration.js';
import {
	isAreaKind,
	isLineKind,
	type Calibration,
	type MaskRoi,
	type MeasurementSource,
	type PointRoi,
	type PolygonRoi,
	type RectRoi,
	type Roi,
} from './types.js';

export type MeasureTool =
	| 'select'
	| 'rect'
	| 'ellipse'
	| 'polygon'
	| 'freehand'
	| 'line'
	| 'polyline'
	| 'point'
	| 'wand'
	| 'brush'
	| 'livewire'
	| 'calibrate';

export interface OverlayHost {
	/** The <canvas>/<img> currently showing the image, or null while loading. */
	getImageElement: () => HTMLElement | null;
	/** Raw image for wand/livewire; null when no measurable image is loaded. */
	getSource: () => MeasurementSource | null;
	/** Scalar view of the image, cached by the caller. */
	getScalarPlane: () => Float32Array | null;
	getCalibration: () => Calibration;
	/** Called when the calibrate tool finishes a line. */
	onCalibrationLine: (pixelDistance: number) => void;
	/** Called after any ROI edit that should refresh the results table. */
	onRoiEdited: (interactive: boolean) => void;
	/** Status text for the panel's hint line. */
	onHint: (text: string) => void;
}

/**
 * A binary segmentation result painted over the image.
 *
 * `mask` is everything the threshold selected; `accepted` is the subset that
 * survives the particle filters. Showing both, in two colours, is what makes a
 * threshold checkable: red-without-green is "selected but filtered out", which
 * is otherwise invisible and the usual reason an object count surprises people.
 */
export interface MaskPreview {
	width: number;
	height: number;
	mask: Uint8Array;
	accepted?: Uint8Array | null;
	opacity?: number;
}

interface DragState {
	tool: MeasureTool;
	startX: number;
	startY: number;
	currentX: number;
	currentY: number;
	roiId?: string;
	/** In-progress freehand/polyline point buffer, image coordinates. */
	points?: number[];
	/** Vertex index being dragged in select mode. */
	vertexIndex?: number;
	/** Whole-ROI move in select mode. */
	moving?: boolean;
	originalRoi?: Roi;
	erase?: boolean;
}

const HANDLE_RADIUS_SCREEN = 4.5;
const HIT_TOLERANCE_SCREEN = 6;

/**
 * The ROI overlay: drawing surface and pointer interaction.
 *
 * The overlay is a viewport-sized `position: fixed` canvas rather than an
 * element sized and positioned to match the image. That choice is deliberate:
 * the image element is laid out in normal document flow and scales through a
 * mix of CSS classes, explicit width/height, and page scrolling
 * (`zoom-controller.ts`), so anything that tried to mirror its geometry would
 * have to track all three. Mapping image coordinates to client coordinates
 * through `getBoundingClientRect()` at draw time is exact under every zoom, pan,
 * and scroll state, for the cost of one redraw per frame.
 *
 * Pointer handling is armed only while the panel is open and a tool other than
 * `select` is active, so a user who never opens the panel sees behaviour
 * identical to before.
 */
export class RoiOverlay {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D | null;
	private manager: RoiManager;
	private host: OverlayHost;

	private tool: MeasureTool = 'select';
	private active = false;
	private drag: DragState | null = null;
	/** Multi-click tools (polygon, polyline, livewire) accumulate here. */
	private pending: number[] = [];
	private pendingLivewirePath: number[] = [];
	private hoverImagePoint: { x: number; y: number } | null = null;
	private wandPreview: { x: number; y: number; width: number; height: number; mask: Uint8Array } | null = null;
	private wandPreviewKey = '';
	private gradientCache: { plane: Float32Array; gradient: Float32Array } | null = null;

	private brushRadius = 8;
	private wandTolerance: number | null = null;
	private showScaleBar = true;
	/**
	 * Keep the scale bar on screen while the measurement panel is closed.
	 *
	 * Standard practice in DICOM and microscopy viewers, and for good reason: a
	 * calibrated image read without any indication of scale is the case where a
	 * wrong size estimate is easiest to make and hardest to notice. It costs
	 * nothing when the file is uncalibrated, where nothing is drawn at all.
	 */
	private scaleBarWhenIdle = true;
	private showLabels = false;
	private redrawHandle = 0;
	/** ROI under the cursor in the results table or ROI list. */
	private hoveredRoiId: string | null = null;
	private showRois = true;
	private showMask = true;
	/** Held-key peek: everything measurement-related is hidden while true. */
	private peeking = false;
	/** Set when a select-mode press hit an ROI, so the click does not zoom. */
	private consumeNextClick = false;

	private maskPreview: MaskPreview | null = null;
	/** Rendered form of `maskPreview`, rebuilt only when the preview changes. */
	private maskPreviewCanvas: HTMLCanvasElement | null = null;
	private maskPreviewToken: object | null = null;

	private boundRedraw = () => this.scheduleRedraw();

	constructor(manager: RoiManager, host: OverlayHost) {
		this.manager = manager;
		this.host = host;

		this.canvas = document.createElement('canvas');
		this.canvas.className = 'measure-overlay';
		this.canvas.style.display = 'none';
		this.ctx = this.canvas.getContext('2d');
		document.body.appendChild(this.canvas);

		this.manager.onChange(event => {
			this.scheduleRedraw();
			this.host.onRoiEdited(event.interactive);
		});

		window.addEventListener('scroll', this.boundRedraw, true);
		window.addEventListener('resize', this.boundRedraw);
		this.canvas.addEventListener('mousedown', e => this.onMouseDown(e));
		this.canvas.addEventListener('mousemove', e => this.onMouseMove(e));
		this.canvas.addEventListener('mouseup', e => this.onMouseUp(e));
		this.canvas.addEventListener('mouseleave', () => this.onMouseLeave());
		// The container's click handler zooms the image. The overlay is a child of
		// that container, so without swallowing the click here every stroke drawn
		// with a tool would also zoom — most visibly when finishing a calibration
		// line, where the zoom then invalidates the distance just measured.
		this.canvas.addEventListener('click', e => {
			// Drawing tools always swallow the click. In select mode it depends on
			// whether the press landed on an ROI: picking one must not also zoom,
			// but a click on empty space still belongs to the image.
			if (this.tool !== 'select' || this.consumeNextClick) {
				e.preventDefault();
				e.stopPropagation();
			}
			this.consumeNextClick = false;
		});
		this.canvas.addEventListener('dblclick', e => this.onDoubleClick(e));
		this.canvas.addEventListener('contextmenu', e => this.onContextMenu(e));
		this.canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
	}

	dispose(): void {
		window.removeEventListener('scroll', this.boundRedraw, true);
		window.removeEventListener('resize', this.boundRedraw);
		this.canvas.remove();
	}

	// --- configuration ------------------------------------------------------

	setActive(active: boolean): void {
		this.active = active;
		// With `select` there is nothing to draw over the image, so let clicks
		// fall through to pan/zoom rather than swallowing them.
		this.updateVisibility();
		this.scheduleRedraw();
	}

	isActive(): boolean { return this.active; }

	setTool(tool: MeasureTool): void {
		this.cancelPending();
		this.tool = tool;
		this.updatePointerEvents();
		this.host.onHint(TOOL_HINTS[tool] || '');
		this.scheduleRedraw();
	}

	getTool(): MeasureTool { return this.tool; }

	setBrushRadius(radius: number): void {
		this.brushRadius = Math.max(1, radius);
		this.scheduleRedraw();
	}

	getBrushRadius(): number { return this.brushRadius; }

	setWandTolerance(tolerance: number | null): void {
		this.wandTolerance = tolerance;
		this.wandPreviewKey = '';
		this.scheduleRedraw();
	}

	getWandTolerance(): number | null { return this.wandTolerance; }

	setShowScaleBar(show: boolean): void {
		this.showScaleBar = show;
		this.updateVisibility();
		this.scheduleRedraw();
	}

	getShowScaleBar(): boolean { return this.showScaleBar; }

	/** Toggle the idle (panel-closed) scale bar; returns the new state. */
	toggleScaleBar(): boolean {
		this.showScaleBar = !this.showScaleBar;
		this.updateVisibility();
		this.scheduleRedraw();
		return this.showScaleBar;
	}

	setShowLabels(show: boolean): void { this.showLabels = show; this.scheduleRedraw(); }

	setShowRois(show: boolean): void { this.showRois = show; this.scheduleRedraw(); }
	getShowRois(): boolean { return this.showRois; }
	setShowMask(show: boolean): void { this.showMask = show; this.scheduleRedraw(); }
	getShowMask(): boolean { return this.showMask; }

	/**
	 * Momentarily hide everything the subsystem draws.
	 *
	 * Bound to holding a key, because comparing an overlay against the image
	 * underneath is a glance, not a setting: reaching for a checkbox in another
	 * tab to look and then reaching back is enough friction that people stop
	 * checking their own segmentation.
	 */
	setPeeking(peeking: boolean): void {
		if (this.peeking === peeking) { return; }
		this.peeking = peeking;
		this.scheduleRedraw();
	}

	isPeeking(): boolean { return this.peeking; }

	/** Highlight an ROI without selecting it, for table/list hover. */
	setHoveredRoi(id: string | null): void {
		if (this.hoveredRoiId === id) { return; }
		this.hoveredRoiId = id;
		this.scheduleRedraw();
	}

	/** Drop caches that depend on the image content. */
	invalidateImage(): void {
		this.gradientCache = null;
		this.wandPreview = null;
		this.wandPreviewKey = '';
		this.setMaskPreview(null);
		this.scheduleRedraw();
	}

	/**
	 * Show (or clear) a segmentation preview painted over the image.
	 *
	 * The mask is rasterised once into an offscreen canvas at image resolution
	 * and then blitted with the same rect mapping the ROIs use, so it stays
	 * pixel-aligned under any zoom or pan and costs one `drawImage` per frame
	 * rather than a per-pixel loop.
	 */
	setMaskPreview(preview: MaskPreview | null): void {
		this.maskPreview = preview;
		this.maskPreviewCanvas = null;
		this.maskPreviewToken = null;
		this.scheduleRedraw();
	}

	hasMaskPreview(): boolean { return this.maskPreview !== null; }

	private ensureMaskPreviewCanvas(): HTMLCanvasElement | null {
		const preview = this.maskPreview;
		if (!preview || preview.width <= 0 || preview.height <= 0) { return null; }
		if (this.maskPreviewCanvas && this.maskPreviewToken === preview) { return this.maskPreviewCanvas; }

		const canvas = document.createElement('canvas');
		canvas.width = preview.width;
		canvas.height = preview.height;
		const ctx = canvas.getContext('2d');
		if (!ctx) { return null; }

		const image = ctx.createImageData(preview.width, preview.height);
		const pixels = image.data;
		const alpha = Math.round(255 * (preview.opacity ?? 0.45));
		const accepted = preview.accepted;
		for (let i = 0; i < preview.mask.length; i++) {
			if (!preview.mask[i]) { continue; }
			const offset = i * 4;
			if (accepted && accepted[i]) {
				// Green: this pixel belongs to an object that will be kept.
				pixels[offset] = 40;
				pixels[offset + 1] = 220;
				pixels[offset + 2] = 120;
			} else {
				// Red: thresholded, but filtered out (or not analysed yet).
				pixels[offset] = 255;
				pixels[offset + 1] = 60;
				pixels[offset + 2] = 60;
			}
			pixels[offset + 3] = alpha;
		}
		ctx.putImageData(image, 0, 0);

		this.maskPreviewCanvas = canvas;
		this.maskPreviewToken = preview;
		return canvas;
	}

	private updatePointerEvents(): void {
		// In select mode the overlay still needs clicks (to pick an ROI), but
		// only where an ROI actually is; that is handled by forwarding misses
		// back to the image, below.
		this.canvas.style.pointerEvents = this.active ? 'auto' : 'none';
	}

	/**
	 * Whether the canvas is shown purely to carry the scale bar, with the
	 * measurement panel closed. Nothing else is drawn in that state and the
	 * canvas never takes pointer events, so pan and zoom are untouched.
	 */
	private isIdleScaleBarVisible(): boolean {
		return !this.active
			&& this.showScaleBar
			&& this.scaleBarWhenIdle
			&& this.host.getCalibration().origin !== 'none';
	}

	private updateVisibility(): void {
		this.canvas.style.display = (this.active || this.isIdleScaleBarVisible()) ? 'block' : 'none';
		this.updatePointerEvents();
	}

	// --- coordinate mapping -------------------------------------------------

	private imageRect(): DOMRect | null {
		const element = this.host.getImageElement();
		if (!element) { return null; }
		const rect = element.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) { return null; }
		return rect;
	}

	private naturalSize(): { width: number; height: number } | null {
		const element = this.host.getImageElement() as (HTMLElement & { naturalWidth?: number; width?: number }) | null;
		if (!element) { return null; }
		const width = element.naturalWidth || element.width || 0;
		const height = (element as unknown as { naturalHeight?: number; height?: number }).naturalHeight
			|| (element as unknown as { height?: number }).height || 0;
		if (!width || !height) { return null; }
		return { width, height };
	}

	/** Client point → image pixel coordinates (may be fractional). */
	private toImage(clientX: number, clientY: number): { x: number; y: number } | null {
		const rect = this.imageRect();
		const natural = this.naturalSize();
		if (!rect || !natural) { return null; }
		return {
			x: ((clientX - rect.left) / rect.width) * natural.width,
			y: ((clientY - rect.top) / rect.height) * natural.height,
		};
	}

	/** Image pixel coordinates → client point. */
	private toClient(x: number, y: number): { x: number; y: number } | null {
		const rect = this.imageRect();
		const natural = this.naturalSize();
		if (!rect || !natural) { return null; }
		return {
			x: rect.left + (x / natural.width) * rect.width,
			y: rect.top + (y / natural.height) * rect.height,
		};
	}

	/** Current on-screen size of one image pixel. */
	private pixelScale(): number {
		const rect = this.imageRect();
		const natural = this.naturalSize();
		if (!rect || !natural) { return 1; }
		return rect.width / natural.width;
	}

	// --- drawing ------------------------------------------------------------

	scheduleRedraw(): void {
		if (this.redrawHandle) { return; }
		this.redrawHandle = requestAnimationFrame(() => {
			this.redrawHandle = 0;
			this.redraw();
		});
	}

	redraw(): void {
		if (!this.ctx) { return; }
		// The calibration can change under us (a new image, a manual edit), so
		// visibility is settled here rather than only at the call sites that
		// change it.
		this.updateVisibility();
		const idleScaleBarOnly = !this.active;
		if (idleScaleBarOnly && !this.isIdleScaleBarVisible()) { return; }

		// The image load path clears the container of every img/canvas to put a
		// new image on a clean background, and this overlay is a canvas on that
		// same container. `isOverlayChrome` in imagePreview.ts exempts it, but a
		// detached canvas fails silently — it keeps accepting draw calls and
		// simply never appears — so re-attaching here turns any future sweep
		// into a hiccup instead of an invisible feature.
		if (!this.canvas.isConnected) {
			document.body.appendChild(this.canvas);
		}

		const dpr = window.devicePixelRatio || 1;
		const width = window.innerWidth;
		const height = window.innerHeight;
		if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
			this.canvas.width = Math.round(width * dpr);
			this.canvas.height = Math.round(height * dpr);
			this.canvas.style.width = `${width}px`;
			this.canvas.style.height = `${height}px`;
		}

		const ctx = this.ctx;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);

		const rect = this.imageRect();
		if (!rect) { return; }

		if (idleScaleBarOnly) {
			this.drawScaleBar(ctx, rect);
			return;
		}

		// Clip to the image so ROIs never paint over the surrounding chrome.
		ctx.save();
		ctx.beginPath();
		ctx.rect(rect.left, rect.top, rect.width, rect.height);
		ctx.clip();

		if (this.peeking) { ctx.restore(); return; }

		// Segmentation preview first, so ROI outlines stay legible on top of it.
		const previewCanvas = this.showMask ? this.ensureMaskPreviewCanvas() : null;
		if (previewCanvas) {
			// Nearest-neighbour: a smoothed mask edge would suggest a precision
			// the segmentation does not have, and at high zoom it would no longer
			// line up with the pixels the user is inspecting.
			ctx.imageSmoothingEnabled = false;
			ctx.drawImage(previewCanvas, rect.left, rect.top, rect.width, rect.height);
			ctx.imageSmoothingEnabled = true;
		}

		if (this.showRois) {
			for (const roi of this.manager.list()) {
				this.drawRoi(ctx, roi, this.manager.isSelected(roi.id));
			}
		}

		this.drawPending(ctx);
		this.drawWandPreview(ctx);
		this.drawBrushCursor(ctx);

		ctx.restore();

		if (this.showScaleBar) { this.drawScaleBar(ctx, rect); }
	}

	private drawRoi(ctx: CanvasRenderingContext2D, roi: Roi, selected: boolean): void {
		const hovered = this.hoveredRoiId === roi.id;
		// The ROI keeps its own colour in every state. Colour identifies the
		// object — replacing it on hover throws that away exactly when the user
		// is trying to match a table row to a shape. Emphasis comes from a white
		// halo drawn underneath and from line weight instead.
		const color = roi.color || '#ffd400';
		ctx.lineWidth = selected ? 2 : (hovered ? 1.75 : 1.25);
		ctx.strokeStyle = color;
		ctx.setLineDash([]);

		if (roi.kind === 'point') {
			const points = (roi as PointRoi).points || [];
			ctx.fillStyle = color;
			for (let i = 0; i + 1 < points.length; i += 2) {
				const client = this.toClient(points[i] + 0.5, points[i + 1] + 0.5);
				if (!client) { continue; }
				ctx.beginPath();
				ctx.arc(client.x, client.y, selected ? 5 : 4, 0, Math.PI * 2);
				ctx.fill();
				// A crosshair keeps the marker locatable against a bright object,
				// where a filled dot alone disappears.
				ctx.beginPath();
				ctx.moveTo(client.x - 8, client.y);
				ctx.lineTo(client.x + 8, client.y);
				ctx.moveTo(client.x, client.y - 8);
				ctx.lineTo(client.x, client.y + 8);
				ctx.stroke();
				if (this.showLabels) {
					this.drawLabel(ctx, String(i / 2 + 1), client.x + 7, client.y - 7, color);
				}
			}
			return;
		}

		const outline = roi.kind === 'mask'
			? maskContour(roi as MaskRoi)
			: roiOutline(roi);
		if (outline.length < 4) { return; }

		ctx.beginPath();
		let started = false;
		for (let i = 0; i + 1 < outline.length; i += 2) {
			// +0.5 puts the path on the pixel centre, matching the coordinate
			// convention used everywhere else in the subsystem.
			const client = this.toClient(outline[i] + 0.5, outline[i + 1] + 0.5);
			if (!client) { continue; }
			if (!started) { ctx.moveTo(client.x, client.y); started = true; }
			else { ctx.lineTo(client.x, client.y); }
		}
		if (isAreaKind(roi.kind)) { ctx.closePath(); }

		// Halo first, so the outline sits on top of it and stays its own colour.
		if (hovered || selected) {
			ctx.save();
			ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
			ctx.lineWidth = (selected ? 2 : 1.75) + 2.5;
			ctx.stroke();
			ctx.restore();
		}
		ctx.stroke();

		if ((selected || hovered) && isAreaKind(roi.kind)) {
			ctx.save();
			// Kept light: the fill is a hint, and a heavy one hides the pixels the
			// measurement is actually made from.
			ctx.globalAlpha = selected ? 0.18 : 0.10;
			ctx.fillStyle = color;
			ctx.fill();
			ctx.restore();
		}

		if (selected) { this.drawHandles(ctx, roi); }
		if (selected || hovered) { this.drawSelectionMarker(ctx, outline); }

		// Only the object being pointed at or worked on is named. Labelling every
		// ROI turns a segmented field into unreadable text, and the number of an
		// object nobody asked about is noise. "Show all ROI names" opts back in,
		// and even then a label is skipped when the object is too small on screen
		// to carry one legibly.
		const labelAll = this.showLabels && this.roiScreenExtent(outline) >= 26;
		if ((labelAll || selected || hovered) && roi.name) {
			const anchor = this.toClient(outline[0] + 0.5, outline[1] + 0.5);
			if (anchor) { this.drawLabel(ctx, roi.name, anchor.x + 6, anchor.y - 6, color); }
		}
	}

	/**
	 * A dashed box around the selected ROI.
	 *
	 * Selecting a results row highlights its ROI, but a single-pixel outline
	 * around a ten-pixel object at fit-to-window zoom is invisible. The box is
	 * drawn with a minimum on-screen size so the answer to "which object is this
	 * row?" is always findable.
	 */
	private drawSelectionMarker(ctx: CanvasRenderingContext2D, outline: number[]): void {
		if (outline.length < 4) { return; }
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (let i = 0; i + 1 < outline.length; i += 2) {
			const client = this.toClient(outline[i] + 0.5, outline[i + 1] + 0.5);
			if (!client) { continue; }
			minX = Math.min(minX, client.x); maxX = Math.max(maxX, client.x);
			minY = Math.min(minY, client.y); maxY = Math.max(maxY, client.y);
		}
		if (!Number.isFinite(minX)) { return; }

		const padding = 6;
		const centreX = (minX + maxX) / 2;
		const centreY = (minY + maxY) / 2;
		const halfWidth = Math.max((maxX - minX) / 2 + padding, 9);
		const halfHeight = Math.max((maxY - minY) / 2 + padding, 9);

		ctx.save();
		ctx.setLineDash([4, 3]);
		ctx.strokeStyle = '#ffffff';
		ctx.lineWidth = 1;
		ctx.strokeRect(centreX - halfWidth, centreY - halfHeight, halfWidth * 2, halfHeight * 2);
		ctx.restore();
	}

	/**
	 * Scroll an ROI into view if it is off-screen.
	 *
	 * Called only when the selection came from the results table or the ROI
	 * list — selecting by clicking the image must never move the image under the
	 * cursor.
	 */
	revealRoi(id: string): void {
		const roi = this.manager.get(id);
		if (!roi) { return; }
		const outline = roi.kind === 'mask' ? maskContour(roi as MaskRoi) : roiOutline(roi);
		if (outline.length < 2) { return; }

		let sumX = 0, sumY = 0, n = 0;
		for (let i = 0; i + 1 < outline.length; i += 2) { sumX += outline[i]; sumY += outline[i + 1]; n++; }
		const client = this.toClient(sumX / n, sumY / n);
		if (!client) { return; }

		const margin = 80;
		const offScreen = client.x < margin || client.y < margin
			|| client.x > window.innerWidth - margin || client.y > window.innerHeight - margin;
		if (!offScreen) { return; }
		window.scrollBy({
			left: client.x - window.innerWidth / 2,
			top: client.y - window.innerHeight / 2,
			behavior: 'smooth',
		});
	}

	/** Larger on-screen dimension of an outline, in CSS pixels. */
	private roiScreenExtent(outline: number[]): number {
		if (outline.length < 4) { return 0; }
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (let i = 0; i + 1 < outline.length; i += 2) {
			if (outline[i] < minX) { minX = outline[i]; }
			if (outline[i] > maxX) { maxX = outline[i]; }
			if (outline[i + 1] < minY) { minY = outline[i + 1]; }
			if (outline[i + 1] > maxY) { maxY = outline[i + 1]; }
		}
		const scale = this.pixelScale();
		return Math.max(maxX - minX, maxY - minY) * scale;
	}

	private drawHandles(ctx: CanvasRenderingContext2D, roi: Roi): void {
		const handles = this.handlePositions(roi);
		const rotatable = roi.kind === 'rect' || roi.kind === 'ellipse';
		ctx.fillStyle = '#ffffff';
		ctx.strokeStyle = roi.color || '#ffd400';
		ctx.lineWidth = 1.5;
		for (let i = 0; i < handles.length; i++) {
			const client = this.toClient(handles[i].x + 0.5, handles[i].y + 0.5);
			if (!client) { continue; }
			const isRotationGrip = rotatable && i === 4;
			ctx.beginPath();
			if (isRotationGrip) {
				// Round, and tethered to the shape, so it reads as "turn me"
				// rather than as a fifth corner.
				ctx.arc(client.x, client.y, HANDLE_RADIUS_SCREEN, 0, Math.PI * 2);
			} else {
				ctx.rect(
					client.x - HANDLE_RADIUS_SCREEN, client.y - HANDLE_RADIUS_SCREEN,
					HANDLE_RADIUS_SCREEN * 2, HANDLE_RADIUS_SCREEN * 2,
				);
			}
			ctx.fill();
			ctx.stroke();
		}
	}

	/**
	 * Editable handles for an ROI.
	 *
	 * Rectangles and ellipses expose their four bounding-box corners; polygons
	 * and lines expose every vertex. Mask ROIs expose none — dragging a vertex
	 * of a traced boundary would have to re-rasterise on every mouse move, and
	 * the brush is the right tool for editing them.
	 */
	private handlePositions(roi: Roi): { x: number; y: number }[] {
		switch (roi.kind) {
			case 'rect':
			case 'ellipse': {
				const r = roi as RectRoi;
				const angle = r.angle || 0;
				const cx = r.x + r.width / 2;
				const cy = r.y + r.height / 2;
				const spin = (px: number, py: number) => {
					if (!angle) { return { x: px, y: py }; }
					const cos = Math.cos(angle);
					const sin = Math.sin(angle);
					const dx = px - cx;
					const dy = py - cy;
					return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
				};
				// Four corners, then a rotation grip standing off the top edge.
				// Corners follow the rotation so they stay on the shape, and the
				// grip is offset in the rotated frame so it always leads the
				// shape rather than drifting across it.
				const standoff = Math.max(12, r.height * 0.25);
				return [
					spin(r.x, r.y),
					spin(r.x + r.width, r.y),
					spin(r.x + r.width, r.y + r.height),
					spin(r.x, r.y + r.height),
					spin(cx, r.y - standoff),
				];
			}
			case 'polygon':
			case 'freehand':
			case 'line':
			case 'polyline':
			case 'point': {
				const points = (roi as PolygonRoi).points || [];
				const handles: { x: number; y: number }[] = [];
				// A dense freehand trace would produce hundreds of handles; show
				// them only when the vertex count is small enough to be usable.
				const stride = points.length / 2 > 64 ? Math.ceil(points.length / 2 / 64) : 1;
				for (let i = 0; i + 1 < points.length; i += 2 * stride) {
					handles.push({ x: points[i], y: points[i + 1] });
				}
				return handles;
			}
			default:
				return [];
		}
	}

	private drawPending(ctx: CanvasRenderingContext2D): void {
		const drag = this.drag;

		if (drag && (drag.tool === 'rect' || drag.tool === 'ellipse')) {
			const preview = this.dragRectRoi(drag);
			if (preview) {
				ctx.save();
				ctx.setLineDash([4, 3]);
				ctx.strokeStyle = '#ffffff';
				ctx.lineWidth = 1.25;
				const outline = drag.tool === 'rect'
					? rectCorners(preview as RectRoi)
					: ellipsePoints(preview as never);
				this.strokePath(ctx, outline, true);
				ctx.restore();
			}
		}

		if (drag && drag.tool === 'freehand' && drag.points) {
			ctx.save();
			ctx.strokeStyle = '#ffffff';
			ctx.lineWidth = 1.5;
			this.strokePath(ctx, drag.points, false);
			ctx.restore();
		}

		if (drag && (drag.tool === 'line' || drag.tool === 'calibrate')) {
			ctx.save();
			ctx.setLineDash([4, 3]);
			ctx.strokeStyle = drag.tool === 'calibrate' ? '#4cd4a0' : '#ffffff';
			ctx.lineWidth = 1.5;
			this.strokePath(ctx, [drag.startX, drag.startY, drag.currentX, drag.currentY], false);
			ctx.restore();
			if (drag.tool === 'calibrate') {
				const distance = Math.hypot(drag.currentX - drag.startX, drag.currentY - drag.startY);
				const mid = this.toClient((drag.startX + drag.currentX) / 2, (drag.startY + drag.currentY) / 2);
				if (mid) { this.drawLabel(ctx, `${distance.toFixed(1)} px`, mid.x + 8, mid.y - 8, '#4cd4a0'); }
			}
		}

		if (this.pending.length >= 2) {
			const path = this.pendingLivewirePath.length >= 4 ? this.pendingLivewirePath : this.pending;
			const preview = path.slice();
			if (this.hoverImagePoint) {
				preview.push(this.hoverImagePoint.x, this.hoverImagePoint.y);
			}
			ctx.save();
			ctx.setLineDash([5, 3]);
			ctx.strokeStyle = '#ffffff';
			ctx.lineWidth = 1.5;
			this.strokePath(ctx, preview, false);
			ctx.restore();

			// Committed vertices get a marker so it is obvious what a click did.
			ctx.fillStyle = '#ffffff';
			for (let i = 0; i + 1 < this.pending.length; i += 2) {
				const client = this.toClient(this.pending[i], this.pending[i + 1]);
				if (!client) { continue; }
				ctx.beginPath();
				ctx.arc(client.x, client.y, 3, 0, Math.PI * 2);
				ctx.fill();
			}
		}
	}

	/**
	 * Ghost of the ROI a wand click would produce.
	 *
	 * This is the change that removes the click-undo-retry loop: the result is
	 * visible before committing to it, so tolerance can be tuned by looking
	 * rather than by trial.
	 */
	private drawWandPreview(ctx: CanvasRenderingContext2D): void {
		if (this.tool !== 'wand' || !this.wandPreview) { return; }
		const contour = maskContour(this.wandPreview);
		if (contour.length < 4) { return; }
		ctx.save();
		ctx.setLineDash([3, 2]);
		ctx.strokeStyle = '#00d4ff';
		ctx.lineWidth = 1.5;
		this.strokePath(ctx, contour, true);
		ctx.globalAlpha = 0.15;
		ctx.fillStyle = '#00d4ff';
		ctx.fill();
		ctx.restore();
	}

	private drawBrushCursor(ctx: CanvasRenderingContext2D): void {
		if (this.tool !== 'brush' || !this.hoverImagePoint) { return; }
		const client = this.toClient(this.hoverImagePoint.x, this.hoverImagePoint.y);
		if (!client) { return; }
		ctx.save();
		ctx.strokeStyle = '#ffffff';
		ctx.lineWidth = 1;
		ctx.setLineDash([2, 2]);
		ctx.beginPath();
		ctx.arc(client.x, client.y, this.brushRadius * this.pixelScale(), 0, Math.PI * 2);
		ctx.stroke();
		ctx.restore();
	}

	private drawScaleBar(ctx: CanvasRenderingContext2D, rect: DOMRect): void {
		const calibration = this.host.getCalibration();
		const natural = this.naturalSize();
		if (!natural) { return; }
		const visibleWidth = Math.min(rect.width, window.innerWidth) / this.pixelScale();
		const bar = chooseScaleBarLength(visibleWidth, calibration);
		if (!bar) { return; }

		const lengthOnScreen = bar.lengthPixels * this.pixelScale();
		if (!(lengthOnScreen > 20) || lengthOnScreen > window.innerWidth * 0.6) { return; }

		const x = Math.max(rect.left, 0) + 16;
		// Browser hosts can reserve fixed chrome at the bottom of the viewport.
		// The VS Code webview leaves this variable unset, so its placement stays
		// unchanged, while the standalone site keeps the bar above its status bar.
		const configuredInset = Number.parseFloat(getComputedStyle(document.documentElement)
			.getPropertyValue('--measure-scale-bar-bottom-inset'));
		const bottomInset = Number.isFinite(configuredInset) ? Math.max(0, configuredInset) : 0;
		const visibleBottom = window.innerHeight - bottomInset;
		const y = Math.min(rect.bottom, visibleBottom) - 22;

		ctx.save();
		ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
		ctx.fillRect(x - 6, y - 16, lengthOnScreen + 12, 30);
		ctx.strokeStyle = '#ffffff';
		ctx.fillStyle = '#ffffff';
		ctx.lineWidth = 3;
		ctx.beginPath();
		ctx.moveTo(x, y);
		ctx.lineTo(x + lengthOnScreen, y);
		ctx.stroke();
		ctx.font = '11px var(--vscode-editor-font-family, monospace)';
		ctx.textAlign = 'center';
		ctx.fillText(bar.label, x + lengthOnScreen / 2, y - 5);
		ctx.restore();
	}

	private strokePath(ctx: CanvasRenderingContext2D, points: number[], close: boolean): void {
		ctx.beginPath();
		let started = false;
		for (let i = 0; i + 1 < points.length; i += 2) {
			const client = this.toClient(points[i] + 0.5, points[i + 1] + 0.5);
			if (!client) { continue; }
			if (!started) { ctx.moveTo(client.x, client.y); started = true; }
			else { ctx.lineTo(client.x, client.y); }
		}
		if (close) { ctx.closePath(); }
		ctx.stroke();
	}

	private drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
		ctx.save();
		ctx.font = '11px var(--vscode-font-family, sans-serif)';
		const metrics = ctx.measureText(text);
		ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
		ctx.fillRect(x - 2, y - 11, metrics.width + 4, 14);
		ctx.fillStyle = color;
		ctx.fillText(text, x, y);
		ctx.restore();
	}

	// --- interaction --------------------------------------------------------

	private onMouseDown(event: MouseEvent): void {
		if (!this.active || event.button !== 0) { return; }
		const point = this.toImage(event.clientX, event.clientY);
		if (!point) { return; }

		if (this.tool === 'select') {
			this.beginSelectDrag(event, point);
			return;
		}

		event.preventDefault();
		event.stopPropagation();

		switch (this.tool) {
			case 'rect':
			case 'ellipse':
			case 'line':
			case 'calibrate':
				this.drag = { tool: this.tool, startX: point.x, startY: point.y, currentX: point.x, currentY: point.y };
				break;

			case 'freehand':
				this.drag = {
					tool: 'freehand',
					startX: point.x, startY: point.y,
					currentX: point.x, currentY: point.y,
					points: [point.x, point.y],
				};
				break;

			case 'polygon':
			case 'polyline':
				this.pending.push(point.x, point.y);
				this.host.onHint('Click to add points. Double-click or press Enter to finish, Escape to cancel.');
				break;

			case 'livewire':
				this.addLivewirePoint(point);
				break;

			case 'point':
				this.addCounterPoint(point, event.altKey);
				break;

			case 'wand':
				this.commitWand(point, event.shiftKey);
				break;

			case 'brush':
				this.beginBrush(point, event.altKey || event.shiftKey);
				break;
		}

		this.scheduleRedraw();
	}

	private onMouseMove(event: MouseEvent): void {
		if (!this.active) { return; }
		const point = this.toImage(event.clientX, event.clientY);
		this.hoverImagePoint = point;
		if (!point) { return; }

		if (this.drag) {
			this.drag.currentX = point.x;
			this.drag.currentY = point.y;

			if (this.drag.tool === 'freehand' && this.drag.points) {
				const points = this.drag.points;
				const lastX = points[points.length - 2];
				const lastY = points[points.length - 1];
				// One point per mouse event is far denser than needed; sampling at
				// roughly one image pixel keeps the stored polygon sane.
				if (Math.hypot(point.x - lastX, point.y - lastY) >= 1) {
					points.push(point.x, point.y);
				}
			} else if (this.drag.tool === 'brush') {
				this.applyBrush(point, this.drag.erase === true);
			} else if (this.drag.tool === 'select') {
				this.updateSelectDrag(point);
			}

			this.scheduleRedraw();
			return;
		}

		// In select mode the image itself behaves like the results table: whatever
		// is under the cursor lights up, so an object can be identified without
		// clicking it and without going to the list.
		if (this.tool === 'select') {
			const hit = this.hitTest(point, HIT_TOLERANCE_SCREEN / this.pixelScale());
			this.setHoveredRoi(hit ? hit.id : null);
		}

		if (this.tool === 'wand') { this.updateWandPreview(point); }
		if (this.tool === 'livewire' && this.pending.length >= 2) { this.updateLivewirePreview(point); }
		if (this.tool === 'brush' || this.pending.length >= 2) { this.scheduleRedraw(); }
	}

	private onMouseUp(event: MouseEvent): void {
		if (!this.active || !this.drag) { return; }
		const drag = this.drag;
		this.drag = null;

		const point = this.toImage(event.clientX, event.clientY) || { x: drag.currentX, y: drag.currentY };
		drag.currentX = point.x;
		drag.currentY = point.y;

		switch (drag.tool) {
			case 'rect':
			case 'ellipse': {
				const preview = this.dragRectRoi(drag);
				// A click without a drag is an accidental zero-area ROI, not an
				// intent to create one.
				if (preview && preview.width >= 1 && preview.height >= 1) {
					this.manager.add({
						...preview,
						id: this.manager.nextId(),
						name: this.manager.nextName(drag.tool),
						source: 'manual',
					} as Roi);
				}
				break;
			}

			case 'line': {
				const length = Math.hypot(drag.currentX - drag.startX, drag.currentY - drag.startY);
				if (length >= 1) {
					this.manager.add({
						id: this.manager.nextId(),
						name: this.manager.nextName('line'),
						kind: 'line',
						source: 'manual',
						points: [drag.startX, drag.startY, drag.currentX, drag.currentY],
						lineWidth: 1,
					});
				}
				break;
			}

			case 'calibrate': {
				const distance = Math.hypot(drag.currentX - drag.startX, drag.currentY - drag.startY);
				if (distance >= 1) { this.host.onCalibrationLine(distance); }
				break;
			}

			case 'freehand': {
				const points = simplifyPolyline(drag.points || [], 0.75);
				if (points.length >= 6) {
					this.manager.add({
						id: this.manager.nextId(),
						name: this.manager.nextName('freehand'),
						kind: 'freehand',
						source: 'manual',
						points,
					});
				}
				break;
			}

			case 'brush':
				// The stroke was applied live; committing here just closes the
				// interactive window so the next stroke is a separate undo step.
				this.host.onRoiEdited(false);
				break;

			case 'select':
				this.host.onRoiEdited(false);
				break;
		}

		this.scheduleRedraw();
	}

	private onMouseLeave(): void {
		this.hoverImagePoint = null;
		this.wandPreview = null;
		this.scheduleRedraw();
	}

	private onDoubleClick(event: MouseEvent): void {
		if (!this.active) { return; }
		if (this.pending.length >= 4) {
			event.preventDefault();
			event.stopPropagation();
			this.commitPending();
		}
	}

	private onContextMenu(event: MouseEvent): void {
		// A right-click while a multi-click shape is open means "finish it";
		// anywhere else the normal image context menu should still appear.
		if (this.active && this.pending.length >= 4) {
			event.preventDefault();
			event.stopPropagation();
			this.commitPending();
		}
	}

	private onWheel(event: WheelEvent): void {
		if (!this.active) { return; }
		// Scrolling adjusts the active tool's size/tolerance so it can be tuned
		// without leaving the image; everything else keeps zooming.
		if (this.tool === 'brush') {
			event.preventDefault();
			event.stopPropagation();
			this.setBrushRadius(this.brushRadius * (event.deltaY > 0 ? 0.85 : 1.18));
			this.host.onHint(`Brush radius ${this.brushRadius.toFixed(1)} px`);
			return;
		}
		if (this.tool === 'wand' && this.wandPreview) {
			event.preventDefault();
			event.stopPropagation();
			const current = this.wandTolerance ?? this.lastWandTolerance;
			const next = Math.max(1e-9, current * (event.deltaY > 0 ? 0.8 : 1.25));
			this.setWandTolerance(next);
			this.host.onHint(`Wand tolerance ${formatNumber(next)}`);
			if (this.hoverImagePoint) { this.updateWandPreview(this.hoverImagePoint); }
		}
	}

	/** Escape/Enter/Delete handling, called from the panel's key listener. */
	handleKey(event: KeyboardEvent): boolean {
		if (!this.active) { return false; }
		if (event.key === 'Escape') {
			if (this.pending.length > 0 || this.drag) { this.cancelPending(); return true; }
			if (this.tool !== 'select') { this.setTool('select'); return true; }
			return false;
		}
		if (event.key === 'Enter' && this.pending.length >= 4) { this.commitPending(); return true; }
		if ((event.key === 'Delete' || event.key === 'Backspace') && this.manager.selectedIds().length > 0) {
			this.manager.remove(this.manager.selectedIds());
			return true;
		}
		return false;
	}

	private cancelPending(): void {
		this.pending = [];
		this.pendingLivewirePath = [];
		this.drag = null;
		this.scheduleRedraw();
	}

	private commitPending(): void {
		const source = this.pendingLivewirePath.length >= 6 ? this.pendingLivewirePath : this.pending;
		const points = simplifyPolyline(source, 0.5);
		const kind: Roi['kind'] = this.tool === 'polyline' ? 'polyline'
			: this.tool === 'livewire' ? 'polygon'
				: 'polygon';
		if (points.length >= (kind === 'polyline' ? 4 : 6)) {
			this.manager.add({
				id: this.manager.nextId(),
				name: this.manager.nextName(kind),
				kind,
				source: 'manual',
				points,
				...(kind === 'polyline' ? { lineWidth: 1 } : {}),
			} as Roi);
		}
		this.cancelPending();
	}

	private dragRectRoi(drag: DragState): RectRoi | null {
		const x = Math.min(drag.startX, drag.currentX);
		const y = Math.min(drag.startY, drag.currentY);
		const width = Math.abs(drag.currentX - drag.startX);
		const height = Math.abs(drag.currentY - drag.startY);
		if (!(width > 0) || !(height > 0)) { return null; }
		return {
			id: 'preview',
			name: 'preview',
			kind: drag.tool === 'ellipse' ? 'ellipse' : 'rect',
			x, y, width, height,
		} as RectRoi;
	}

	// --- select tool --------------------------------------------------------

	private beginSelectDrag(event: MouseEvent, point: { x: number; y: number }): void {
		const tolerance = HIT_TOLERANCE_SCREEN / this.pixelScale();

		// Handles of the current selection win over everything else, so a handle
		// sitting on top of another ROI stays grabbable.
		for (const roi of this.manager.selectedRois()) {
			const handles = this.handlePositions(roi);
			for (let i = 0; i < handles.length; i++) {
				if (Math.hypot(handles[i].x - point.x, handles[i].y - point.y) <= tolerance) {
					event.preventDefault();
					event.stopPropagation();
					this.consumeNextClick = true;
					this.manager.beginEdit();
					this.drag = {
						tool: 'select',
						startX: point.x, startY: point.y,
						currentX: point.x, currentY: point.y,
						roiId: roi.id,
						vertexIndex: i,
						originalRoi: roi,
					};
					return;
				}
			}
		}

		const hit = this.hitTest(point, tolerance);
		if (!hit) {
			// Nothing under the cursor: let the click reach the image so pan and
			// the pixel inspector keep working exactly as before.
			this.consumeNextClick = false;
			this.manager.clearSelection();
			this.forwardToImage(event);
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		// The click that follows this press would otherwise reach the container
		// and zoom the image, so every selection would also change the view.
		this.consumeNextClick = true;
		if (event.shiftKey || event.ctrlKey || event.metaKey) {
			this.manager.toggleSelection(hit.id);
		} else if (!this.manager.isSelected(hit.id)) {
			this.manager.select([hit.id]);
		}
		this.manager.beginEdit();
		this.drag = {
			tool: 'select',
			startX: point.x, startY: point.y,
			currentX: point.x, currentY: point.y,
			roiId: hit.id,
			moving: true,
			originalRoi: hit,
		};
	}

	private updateSelectDrag(point: { x: number; y: number }): void {
		const drag = this.drag;
		if (!drag || !drag.roiId || !drag.originalRoi) { return; }
		const dx = point.x - drag.startX;
		const dy = point.y - drag.startY;
		const original = drag.originalRoi;

		if (drag.moving) {
			this.manager.update(drag.roiId, () => translateRoi(original, dx, dy), { interactive: true });
			return;
		}

		if (drag.vertexIndex === undefined) { return; }
		const index = drag.vertexIndex;

		if (original.kind === 'rect' || original.kind === 'ellipse') {
			const r = original as RectRoi;
			const cx = r.x + r.width / 2;
			const cy = r.y + r.height / 2;

			if (index === 4) {
				// Rotation. The grip starts above the centre, so the angle is the
				// bearing to the pointer measured from straight up.
				const angle = Math.atan2(point.y - cy, point.x - cx) + Math.PI / 2;
				this.manager.update(drag.roiId, () => ({ ...r, angle } as Roi), { interactive: true });
				return;
			}

			// Resizing happens in the shape's own frame: with a rotated ROI the
			// pointer has to be un-rotated first, or dragging a corner shears the
			// box instead of resizing it.
			const angle = r.angle || 0;
			const unspin = (px: number, py: number) => {
				if (!angle) { return { x: px, y: py }; }
				const cos = Math.cos(-angle);
				const sin = Math.sin(-angle);
				const dx = px - cx;
				const dy = py - cy;
				return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
			};
			const local = unspin(point.x, point.y);

			let left = r.x;
			let top = r.y;
			let right = r.x + r.width;
			let bottom = r.y + r.height;
			if (index === 0) { left = local.x; top = local.y; }
			else if (index === 1) { right = local.x; top = local.y; }
			else if (index === 2) { right = local.x; bottom = local.y; }
			else { left = local.x; bottom = local.y; }
			const updated = {
				...r,
				x: Math.min(left, right),
				y: Math.min(top, bottom),
				width: Math.abs(right - left),
				height: Math.abs(bottom - top),
			};
			this.manager.update(drag.roiId, () => updated as Roi, { interactive: true });
			return;
		}

		const points = ((original as PolygonRoi).points || []).slice();
		const stride = points.length / 2 > 64 ? Math.ceil(points.length / 2 / 64) : 1;
		const vertex = index * stride;
		if (vertex * 2 + 1 < points.length) {
			points[vertex * 2] = point.x;
			points[vertex * 2 + 1] = point.y;
			this.manager.update(drag.roiId, roi => ({ ...roi, points } as Roi), { interactive: true });
		}
	}

	private hitTest(point: { x: number; y: number }, tolerance: number): Roi | null {
		const rois = this.manager.list();
		// Topmost first: the draw order is bottom-to-top, so picking must reverse.
		for (let i = rois.length - 1; i >= 0; i--) {
			const roi = rois[i];
			if (roi.kind === 'point') {
				const points = (roi as PointRoi).points || [];
				for (let k = 0; k + 1 < points.length; k += 2) {
					if (Math.hypot(points[k] - point.x, points[k + 1] - point.y) <= tolerance * 1.5) { return roi; }
				}
				continue;
			}
			if (isLineKind(roi.kind)) {
				if (distanceToPolyline((roi as PolygonRoi).points || [], point.x, point.y) <= tolerance) { return roi; }
				continue;
			}
			if (roiContains(roi, point.x, point.y)) { return roi; }
			const outline = roi.kind === 'mask' ? maskContour(roi as MaskRoi) : roiOutline(roi);
			if (outline.length >= 4 && distanceToPolyline(outline, point.x, point.y) <= tolerance) { return roi; }
		}
		return null;
	}

	/**
	 * Re-dispatch a click to the image beneath the overlay.
	 *
	 * The overlay covers the whole viewport, so without this a click on empty
	 * space would be swallowed and panning would stop working the moment the
	 * panel is opened.
	 */
	private forwardToImage(event: MouseEvent): void {
		const element = this.host.getImageElement();
		if (!element) { return; }
		const clone = new MouseEvent(event.type, {
			bubbles: true,
			cancelable: true,
			clientX: event.clientX,
			clientY: event.clientY,
			button: event.button,
			buttons: event.buttons,
			ctrlKey: event.ctrlKey,
			shiftKey: event.shiftKey,
			altKey: event.altKey,
			metaKey: event.metaKey,
		});
		element.dispatchEvent(clone);
	}

	// --- wand ---------------------------------------------------------------

	private lastWandTolerance = 0;

	private updateWandPreview(point: { x: number; y: number }): void {
		const plane = this.host.getScalarPlane();
		const source = this.host.getSource();
		if (!plane || !source) { this.wandPreview = null; return; }

		const x = Math.floor(point.x);
		const y = Math.floor(point.y);
		if (x < 0 || y < 0 || x >= source.width || y >= source.height) {
			this.wandPreview = null;
			this.scheduleRedraw();
			return;
		}

		const key = `${x},${y},${this.wandTolerance ?? 'auto'}`;
		if (key === this.wandPreviewKey) { return; }
		this.wandPreviewKey = key;

		const region = this.wandTolerance === null
			? growRegionAuto(plane, source.width, source.height, x, y)
			: growRegion(plane, source.width, source.height, x, y, { tolerance: this.wandTolerance });

		this.lastWandTolerance = region.tolerance;
		this.wandPreview = region.count > 0 ? region : null;
		this.host.onHint(region.count > 0
			? `${region.count} px · tolerance ${formatNumber(region.tolerance)} (scroll to adjust)`
			: 'No region at this point.');
		this.scheduleRedraw();
	}

	private commitWand(point: { x: number; y: number }, additive: boolean): void {
		this.updateWandPreview(point);
		const preview = this.wandPreview;
		if (!preview) { return; }

		if (additive) {
			// Shift-click extends the current mask ROI, which is how a user
			// assembles an object the grower splits across a faint bridge.
			const selected = this.manager.selectedRois().find(roi => roi.kind === 'mask') as MaskRoi | undefined;
			if (selected) {
				this.manager.update(selected.id, roi => mergeMasks(roi as MaskRoi, preview));
				return;
			}
		}

		this.manager.add({
			id: this.manager.nextId(),
			name: this.manager.nextName('mask'),
			kind: 'mask',
			source: 'wand',
			x: preview.x,
			y: preview.y,
			width: preview.width,
			height: preview.height,
			mask: preview.mask,
		});
	}

	// --- livewire -----------------------------------------------------------

	private ensureGradient(): Float32Array | null {
		const plane = this.host.getScalarPlane();
		const source = this.host.getSource();
		if (!plane || !source) { return null; }
		if (this.gradientCache && this.gradientCache.plane === plane) { return this.gradientCache.gradient; }
		const gradient = gradientMagnitude(plane, source.width, source.height);
		this.gradientCache = { plane, gradient };
		return gradient;
	}

	private addLivewirePoint(point: { x: number; y: number }): void {
		if (this.pending.length === 0) {
			this.pending.push(point.x, point.y);
			this.pendingLivewirePath = [point.x, point.y];
			this.host.onHint('Click along the boundary. The path snaps to the strongest edge. Double-click to close.');
			return;
		}
		// Freeze the previewed segment into the committed path.
		this.pendingLivewirePath = this.livewirePathTo(point);
		this.pending.push(point.x, point.y);
	}

	private updateLivewirePreview(point: { x: number; y: number }): void {
		this.pendingLivewirePath = this.livewirePathTo(point);
		this.scheduleRedraw();
	}

	private livewirePathTo(point: { x: number; y: number }): number[] {
		const gradient = this.ensureGradient();
		const source = this.host.getSource();
		if (!gradient || !source || this.pending.length < 2) { return this.pending.slice(); }

		const committed = this.pendingLivewirePath.length >= 2
			? this.pendingLivewirePath.slice(0, this.pendingLivewirePath.length)
			: this.pending.slice();

		const fromX = Math.round(this.pending[this.pending.length - 2]);
		const fromY = Math.round(this.pending[this.pending.length - 1]);
		const toX = Math.max(0, Math.min(source.width - 1, Math.round(point.x)));
		const toY = Math.max(0, Math.min(source.height - 1, Math.round(point.y)));

		const segment = traceBoundary(gradient, source.width, source.height, fromX, fromY, toX, toY);
		// Drop the duplicated join vertex so the path has no zero-length step.
		return committed.concat(segment.slice(2));
	}

	// --- point counter ------------------------------------------------------

	private addCounterPoint(point: { x: number; y: number }, remove: boolean): void {
		const existing = this.manager.selectedRois().find(roi => roi.kind === 'point') as PointRoi | undefined
			?? this.manager.list().find(roi => roi.kind === 'point') as PointRoi | undefined;

		const px = Math.floor(point.x);
		const py = Math.floor(point.y);

		if (!existing) {
			if (remove) { return; }
			this.manager.add({
				id: this.manager.nextId(),
				name: this.manager.nextName('point'),
				kind: 'point',
				source: 'manual',
				points: [px, py],
			});
			return;
		}

		if (remove) {
			// Alt-click removes the nearest marker, which is the only practical
			// way to fix a miscount without restarting.
			const points = existing.points.slice();
			let bestIndex = -1;
			let bestDistance = Infinity;
			for (let i = 0; i + 1 < points.length; i += 2) {
				const distance = Math.hypot(points[i] - point.x, points[i + 1] - point.y);
				if (distance < bestDistance) { bestDistance = distance; bestIndex = i; }
			}
			if (bestIndex >= 0 && bestDistance <= 12 / this.pixelScale()) {
				points.splice(bestIndex, 2);
				this.manager.update(existing.id, roi => ({ ...roi, points } as Roi));
			}
			return;
		}

		this.manager.update(existing.id, roi => ({
			...roi,
			points: ((roi as PointRoi).points || []).concat([px, py]),
		} as Roi));
	}

	// --- brush --------------------------------------------------------------

	private beginBrush(point: { x: number; y: number }, erase: boolean): void {
		let target = this.manager.selectedRois().find(roi => roi.kind === 'mask') as MaskRoi | undefined;
		if (!target) {
			if (erase) { return; }
			// Painting with nothing selected starts a new object rather than
			// doing nothing, which is what users expect from a brush.
			const created = this.manager.add({
				id: this.manager.nextId(),
				name: this.manager.nextName('mask'),
				kind: 'mask',
				source: 'manual',
				x: Math.max(0, Math.floor(point.x)),
				y: Math.max(0, Math.floor(point.y)),
				width: 1,
				height: 1,
				mask: new Uint8Array([0]),
			}) as MaskRoi;
			target = created;
		}
		this.manager.beginEdit();
		this.drag = {
			tool: 'brush',
			startX: point.x, startY: point.y,
			currentX: point.x, currentY: point.y,
			roiId: target.id,
			erase,
		};
		this.applyBrush(point, erase);
	}

	private applyBrush(point: { x: number; y: number }, erase: boolean): void {
		const drag = this.drag;
		const source = this.host.getSource();
		if (!drag || !drag.roiId || !source) { return; }
		this.manager.update(drag.roiId, roi => {
			if (roi.kind !== 'mask') { return roi; }
			const mask = roi as MaskRoi;
			const stroked = brushStroke(
				mask, point.x, point.y, this.brushRadius, erase, source.width, source.height,
			);
			return {
				...mask,
				x: stroked.x, y: stroked.y,
				width: stroked.width, height: stroked.height,
				mask: stroked.mask,
			};
		}, { interactive: true });
	}
}

/** Shift an ROI by a pixel offset, whatever its kind. */
function translateRoi(roi: Roi, dx: number, dy: number): Roi {
	switch (roi.kind) {
		case 'rect':
		case 'ellipse': {
			const r = roi as RectRoi;
			return { ...r, x: r.x + dx, y: r.y + dy };
		}
		case 'mask': {
			const m = roi as MaskRoi;
			// Masks move by their bounding box; the raster itself is unchanged, so
			// this stays cheap even for large objects. Rounding keeps the mask
			// pixel-aligned, which matters because it is never resampled.
			return { ...m, x: m.x + Math.round(dx), y: m.y + Math.round(dy) };
		}
		default: {
			const points = ((roi as PolygonRoi).points || []).slice();
			for (let i = 0; i + 1 < points.length; i += 2) {
				points[i] += dx;
				points[i + 1] += dy;
			}
			return { ...roi, points } as Roi;
		}
	}
}

/** Union of two mask regions, rebasing onto a bounding box covering both. */
function mergeMasks(a: MaskRoi, b: { x: number; y: number; width: number; height: number; mask: Uint8Array }): MaskRoi {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	const right = Math.max(a.x + a.width, b.x + b.width);
	const bottom = Math.max(a.y + a.height, b.y + b.height);
	const width = right - x;
	const height = bottom - y;
	const mask = new Uint8Array(width * height);

	const blit = (region: { x: number; y: number; width: number; height: number; mask: Uint8Array }) => {
		for (let row = 0; row < region.height; row++) {
			const targetRow = (row + region.y - y) * width + (region.x - x);
			for (let col = 0; col < region.width; col++) {
				if (region.mask[row * region.width + col]) { mask[targetRow + col] = 1; }
			}
		}
	};
	blit(a);
	blit(b);

	return { ...a, x, y, width, height, mask };
}

const TOOL_HINTS: Record<MeasureTool, string> = {
	select: 'Click an ROI to select it, drag to move, drag a handle to reshape. Delete removes the selection.',
	rect: 'Drag to draw a rectangle.',
	ellipse: 'Drag to draw an ellipse.',
	polygon: 'Click to add vertices. Double-click or Enter closes the polygon, Escape cancels.',
	freehand: 'Drag to trace an outline freehand.',
	line: 'Drag to draw a measurement line. Its profile appears in the panel.',
	polyline: 'Click to add segments. Double-click or Enter finishes, Escape cancels.',
	point: 'Click to drop counter markers. Alt-click removes the nearest one.',
	wand: 'Hover to preview the region, click to keep it. Scroll adjusts tolerance, Shift-click merges into the selected object.',
	brush: 'Drag to paint into the selected object. Alt-drag erases, scroll changes the brush size.',
	livewire: 'Click along an edge; the path snaps to the strongest boundary between clicks. Double-click closes.',
	calibrate: 'Drag along a feature of known length, then enter that length.',
};
