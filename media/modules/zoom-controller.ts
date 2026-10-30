"use strict";

import type { SettingsManager } from './settings-manager.js';

type VsCodeApi = { postMessage: (msg: any) => any, getState: () => any, setState: (s: any) => void };

type Scale = number | 'fit';

/**
 * Zoom Controller Module
 * Handles zoom, scale, pan, and viewport management
 */
export class ZoomController {
	settingsManager: SettingsManager;
	vscode: VsCodeApi;
	scale: Scale;
	initialState: any;
	container: HTMLElement;
	imageElement: HTMLElement | null;
	canvas: HTMLCanvasElement | null;
	hasLoadedImage: boolean;
	/**
	 * Notified after every scale change. Overlays drawn in viewport coordinates
	 * (the ROI canvas and its scale bar) otherwise only refresh on scroll and
	 * resize, which a zoom on an image smaller than the viewport never produces.
	 */
	onScaleChanged: (() => void) | null = null;
	private gestureScale: number | null = null;
	/** With `scrollToZoom`: how far dragging has moved the image on an axis it has no scroll range on. */
	private panOffset = { x: 0, y: 0 };
	private endPan: (() => void) | null = null;
	private touchPinch: { distance: number, scale: number, x: number, y: number } | null = null;

	private viewport() {
		const style = getComputedStyle(this.container);
		const left = parseFloat(style.paddingLeft) || 0, right = parseFloat(style.paddingRight) || 0;
		const top = parseFloat(style.paddingTop) || 0, bottom = parseFloat(style.paddingBottom) || 0;
		const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
		return { width: Math.max(1, width - left - right), height: Math.max(1, height - top - bottom), left, top };
	}

	constructor(settingsManager: SettingsManager, vscode: VsCodeApi) {
		this.settingsManager = settingsManager;
		this.vscode = vscode;

		// Initialize state from VS Code
		// The host stores unrelated state in the same object (for example the web
		// build records its version before an image is opened). A truthy object is
		// therefore not evidence that zoom was ever saved. Missing zoom fields must
		// still mean "fit"; otherwise ordinary replaced elements happen to fit via
		// CSS while a tiled scene, which has no intrinsic layout size, collapses to
		// 0x0 and can never start its viewport requests.
		const storedState = vscode.getState() || {};
		const initialState = {
			...storedState,
			scale: storedState.scale ?? 'fit',
			offsetX: Number.isFinite(storedState.offsetX) ? storedState.offsetX : 0,
			offsetY: Number.isFinite(storedState.offsetY) ? storedState.offsetY : 0,
		};
		this.scale = initialState.scale;
		this.initialState = initialState;

		// DOM elements
		this.container = document.body;
		this.imageElement = null;
		this.canvas = null;
		this.hasLoadedImage = false;
	}

	/**
	 * Set the image element reference
	 */
	setImageElement(element: HTMLElement) {
		this.imageElement = element;
	}

	/**
	 * Set the canvas reference
	 */
	setCanvas(canvas: HTMLCanvasElement) {
		this.canvas = canvas;
	}

	_getNaturalSize(element: HTMLElement): { width: number, height: number } {
		const anyElement = element as any;
		const sceneWidth = Number(element.dataset?.sceneWidth);
		const sceneHeight = Number(element.dataset?.sceneHeight);
		return {
			width: sceneWidth > 0 ? sceneWidth : (anyElement.naturalWidth || anyElement.width || 0),
			height: sceneHeight > 0 ? sceneHeight : (anyElement.naturalHeight || anyElement.height || 0)
		};
	}

	/**
	 * Mark that image has been loaded
	 */
	setImageLoaded() {
		this.hasLoadedImage = true;
	}

	/**
	 * Update scale with new value
	 */
	updateScale(newScale: number | string, anchor?: { x: number, y: number }) {
		if (!this.imageElement || !this.hasLoadedImage || !this.imageElement.parentElement) {
			return;
		}

		const constants = this.settingsManager.constants;
		const wasInFitMode = this.scale === 'fit';
		if (this.container.classList.contains('web-app')) {
			this.container.classList.toggle('web-image-zoomed', newScale !== 'fit');
		}
		const viewport = this.viewport();
		// Viewport point that keeps its image content in place; the view center
		// unless a caller (touch pinch) zooms about another point.
		const centerX = anchor?.x ?? viewport.left + viewport.width / 2;
		const centerY = anchor?.y ?? viewport.top + viewport.height / 2;

		if (newScale === 'fit') {
			this.scale = 'fit';
			this.imageElement.classList.add('scale-to-fit');
			this.imageElement.classList.remove('pixelated');
			// Clear inline sizing and transforms when returning to fit
			this.imageElement.style.transform = '';
			this.imageElement.style.transformOrigin = '';
			this.imageElement.style.width = '';
			this.imageElement.style.height = '';
			this.imageElement.style.margin = '';
			// A pyramid scene is a normal element rather than a replaced img/canvas,
			// so object-fit cannot size it. Give it the same fitted dimensions here;
			// numeric zooms below continue to operate in full-resolution scene space.
			if (this.imageElement.classList.contains('pyramid-scene') || this.container.classList.contains('web-app')) {
				const { width, height } = this._getNaturalSize(this.imageElement);
				const fit = Math.min(
					this.container.classList.contains('web-app') ? Infinity : 1,
					Math.max(1, viewport.width - 20) / width,
					Math.max(1, viewport.height - 20) / height,
				);
				this.imageElement.style.width = `${width * fit}px`;
				this.imageElement.style.height = `${height * fit}px`;
				this.imageElement.style.margin = 'auto';
			}
			window.scrollTo(0, 0);
			this.panOffset = { x: 0, y: 0 };
			this.imageElement.style.translate = '';
			// Clear zoom fields but keep other state (peerImageUris, etc.)
			const existing = this.vscode.getState() || {};
			this.vscode.setState({ ...existing, scale: 'fit', offsetX: 0, offsetY: 0, panX: 0, panY: 0 });
		} else {
			const oldScale = this.scale;
			this.scale = this._clamp(newScale as number, this._minimumScale(), constants.MAX_SCALE);
			if (this.scale >= constants.PIXELATION_THRESHOLD) {
				this.imageElement.classList.add('pixelated');
			} else {
				this.imageElement.classList.remove('pixelated');
			}

			// Compute the image-space point under the viewport center before scaling
			const { width: naturalWidth, height: naturalHeight } = this._getNaturalSize(this.imageElement);
			const prevScale = (wasInFitMode)
				? (this.imageElement.clientWidth / naturalWidth)
				: (oldScale as number);

			// Viewport center in document coordinates
			const viewportCenterX = window.scrollX + centerX;
			const viewportCenterY = window.scrollY + centerY;
			// Element top-left in document coordinates
			const rectBefore = this.imageElement.getBoundingClientRect();
			const elemLeftDoc = window.scrollX + rectBefore.left;
			const elemTopDoc = window.scrollY + rectBefore.top;
			// Image-space center point
			const centerXImage = (viewportCenterX - elemLeftDoc) / prevScale;
			const centerYImage = (viewportCenterY - elemTopDoc) / prevScale;

			// Switch to layout-based scaling: remove fit class and set explicit size
			this.imageElement.classList.remove('scale-to-fit');
			this.imageElement.style.transform = '';
			this.imageElement.style.transformOrigin = '';
			this.imageElement.style.width = `${naturalWidth * this.scale}px`;
			this.imageElement.style.height = `${naturalHeight * this.scale}px`;

			// Center when smaller than viewport, remove margins when scrollable
			const canScrollX = naturalWidth * this.scale > viewport.width;
			const canScrollY = naturalHeight * this.scale > viewport.height;
			this.imageElement.style.marginLeft = canScrollX ? '0' : 'auto';
			this.imageElement.style.marginRight = canScrollX ? '0' : 'auto';
			this.imageElement.style.marginTop = canScrollY ? '0' : 'auto';
			this.imageElement.style.marginBottom = canScrollY ? '0' : 'auto';

			if (!this.scrollToZoom) { this.panOffset = { x: 0, y: 0 }; }
			this.applyPanOffset();

			// Recalculate element position after layout change
			const rectAfter = this.imageElement.getBoundingClientRect();
			const elemLeftDocAfter = window.scrollX + rectAfter.left;
			const elemTopDocAfter = window.scrollY + rectAfter.top;

			// Calculate new scroll position to keep the same image point centered
			let newScrollX = centerXImage * this.scale + elemLeftDocAfter - centerX;
			let newScrollY = centerYImage * this.scale + elemTopDocAfter - centerY;

			// Clamp scroll positions to valid ranges
			const scrolling = document.scrollingElement || this.container;
			const maxScrollX = Math.max(0, scrolling.scrollWidth - document.documentElement.clientWidth);
			const maxScrollY = Math.max(0, scrolling.scrollHeight - document.documentElement.clientHeight);
			newScrollX = Math.min(Math.max(0, newScrollX), maxScrollX);
			newScrollY = Math.min(Math.max(0, newScrollY), maxScrollY);

			window.scrollTo(newScrollX, newScrollY);

			if (this.scrollToZoom) {
				// Whatever the scroll range could not absorb is taken by the offset, which keeps the image point under the cursor.
				const rectNow = this.imageElement.getBoundingClientRect();
				this.panOffset.x += centerX - (rectNow.left + centerXImage * this.scale);
				this.panOffset.y += centerY - (rectNow.top + centerYImage * this.scale);
				this.clampPan();
				this.applyPanOffset();
			}

			// Merge zoom fields into existing state to avoid erasing app-level fields
			const existing = this.vscode.getState() || {};
			this.vscode.setState({ ...existing, scale: this.scale, offsetX: newScrollX, offsetY: newScrollY, panX: this.panOffset.x, panY: this.panOffset.y });
		}

		this.vscode.postMessage({
			type: 'zoom',
			value: this.scale
		});

		this.onScaleChanged?.();
	}

	/**
	 * Zoom in to next level
	 */
	zoomIn() {
		if (!this.imageElement || !this.hasLoadedImage) {
			return;
		}

		if (this.scale === 'fit') {
			this.firstZoom();
		}

		const zoomLevels = this.settingsManager.constants.ZOOM_LEVELS;
		let i = 0;
		for (; i < zoomLevels.length; ++i) {
			if (zoomLevels[i] > (this.scale as number)) {
				break;
			}
		}
		this.updateScale(zoomLevels[i] || this.settingsManager.constants.MAX_SCALE);
	}

	/**
	 * Zoom out to previous level
	 */
	zoomOut() {
		if (!this.imageElement || !this.hasLoadedImage) {
			return;
		}

		if (this.scale === 'fit') {
			this.firstZoom();
		}

		const zoomLevels = this.settingsManager.constants.ZOOM_LEVELS;
		let i = zoomLevels.length - 1;
		for (; i >= 0; --i) {
			if (zoomLevels[i] < (this.scale as number)) {
				break;
			}
		}
		this.updateScale(zoomLevels[i] || this._minimumScale());
	}

	/**
	 * Calculate first zoom level based on current display size
	 */
	firstZoom() {
		if (!this.imageElement || !this.hasLoadedImage) {
			return;
		}
		const { width } = this._getNaturalSize(this.imageElement);
		this.scale = this.imageElement.clientWidth / width;
		this.updateScale(this.scale);
	}

	/**
	 * Reset zoom to fit
	 */
	resetZoom() {
		this.updateScale('fit');
	}

	/**
	 * Handle mouse wheel events for zooming
	 */
	handleWheelZoom(e: WheelEvent, ctrlPressed: boolean, altPressed: boolean) {
		if (!this.imageElement || !this.hasLoadedImage) {
			return;
		}

		// Embedded IDE controls can receive the keydown before focus reaches the
		// image. WheelEvent carries the modifier even when that keydown was missed.
		const isScrollWheelKeyPressed = this.settingsManager.isMac ? (e.altKey || altPressed) : (e.ctrlKey || ctrlPressed);
		const scrollToZoom = this.scrollToZoom;
		if (!scrollToZoom && !isScrollWheelKeyPressed && !e.ctrlKey) { // pinching is reported as scroll wheel + ctrl
			return;
		}

		e.preventDefault();
		e.stopPropagation();
		if (this.gestureScale !== null) { return; }
		if (!e.deltaY) { return; }

		if (this.scale === 'fit') {
			this.firstZoom();
		}

		if (scrollToZoom) {
			const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.viewport().height : 1;
			const delta = Math.max(-100, Math.min(100, e.deltaY * unit));
			this.updateScale((this.scale as number) * Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0025)), { x: e.clientX, y: e.clientY });
		} else if (this.container.classList.contains('web-app') && !document.documentElement.classList.contains('jetbrains-host')) {
			const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.viewport().height : 1;
			const delta = Math.max(-100, Math.min(100, e.deltaY * unit));
			this.updateScale((this.scale as number) * Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0025)));
		} else {
			const delta = e.deltaY > 0 ? 1 : -1;
			this.updateScale((this.scale as number) * (1 - delta * this.settingsManager.constants.SCALE_PINCH_FACTOR));
		}
	}

	/** `tiffVisualizer.scrollToZoom`: the wheel zooms about the cursor and dragging the image pans it. */
	get scrollToZoom(): boolean { return this.settingsManager.settings.scrollToZoom === true; }

	/** Disabling drag-pan also removes its translation, including an unfinished drag. */
	applyInteractionSettings(): void {
		if (this.scrollToZoom) { return; }
		this.endPan?.();
		if (!this.panOffset.x && !this.panOffset.y) { return; }
		this.panOffset = { x: 0, y: 0 };
		this.applyPanOffset();
		this.saveState();
	}

	/** Double-click fits the image only when scroll-to-zoom is enabled. */
	handleDoubleClick(event: MouseEvent): void {
		if (!this.scrollToZoom || !this.hasLoadedImage || event.button !== 0 || event.target !== this.imageElement) { return; }
		event.preventDefault();
		this.endPan?.();
		this.updateScale('fit');
	}

	/** Start panning by dragging, including at fit. */
	beginPan(event: MouseEvent): boolean {
		if (!this.scrollToZoom || !this.hasLoadedImage || (event.button !== 0 && event.button !== 1)) { return false; }
		this.endPan?.();
		event.preventDefault();
		let last = { x: event.clientX, y: event.clientY };
		let moved = false;
		this.container.classList.add('panning');
		const move = (e: MouseEvent) => {
			if (!moved && Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) < ZoomController.DRAG_THRESHOLD) { return; }
			moved = true;
			const dx = e.clientX - last.x, dy = e.clientY - last.y;
			this.panBy(dx, dy);
			last = { x: e.clientX, y: e.clientY };
		};
		const up = () => {
			window.removeEventListener('mousemove', move, true);
			window.removeEventListener('mouseup', up, true);
			window.removeEventListener('blur', up);
			this.endPan = null;
			this.container.classList.remove('panning');
			if (moved) { this.saveState(); }
		};
		this.endPan = up;
		window.addEventListener('mousemove', move, true);
		window.addEventListener('mouseup', up, true);
		window.addEventListener('blur', up);
		return true;
	}

	static readonly DRAG_THRESHOLD = 4;

	/** The image point at the viewport center, including scroll and drag displacement. */
	getRelativeCenter(): { x: number; y: number } {
		const rect = this.imageElement?.getBoundingClientRect();
		if (!rect?.width || !rect.height) { return { x: 0.5, y: 0.5 }; }
		const viewport = this.viewport();
		return {
			x: (viewport.left + viewport.width / 2 - rect.left) / rect.width,
			y: (viewport.top + viewport.height / 2 - rect.top) / rect.height,
		};
	}

	/** Position a copied image point using whichever pan mechanism is enabled. */
	centerOn(relativeX: number, relativeY: number): void {
		if (!this.imageElement || !Number.isFinite(relativeX) || !Number.isFinite(relativeY)) { return; }
		const rect = this.imageElement.getBoundingClientRect();
		const viewport = this.viewport();
		const dx = viewport.left + viewport.width / 2 - (rect.left + relativeX * rect.width);
		const dy = viewport.top + viewport.height / 2 - (rect.top + relativeY * rect.height);
		if (this.scrollToZoom) { this.panBy(dx, dy); }
		else { window.scrollBy(-dx, -dy); }
		this.saveState();
	}

	/**
	 * Move the image by the drag distance. A moved offset returns to zero first, then the page
	 * scrolls, and whatever scrolling cannot absorb (the page edge) becomes the offset.
	 */
	private panBy(dx: number, dy: number) {
		const back = (offset: number, delta: number) => (offset * delta < 0 ? Math.sign(delta) * Math.min(Math.abs(delta), Math.abs(offset)) : 0);
		const returnX = back(this.panOffset.x, dx), returnY = back(this.panOffset.y, dy);
		this.panOffset.x += returnX;
		this.panOffset.y += returnY;
		const wantX = dx - returnX, wantY = dy - returnY;
		const beforeX = window.scrollX, beforeY = window.scrollY;
		window.scrollBy(0 - wantX, 0 - wantY);
		this.panOffset.x += wantX + (window.scrollX - beforeX);
		this.panOffset.y += wantY + (window.scrollY - beforeY);
		this.clampPan();
		this.applyPanOffset();
	}

	private applyPanOffset() {
		if (!this.imageElement) { return; }
		const { x, y } = this.panOffset;
		this.imageElement.style.translate = x || y ? `${x}px ${y}px` : '';
		this.onScaleChanged?.();
	}

	/** Keep some of the image in view however far it is dragged. */
	private clampPan() {
		if (!this.imageElement) { return; }
		const keep = 32;
		const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
		const limitX = Math.max(0, (width + Math.min(width, this.imageElement.offsetWidth)) / 2 - keep);
		const limitY = Math.max(0, (height + Math.min(height, this.imageElement.offsetHeight)) / 2 - keep);
		this.panOffset.x = Math.min(limitX, Math.max(-limitX, this.panOffset.x));
		this.panOffset.y = Math.min(limitY, Math.max(-limitY, this.panOffset.y));
	}

	/** Safari emits GestureEvents for trackpad pinches instead of ctrl-wheel. */
	handleGesture(event: Event & { scale?: number }) {
		if (!this.imageElement || !this.hasLoadedImage) { return; }
		event.preventDefault();
		if (event.type === 'gestureend') { this.gestureScale = null; return; }
		if (event.type === 'gesturestart') {
			this.gestureScale = this.imageElement.clientWidth / this._getNaturalSize(this.imageElement).width;
			return;
		}
		if (this.gestureScale !== null && Number.isFinite(event.scale) && event.scale! > 0) {
			this.updateScale(this.gestureScale * event.scale!);
		}
	}

	/**
	 * Two-finger pinch on touch screens. The image point under the fingers'
	 * midpoint stays under it, so dragging both fingers pans while pinching.
	 * One-finger drags stay with native scrolling.
	 */
	handleTouch(event: TouchEvent) {
		// Safari reports the same pinch as gesture events; those own it there.
		if (!this.imageElement || !this.hasLoadedImage || this.gestureScale !== null) { return; }
		const touches = Array.from(event.touches);
		if (touches.length !== 2 || !touches.every(touch => this.isImageSurface(touch.target))) {
			this.touchPinch = null;
			return;
		}
		const [a, b] = touches;
		const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
		if (!(distance > 0)) { return; }
		if (event.cancelable) { event.preventDefault(); }
		const x = (a.clientX + b.clientX) / 2, y = (a.clientY + b.clientY) / 2;
		if (event.type === 'touchstart' || !this.touchPinch) {
			if (this.scale === 'fit') { this.firstZoom(); }
			this.touchPinch = { distance, scale: this.scale as number, x, y };
			return;
		}
		const pinch = this.touchPinch;
		this.updateScale(pinch.scale * distance / pinch.distance, { x: pinch.x, y: pinch.y });
		// A move that cannot be cancelled means the browser already started a
		// native scroll, which pans with the fingers on its own.
		if (event.cancelable) { window.scrollBy(pinch.x - x, pinch.y - y); }
		pinch.x = x;
		pinch.y = y;
	}

	/** Touches on panels, toolbars and controls must not zoom the image behind them. */
	private isImageSurface(target: EventTarget | null) {
		const element = target as Element | null;
		return !!element && (
			element === this.container || element === document.documentElement ||
			!!this.imageElement?.contains(element) || !!element.closest?.('.measure-overlay'));
	}

	/**
	 * Apply initial zoom and scroll position
	 */
	applyInitialZoom() {
		this.updateScale(this.scale);

		if (this.initialState.scale !== 'fit') {
			window.scrollTo(this.initialState.offsetX, this.initialState.offsetY);
		}
		this.restorePan(this.initialState);
	}

	/**
	 * Save current state
	 */
	saveState() {
		const existing = this.vscode.getState() || {};
		this.vscode.setState({
			...existing,
			scale: this.scale,
			offsetX: window.scrollX,
			offsetY: window.scrollY,
			panX: this.panOffset.x,
			panY: this.panOffset.y
		});
	}

	/**
	 * Get current zoom state for image switching
	 */
	getCurrentState() {
		return {
			scale: this.scale,
			x: window.scrollX,
			y: window.scrollY,
			panX: this.panOffset.x,
			panY: this.panOffset.y
		};
	}

	/**
	 * Restore zoom state after image switching
	 */
	restoreState(state: any) {
		if (state && state.scale !== undefined) {
			this.updateScale(state.scale);
			if (state.x !== undefined && state.y !== undefined) {
				// Use requestAnimationFrame so the scroll fires after the browser
				// has reflowed the new element dimensions, without a visible delay
				requestAnimationFrame(() => {
					window.scrollTo(state.x, state.y);
					this.restorePan(state);
				});
			} else { this.restorePan(state); }
		}
	}

	private restorePan(state: { panX?: number; panY?: number }): void {
		this.panOffset = {
			x: this.scrollToZoom && Number.isFinite(state.panX) ? state.panX! : 0,
			y: this.scrollToZoom && Number.isFinite(state.panY) ? state.panY! : 0,
		};
		this.clampPan();
		this.applyPanOffset();
		this.saveState();
	}

	/**
	 * The smallest zoom this image can take.
	 *
	 * `MIN_SCALE` (10%) suits an image of ordinary size; on a very large one it
	 * is above the scale that fits the window, so the reader cannot zoom out far
	 * enough to see the whole picture — 10% of a 20000-pixel raster is still
	 * 2000 pixels wide. Whatever the constant says, it must always be possible
	 * to get the whole image on screen, with a little room past that.
	 */
	_minimumScale(): number {
		const constants = this.settingsManager.constants;
		if (!this.imageElement) { return constants.MIN_SCALE; }
		const { width, height } = this._getNaturalSize(this.imageElement);
		if (!(width > 0 && height > 0)) { return constants.MIN_SCALE; }
		const fit = Math.min(
			this.container.clientWidth / width,
			this.container.clientHeight / height,
		);
		if (!(fit > 0)) { return constants.MIN_SCALE; }
		return Math.min(constants.MIN_SCALE, fit / 2);
	}

	/**
	 * Clamp a value between min and max
	 * @private
	 */
	_clamp(value: number, min: number, max: number): number {
		return Math.min(Math.max(value, min), max);
	}
}
