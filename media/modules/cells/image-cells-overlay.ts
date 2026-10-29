import type { CellsLayer } from './cells-layer.js';

export interface ImageCellsOverlayHost {
	getImageElement: () => HTMLElement | null;
	/** Full-resolution size of the image in pixels. */
	getImageSize: () => { width: number; height: number } | null;
}

const DRAG_TOLERANCE_PX = 4;

/**
 * Draws cell layers over the single-image viewer. Like the ROI overlay it is a
 * viewport-sized fixed canvas positioned from `getBoundingClientRect()` at draw
 * time, so it is exact under every zoom, pan and scroll state. It is created
 * with the first layer, so an image without cells has no extra canvas.
 */
export class ImageCellsOverlay {
	private readonly layers: CellsLayer[] = [];
	private canvas: HTMLCanvasElement | null = null;
	private handle = 0;
	private pressed: { x: number; y: number } | null = null;
	private readonly redraw = () => this.scheduleRedraw();

	constructor(private readonly host: ImageCellsOverlayHost) { }

	add(layer: CellsLayer): void {
		if (this.layers.length === 0) { this.attach(); }
		this.layers.push(layer);
		this.scheduleRedraw();
	}

	remove(layer: CellsLayer): void {
		const at = this.layers.indexOf(layer);
		if (at >= 0) { this.layers.splice(at, 1); }
		if (this.layers.length === 0) { this.detach(); } else { this.scheduleRedraw(); }
	}

	clear(): void {
		this.layers.length = 0;
		this.detach();
	}

	hasLayers(): boolean { return this.layers.length > 0; }

	scheduleRedraw(): void {
		if (!this.canvas || this.handle) { return; }
		this.handle = requestAnimationFrame(() => { this.handle = 0; this.draw(); });
	}

	private attach(): void {
		const canvas = document.createElement('canvas');
		canvas.className = 'cells-overlay';
		document.body.appendChild(canvas);
		this.canvas = canvas;
		window.addEventListener('scroll', this.redraw, true);
		window.addEventListener('resize', this.redraw);
		document.addEventListener('mousedown', this.onMouseDown, true);
		document.addEventListener('click', this.onClick, true);
	}

	private detach(): void {
		if (!this.canvas) { return; }
		cancelAnimationFrame(this.handle);
		this.handle = 0;
		window.removeEventListener('scroll', this.redraw, true);
		window.removeEventListener('resize', this.redraw);
		document.removeEventListener('mousedown', this.onMouseDown, true);
		document.removeEventListener('click', this.onClick, true);
		this.canvas.remove();
		this.canvas = null;
	}

	private geometry(): { rect: DOMRect; width: number; height: number } | null {
		const element = this.host.getImageElement();
		const size = this.host.getImageSize();
		if (!element || !size || size.width <= 0 || size.height <= 0) { return null; }
		const rect = element.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0 ? { rect, width: size.width, height: size.height } : null;
	}

	private draw(): void {
		const canvas = this.canvas;
		const context = canvas?.getContext('2d');
		if (!canvas || !context) { return; }
		if (!canvas.isConnected) { document.body.appendChild(canvas); }
		const dpr = window.devicePixelRatio || 1;
		const width = window.innerWidth, height = window.innerHeight;
		if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
			canvas.width = Math.round(width * dpr);
			canvas.height = Math.round(height * dpr);
			canvas.style.width = `${width}px`;
			canvas.style.height = `${height}px`;
		}
		context.setTransform(1, 0, 0, 1, 0, 0);
		context.clearRect(0, 0, canvas.width, canvas.height);
		const geometry = this.geometry();
		if (!geometry) { return; }
		const scale = dpr * geometry.rect.width / geometry.width;
		context.setTransform(scale, 0, 0, dpr * geometry.rect.height / geometry.height, dpr * geometry.rect.left, dpr * geometry.rect.top);
		context.save();
		context.beginPath();
		context.rect(0, 0, geometry.width, geometry.height);
		context.clip();
		for (const layer of this.layers) { if (!layer.isHidden()) { layer.draw(context, null, scale); } }
		context.restore();
	}

	private onMouseDown = (event: MouseEvent): void => { this.pressed = { x: event.clientX, y: event.clientY }; };

	/** A click on the image selects cells; one that selects something is not also a zoom. */
	private onClick = (event: MouseEvent): void => {
		const element = this.host.getImageElement();
		const target = event.target as Node | null;
		if (!element || !target || !element.contains(target)) { return; }
		const start = this.pressed;
		if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > DRAG_TOLERANCE_PX) { return; }
		const geometry = this.geometry();
		if (!geometry) { return; }
		const point = { x: (event.clientX - geometry.rect.left) * geometry.width / geometry.rect.width, y: (event.clientY - geometry.rect.top) * geometry.height / geometry.rect.height };
		let used = false;
		for (const layer of [...this.layers].reverse()) {
			if (!layer.isHidden() && layer.onClick(point, event)) { used = true; break; }
		}
		if (used) { event.preventDefault(); event.stopPropagation(); this.scheduleRedraw(); }
	};
}
