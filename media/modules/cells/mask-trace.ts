/**
 * Outlines of a label mask (cell n painted with the value n, 0 background) as polygons.
 * The tracer is Rust (`wasm/transcripts-decoder/src/mask.rs`, run through the module the cell
 * worker already holds); this file is the same algorithm in TypeScript for when that module is
 * a build from before the tracer existed, and the thin wrapper that picks between them.
 */

export type MaskSamples = Uint8Array | Uint16Array | Uint32Array;

/** One polygon per label, ascending: `offsets` (in vertices) index into `xy` pairs, in mask pixel corners. */
export interface TracedMask { labels: Uint32Array; offsets: Uint32Array; xy: Float32Array }

type Ring = [number, number][];

function twiceArea(ring: Ring): number {
	let sum = 0;
	for (let index = 0; index < ring.length; index++) {
		const [x0, y0] = ring[index], [x1, y1] = ring[(index + 1) % ring.length];
		sum += x0 * y1 - x1 * y0;
	}
	return sum;
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
	if (length === 0) { return Math.hypot(px - ax, py - ay); }
	const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function simplify(ring: Ring, epsilon: number): Ring {
	if (epsilon <= 0 || ring.length <= 4) { return ring; }
	let far = 1, farDistance = -1;
	for (let index = 1; index < ring.length; index++) {
		const distance = (ring[index][0] - ring[0][0]) ** 2 + (ring[index][1] - ring[0][1]) ** 2;
		if (distance > farDistance) { farDistance = distance; far = index; }
	}
	const keep = new Uint8Array(ring.length);
	keep[0] = 1; keep[far] = 1;
	const stack: [number, number][] = [[0, far], [far, ring.length]];
	while (stack.length) {
		const [first, last] = stack.pop()!;
		if (last <= first + 1) { continue; }
		const a = ring[first], b = ring[last % ring.length];
		let worst = 0, worstAt = first;
		for (let index = first + 1; index < last; index++) {
			const distance = distanceToSegment(ring[index][0], ring[index][1], a[0], a[1], b[0], b[1]);
			if (distance > worst) { worst = distance; worstAt = index; }
		}
		if (worst > epsilon) { keep[worstAt] = 1; stack.push([first, worstAt], [worstAt, last]); }
	}
	const thinned = ring.filter((_corner, index) => keep[index]);
	return thinned.length < 3 ? ring : thinned;
}

/** The TypeScript tracer: same rules and output as the Rust one. */
export function traceMaskJs(data: MaskSamples, width: number, height: number, epsilon: number): TracedMask {
	if (!(width > 0 && height > 0) || data.length < width * height) { throw new Error('The mask has no pixels.'); }
	const at = (x: number, y: number): number => x < 0 || y < 0 || x >= width || y >= height ? 0 : data[y * width + x];
	const visited = new Uint8Array(width * height);
	const best = new Map<number, { area: number; ring: Ring }>();
	const limit = 4 * (width + 1) * (height + 1) + 8;
	for (let sy = 0; sy < height; sy++) {
		for (let sx = 0; sx < width; sx++) {
			const label = data[sy * width + sx];
			if (label === 0 || at(sx, sy - 1) === label || visited[sy * width + sx]) { continue; }
			const corners: Ring = [[sx, sy]];
			let x = sx, y = sy, d = 0, steps = 0;
			for (;;) {
				if (d === 0) { visited[y * width + x] = 1; }
				if (d === 0) { x++; } else if (d === 1) { y++; } else if (d === 2) { x--; } else { y--; }
				const rx = d === 0 ? x : d === 1 ? x - 1 : d === 2 ? x - 1 : x;
				const ry = d === 0 ? y : d === 1 ? y : d === 2 ? y - 1 : y - 1;
				const lx = d === 0 ? x : d === 1 ? x : d === 2 ? x - 1 : x - 1;
				const ly = d === 0 ? y - 1 : d === 1 ? y : d === 2 ? y : y - 1;
				const next = at(rx, ry) !== label ? (d + 1) % 4 : at(lx, ly) === label ? (d + 3) % 4 : d;
				if (x === sx && y === sy && next === 0) { break; }
				if (next !== d) { corners.push([x, y]); }
				d = next;
				if (++steps > limit) { throw new Error('The mask outline did not close.'); }
			}
			const area = twiceArea(corners);
			if (area <= 0 || (best.get(label)?.area ?? 0) >= area) { continue; }
			best.set(label, { area, ring: simplify(corners, epsilon) });
		}
	}
	const labels = Uint32Array.from([...best.keys()].sort((a, b) => a - b));
	const offsets = new Uint32Array(labels.length + 1);
	let vertices = 0;
	labels.forEach((label, index) => { vertices += best.get(label)!.ring.length; offsets[index + 1] = vertices; });
	const xy = new Float32Array(vertices * 2);
	labels.forEach((label, index) => {
		best.get(label)!.ring.forEach(([cx, cy], vertex) => { xy[(offsets[index] + vertex) * 2] = cx; xy[(offsets[index] + vertex) * 2 + 1] = cy; });
	});
	return { labels, offsets, xy };
}

interface TracerExports {
	memory: WebAssembly.Memory;
	tx_alloc(length: number): number;
	tx_free(pointer: number, length: number): void;
	mask_trace?(data: number, width: number, height: number, bytes: number, epsilon: number): number;
	mask_polygons(): number;
	mask_vertices(): number;
	mask_labels_ptr(): number;
	mask_offsets_ptr(): number;
	mask_xy_ptr(): number;
	mask_clear(): void;
}

/** The Rust tracer, or null when the module predates it or fails; the caller then uses `traceMaskJs`. */
export function traceMaskWasm(module: WebAssembly.Module, data: MaskSamples, width: number, height: number, epsilon: number): TracedMask | null {
	let exports: TracerExports;
	try { exports = new WebAssembly.Instance(module, {}).exports as unknown as TracerExports; } catch { return null; }
	if (typeof exports.mask_trace !== 'function') { return null; }
	const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	const pointer = exports.tx_alloc(bytes.length);
	try {
		new Uint8Array(exports.memory.buffer).set(bytes, pointer);
		if (exports.mask_trace(pointer, width, height, data.BYTES_PER_ELEMENT, epsilon) !== 0) { return null; }
	} finally { exports.tx_free(pointer, bytes.length); }
	const polygons = exports.mask_polygons(), vertices = exports.mask_vertices();
	// Copied out: the views are into memory the module may reuse.
	const traced: TracedMask = {
		labels: new Uint32Array(exports.memory.buffer, exports.mask_labels_ptr(), polygons).slice(),
		offsets: new Uint32Array(exports.memory.buffer, exports.mask_offsets_ptr(), polygons + 1).slice(),
		xy: new Float32Array(exports.memory.buffer, exports.mask_xy_ptr(), vertices * 2).slice(),
	};
	exports.mask_clear();
	return traced;
}

export function traceMask(data: MaskSamples, width: number, height: number, epsilon: number, module?: WebAssembly.Module | null): TracedMask {
	return (module ? traceMaskWasm(module, data, width, height, epsilon) : null) ?? traceMaskJs(data, width, height, epsilon);
}
