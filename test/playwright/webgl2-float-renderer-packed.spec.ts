import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import path from 'path';

// Three-channel images are uploaded as a one-channel texture three texels wide
// per pixel, because the GPU expands RGB to RGBA during an ordinary upload.
// The packed layout must draw exactly what the RGB texture draws. The RGB path
// is forced by reporting a MAX_TEXTURE_SIZE too small for the packed width
// (but large enough for the image), which is the renderer's own fallback rule.
test('packed RGB textures render identically to RGB textures', async ({ page }) => {
	const bundle = buildSync({
		entryPoints: [path.join(__dirname, '..', '..', 'media', 'modules', 'webgl2-float-renderer.ts')],
		bundle: true,
		write: false,
		format: 'iife',
		globalName: 'FloatRendererTest',
		platform: 'browser',
		target: 'chrome100',
	}).outputFiles[0].text;
	await page.addScriptTag({ content: bundle });
	const results = await page.evaluate(() => {
		const Renderer = (window as any).FloatRendererTest.WebGL2FloatRenderer;
		const width = 37;
		const height = 23;
		const pixels = width * height;
		const make = (Carrier: any, scale: number) => {
			const data = new Carrier(pixels * 3);
			for (let i = 0; i < data.length; i++) { data[i] = ((i * 37) % 251) * scale; }
			return data;
		};
		const floats = make(Float32Array, 0.01);
		floats[5] = NaN;
		floats[3 * 40 + 1] = Infinity;
		const cases = [
			{ name: 'rgb8', data: make(Uint8Array, 1), isFloat: false, typeMax: 255, min: 0, max: 250 },
			{ name: 'rgb16', data: make(Uint16Array, 257), isFloat: false, typeMax: 65535, min: 0, max: 64250 },
			{ name: 'rgb32f', data: floats, isFloat: true, typeMax: 1, min: 0, max: 2.5 },
		];
		const proto = WebGL2RenderingContext.prototype as any;
		const original = proto.getParameter;
		const draw = (params: any, forceRgb: boolean) => {
			proto.getParameter = function (this: WebGL2RenderingContext, name: number) {
				return forceRgb && name === this.MAX_TEXTURE_SIZE ? width * 2 : original.call(this, name);
			};
			try {
				const renderer = new Renderer();
				const canvas = document.createElement('canvas');
				if (!renderer.render(canvas, params)) { throw new Error(`render failed for ${params.label}`); }
				const copy = document.createElement('canvas');
				copy.width = width; copy.height = height;
				const context = copy.getContext('2d')!;
				context.drawImage(canvas, 0, 0);
				return { packed: renderer.texturePacked, pixels: Array.from(context.getImageData(0, 0, width, height).data) };
			} finally {
				proto.getParameter = original;
			}
		};
		const output: { label: string; packed: boolean; rgbPacked: boolean; differences: number }[] = [];
		for (const item of cases) {
			for (const rgbAs24BitGrayscale of [false, true]) {
				for (const flipY of [false, true]) {
					const params = {
						label: `${item.name} rgb24=${rgbAs24BitGrayscale} flip=${flipY}`,
						data: item.data, width, height, channels: 3, isFloat: item.isFloat,
						min: item.min, max: item.max, typeMax: item.typeMax, flipY,
						nanColor: { r: 255, g: 0, b: 255 },
						settings: {
							normalization: { min: item.min, max: item.max, autoNormalize: false, gammaMode: false },
							gamma: { in: 1, out: 1 }, brightness: { offset: 0 }, rgbAs24BitGrayscale,
							displayColormap: 'none',
						},
					};
					const packed = draw(params, false);
					const rgb = draw(params, true);
					let differences = 0;
					for (let i = 0; i < packed.pixels.length; i++) { if (packed.pixels[i] !== rgb.pixels[i]) { differences++; } }
					output.push({ label: params.label, packed: packed.packed, rgbPacked: rgb.packed, differences });
				}
			}
		}
		return output;
	});
	for (const result of results) {
		expect(result.packed, `${result.label}: packed path taken`).toBe(true);
		expect(result.rgbPacked, `${result.label}: RGB fallback taken`).toBe(false);
		expect(result.differences, `${result.label}: differing bytes`).toBe(0);
	}
});
