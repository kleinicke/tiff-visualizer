"use strict";

import {
	LUT_STEPS,
	prepareChannels,
	type ChannelPlane,
	type ChannelSettings,
	type CompositeOptions,
} from './channel-composite.js';

/**
 * WebGPU multi-channel compositor.
 *
 * The arithmetic is identical to the CPU path in `channel-composite.ts` — and
 * deliberately not reimplemented here. `prepareChannels()` builds the per-channel
 * colour lookup table for both, so tint, opacity, gamma and colormap can only
 * ever be computed one way. The shader below does exactly two things the CPU
 * loop also does: normalise a sample into the channel's display range, and add
 * the table entry it lands on.
 *
 * That split matters because the CPU path is the correctness reference for the
 * whole render stack. A shader that re-derived the colour maths would drift from
 * it silently, and a composite that disagrees with the measurement subsystem
 * about what a pixel contains is worse than a slow one.
 *
 * WebGPU is used unconditionally where available; there is no WebGL2 variant.
 * A second GPU path would double the surface for a backend that is on its way
 * out, and the CPU fallback already covers everything WebGL2 would have.
 */

const TEXTURE_USAGE = {
	TEXTURE_BINDING: 0x04,
	COPY_DST: 0x02,
	RENDER_ATTACHMENT: 0x10,
	COPY_SRC: 0x01,
};

const BUFFER_USAGE = {
	UNIFORM: 0x40,
	COPY_DST: 0x08,
};

/**
 * Hard ceiling on channels composited on the GPU.
 *
 * Array-texture layers are cheap, but the uniform block is fixed-size and eight
 * simultaneous fluorescence channels is already well past what anyone displays
 * at once. Anything beyond this falls back to the CPU rather than failing.
 */
export const MAX_GPU_CHANNELS = 8;

const SHADER = /* wgsl */ `
struct ChannelParams {
	// x: min, y: 1/(max-min), z: layer index, w: unused
	range : vec4<f32>,
};

struct Uniforms {
	channelCount : u32,
	_pad0 : u32,
	_pad1 : u32,
	_pad2 : u32,
	nanColor : vec4<f32>,
	channels : array<ChannelParams, ${MAX_GPU_CHANNELS}>,
};

@group(0) @binding(0) var<uniform> uniforms : Uniforms;
@group(0) @binding(1) var planes : texture_2d_array<f32>;
@group(0) @binding(2) var luts : texture_2d<f32>;

struct VertexOutput {
	@builtin(position) position : vec4<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) index : u32) -> VertexOutput {
	// Full-screen triangle. Cheaper than a quad and avoids the diagonal seam
	// that a two-triangle quad can show under some rasterisation rules.
	var positions = array<vec2<f32>, 3>(
		vec2<f32>(-1.0, -3.0),
		vec2<f32>(-1.0,  1.0),
		vec2<f32>( 3.0,  1.0),
	);
	var output : VertexOutput;
	output.position = vec4<f32>(positions[index], 0.0, 1.0);
	return output;
}

@fragment
fn fragmentMain(@builtin(position) position : vec4<f32>) -> @location(0) vec4<f32> {
	let coord = vec2<i32>(i32(position.x), i32(position.y));
	var accumulated = vec3<f32>(0.0, 0.0, 0.0);
	var sawFinite = false;

	for (var c : u32 = 0u; c < uniforms.channelCount; c = c + 1u) {
		let params = uniforms.channels[c].range;
		let value = textureLoad(planes, coord, i32(params.z), 0).r;

		// NaN and infinities contribute nothing rather than clamping to the
		// bottom of the range — the same rule the CPU path and the measurement
		// subsystem apply. WGSL has no isnan(), and a fast-math build may fold
		// value != value away, so the finite test is written as a bounds check.
		let finite = value > -3.4e38 && value < 3.4e38;
		if (finite) {
			sawFinite = true;
			var t = (value - params.x) * params.y;
			t = clamp(t, 0.0, 1.0);
			let step = i32(t * ${LUT_STEPS - 1}.0);
			accumulated = accumulated + textureLoad(luts, vec2<i32>(step, i32(c)), 0).rgb;
		}
	}

	if (!sawFinite && uniforms.channelCount > 0u) {
		return vec4<f32>(uniforms.nanColor.rgb, 1.0);
	}
	// Saturating add, matching the CPU path's Uint8ClampedArray.
	return vec4<f32>(clamp(accumulated, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
`;

export class WebGPUChannelCompositor {
	private device: any = null;
	private context: any = null;
	private canvas: HTMLCanvasElement | null = null;
	private pipeline: any = null;
	private uniformBuffer: any = null;
	private planeTexture: any = null;
	private lutTexture: any = null;
	private planeKey = '';
	private initPromise: Promise<void> | null = null;
	private unavailable = false;
	private logger: (message: string) => void;

	constructor(logger: (message: string) => void = message => console.warn(message)) {
		this.logger = logger;
	}

	static isSupported(): boolean {
		return typeof navigator !== 'undefined' && !!(navigator as any).gpu;
	}

	/** True once a device exists; callers use this to report the active backend. */
	isReady(): boolean { return !!this.device && !!this.pipeline; }

	/** True when this backend has permanently given up for this session. */
	isUnavailable(): boolean { return this.unavailable; }

	async initialize(): Promise<boolean> {
		if (this.unavailable) { return false; }
		if (this.device && this.pipeline) { return true; }
		if (this.initPromise) {
			await this.initPromise;
			return !!this.device && !!this.pipeline;
		}

		this.initPromise = (async () => {
			const gpu = (navigator as any).gpu;
			if (!gpu) { throw new Error('navigator.gpu is unavailable'); }
			const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
			if (!adapter) { throw new Error('No WebGPU adapter is available'); }
			const device = await adapter.requestDevice();

			const canvas = document.createElement('canvas');
			const context = canvas.getContext('webgpu') as any;
			if (!context) { throw new Error('Could not create a WebGPU canvas context'); }
			const format = gpu.getPreferredCanvasFormat();
			context.configure({
				device,
				format,
				alphaMode: 'opaque',
				usage: TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.COPY_SRC,
			});

			device.lost.then((info: any) => {
				// A replacement device may already exist by the time this fires;
				// tearing that one down would be worse than the original loss.
				if (this.device !== device) { return; }
				this.logger(`[Channels] WebGPU device lost: ${info?.message || info?.reason || 'unknown reason'}`);
				this.dispose();
			});
			device.addEventListener?.('uncapturederror', (event: any) =>
				this.logger(`[Channels] WebGPU validation error: ${event.error?.message || event.error}`));

			const module = device.createShaderModule({ code: SHADER, label: 'Channel composite shader' });
			const pipeline = await device.createRenderPipelineAsync({
				label: 'Channel composite pipeline',
				layout: 'auto',
				vertex: { module, entryPoint: 'vertexMain' },
				fragment: { module, entryPoint: 'fragmentMain', targets: [{ format }] },
				primitive: { topology: 'triangle-list' },
			});

			// 16 bytes of header + 16 per channel.
			this.uniformBuffer = device.createBuffer({
				size: 32 + MAX_GPU_CHANNELS * 16,
				usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
				label: 'Channel composite uniforms',
			});

			this.device = device;
			this.canvas = canvas;
			this.context = context;
			this.pipeline = pipeline;
		})().catch(error => {
			this.logger(`[Channels] WebGPU unavailable, using the CPU compositor: ${error}`);
			this.unavailable = true;
			this.device = null;
			this.pipeline = null;
		}).finally(() => {
			this.initPromise = null;
		});

		await this.initPromise;
		return !!this.device && !!this.pipeline;
	}

	/**
	 * Composite on the GPU, returning the canvas it drew into.
	 *
	 * Returns null when the GPU path cannot serve this request — no device, too
	 * many channels, nothing visible — and the caller falls back to the CPU. A
	 * null here is routine, not an error.
	 */
	render(
		planes: ChannelPlane[],
		settings: ChannelSettings[],
		width: number,
		height: number,
		options: CompositeOptions = {},
	): HTMLCanvasElement | null {
		if (!this.device || !this.pipeline || !this.context || !this.canvas) { return null; }
		if (width <= 0 || height <= 0) { return null; }

		const prepared = prepareChannels(planes, settings, width, height, {
			gamma: options.gamma,
			solo: options.soloIndex ?? null,
		});
		if (prepared.length === 0 || prepared.length > MAX_GPU_CHANNELS) { return null; }

		const device = this.device;
		if (this.canvas.width !== width || this.canvas.height !== height) {
			this.canvas.width = width;
			this.canvas.height = height;
			// A resize invalidates the array texture's dimensions.
			this.planeKey = '';
		}

		// --- plane textures ---------------------------------------------------
		// Keyed on identity of the planes, so panning a slider re-uploads only the
		// LUT and the uniforms. Re-uploading megabytes of sample data per frame
		// would make the GPU path slower than the CPU one.
		const key = `${width}x${height}:${prepared.map(entry => entry.plane.index).join(',')}:${planes.length}`;
		if (key !== this.planeKey || !this.planeTexture) {
			this.planeTexture?.destroy?.();
			this.planeTexture = device.createTexture({
				size: { width, height, depthOrArrayLayers: prepared.length },
				format: 'r32float',
				usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST,
				label: 'Channel planes',
			});
			for (let i = 0; i < prepared.length; i++) {
				const data = prepared[i].plane.data;
				const typed = data instanceof Float32Array ? data : Float32Array.from(data as ArrayLike<number>);
				device.queue.writeTexture(
					{ texture: this.planeTexture, origin: { x: 0, y: 0, z: i } },
					typed,
					{ bytesPerRow: width * 4, rowsPerImage: height },
					{ width, height, depthOrArrayLayers: 1 },
				);
			}
			this.planeKey = key;
		}

		// --- lookup tables ----------------------------------------------------
		if (!this.lutTexture) {
			this.lutTexture = device.createTexture({
				size: { width: LUT_STEPS, height: MAX_GPU_CHANNELS },
				format: 'rgba32float',
				usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST,
				label: 'Channel colour tables',
			});
		}
		const lutRow = new Float32Array(LUT_STEPS * 4);
		for (let i = 0; i < prepared.length; i++) {
			const lut = prepared[i].lut;
			for (let s = 0; s < LUT_STEPS; s++) {
				// The shader works in 0..1; the shared table is in 0..255 because
				// the CPU path writes straight into a clamped byte array.
				lutRow[s * 4] = lut[s * 3] / 255;
				lutRow[s * 4 + 1] = lut[s * 3 + 1] / 255;
				lutRow[s * 4 + 2] = lut[s * 3 + 2] / 255;
				lutRow[s * 4 + 3] = 1;
			}
			device.queue.writeTexture(
				{ texture: this.lutTexture, origin: { x: 0, y: i, z: 0 } },
				lutRow,
				{ bytesPerRow: LUT_STEPS * 16, rowsPerImage: 1 },
				{ width: LUT_STEPS, height: 1, depthOrArrayLayers: 1 },
			);
		}

		// --- uniforms ---------------------------------------------------------
		const uniforms = new ArrayBuffer(32 + MAX_GPU_CHANNELS * 16);
		new Uint32Array(uniforms, 0, 1)[0] = prepared.length;
		const floats = new Float32Array(uniforms);
		const [nanR, nanG, nanB] = options.nanColor || [0, 0, 0];
		floats[4] = nanR / 255;
		floats[5] = nanG / 255;
		floats[6] = nanB / 255;
		floats[7] = 1;
		for (let i = 0; i < prepared.length; i++) {
			const base = 8 + i * 4;
			floats[base] = prepared[i].min;
			floats[base + 1] = prepared[i].scale;
			floats[base + 2] = i;
			floats[base + 3] = 0;
		}
		device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

		// --- draw -------------------------------------------------------------
		try {
			const bindGroup = device.createBindGroup({
				layout: this.pipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: this.uniformBuffer } },
					{ binding: 1, resource: this.planeTexture.createView({ dimension: '2d-array' }) },
					{ binding: 2, resource: this.lutTexture.createView() },
				],
			});

			const encoder = device.createCommandEncoder({ label: 'Channel composite' });
			const pass = encoder.beginRenderPass({
				colorAttachments: [{
					view: this.context.getCurrentTexture().createView(),
					loadOp: 'clear',
					storeOp: 'store',
					clearValue: { r: 0, g: 0, b: 0, a: 1 },
				}],
			});
			pass.setPipeline(this.pipeline);
			pass.setBindGroup(0, bindGroup);
			pass.draw(3);
			pass.end();
			device.queue.submit([encoder.finish()]);
		} catch (error) {
			this.logger(`[Channels] WebGPU composite failed, using the CPU compositor: ${error}`);
			return null;
		}

		return this.canvas;
	}

	dispose(): void {
		this.planeTexture?.destroy?.();
		this.lutTexture?.destroy?.();
		this.uniformBuffer?.destroy?.();
		this.device?.destroy?.();
		this.device = null;
		this.context = null;
		this.canvas = null;
		this.pipeline = null;
		this.uniformBuffer = null;
		this.planeTexture = null;
		this.lutTexture = null;
		this.planeKey = '';
	}
}
