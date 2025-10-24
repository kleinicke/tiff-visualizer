/**
 * Colormap Converter Module
 * Converts colormap images to float values based on selected colormap
 */

export class ColormapConverter {
	constructor() {
		// Define common colormaps with 256 color entries (RGB values 0-255)
		this.colormaps = this.initializeColormaps();
	}

	/**
	 * Initialize colormap lookup tables
	 * Each colormap is an array of 256 [r, g, b] values
	 */
	initializeColormaps() {
		return {
			viridis: this.generateViridis(),
			plasma: this.generatePlasma(),
			inferno: this.generateInferno(),
			magma: this.generateMagma(),
			jet: this.generateJet(),
			hot: this.generateHot(),
			cool: this.generateCool(),
			turbo: this.generateTurbo(),
			gray: this.generateGray()
		};
	}

	/**
	 * Convert a colormap image to float values
	 * @param {ImageData} imageData - The source image data
	 * @param {string} colormapName - Name of the colormap to use
	 * @param {number} minValue - Minimum value to map to
	 * @param {number} maxValue - Maximum value to map to
	 * @param {boolean} inverted - Whether to invert the mapping
	 * @param {boolean} logarithmic - Whether to use logarithmic mapping
	 * @returns {Float32Array} Array of float values
	 */
	convertToFloat(imageData, colormapName, minValue, maxValue, inverted = false, logarithmic = false) {
		const colormap = this.colormaps[colormapName];
		if (!colormap) {
			throw new Error(`Unknown colormap: ${colormapName}`);
		}

		const width = imageData.width;
		const height = imageData.height;
		const data = imageData.data;
		const floatData = new Float32Array(width * height);

		// For each pixel, find the closest colormap entry
		for (let i = 0; i < width * height; i++) {
			const pixelOffset = i * 4;
			const r = data[pixelOffset];
			const g = data[pixelOffset + 1];
			const b = data[pixelOffset + 2];

			// Find closest colormap index
			let index = this.findClosestColormapIndex(r, g, b, colormap);

			// Invert index if requested (255 -> 0, 0 -> 255)
			if (inverted) {
				index = 255 - index;
			}

			// Map index (0-255) to normalized value (0-1)
			const normalizedValue = index / 255.0;

			// Apply mapping (linear or logarithmic)
			let finalValue;
			if (logarithmic) {
				// Logarithmic mapping
				// We need to handle the case where minValue or maxValue could be negative or zero
				// For logarithmic mapping to work, we need positive values
				const useLogMin = Math.abs(minValue) < 1e-10 ? 1e-10 : Math.abs(minValue);
				const useLogMax = Math.abs(maxValue) < 1e-10 ? 1e-10 : Math.abs(maxValue);

				// Map from normalized (0-1) to logarithmic space
				const logMin = Math.log10(useLogMin);
				const logMax = Math.log10(useLogMax);
				const logValue = logMin + normalizedValue * (logMax - logMin);
				finalValue = Math.pow(10, logValue);

				// Restore sign if original values were negative
				if (minValue < 0 && maxValue < 0) {
					finalValue = -finalValue;
				} else if (minValue < 0) {
					// Mixed sign range - interpolate sign
					finalValue = minValue + normalizedValue * (maxValue - minValue);
				}
			} else {
				// Linear mapping
				finalValue = minValue + normalizedValue * (maxValue - minValue);
			}

			floatData[i] = finalValue;
		}

		return floatData;
	}

	/**
	 * Find the closest colormap index for a given RGB color
	 * @param {number} r - Red value (0-255)
	 * @param {number} g - Green value (0-255)
	 * @param {number} b - Blue value (0-255)
	 * @param {Array} colormap - Colormap lookup table
	 * @returns {number} Index of closest color (0-255)
	 */
	findClosestColormapIndex(r, g, b, colormap) {
		let minDistance = Infinity;
		let closestIndex = 0;

		for (let i = 0; i < colormap.length; i++) {
			const [cr, cg, cb] = colormap[i];
			// Euclidean distance in RGB space
			const distance = Math.sqrt(
				(r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
			);

			if (distance < minDistance) {
				minDistance = distance;
				closestIndex = i;
			}
		}

		return closestIndex;
	}

	// Colormap generation functions
	// Each generates 256 RGB values

	generateGray() {
		const colormap = [];
		for (let i = 0; i < 256; i++) {
			colormap.push([i, i, i]);
		}
		return colormap;
	}

	generateJet() {
		// Classic jet colormap: blue -> cyan -> green -> yellow -> red
		const colormap = [];
		for (let i = 0; i < 256; i++) {
			const value = i / 255.0;
			let r, g, b;

			if (value < 0.125) {
				r = 0;
				g = 0;
				b = 0.5 + value * 4;
			} else if (value < 0.375) {
				r = 0;
				g = (value - 0.125) * 4;
				b = 1;
			} else if (value < 0.625) {
				r = (value - 0.375) * 4;
				g = 1;
				b = 1 - (value - 0.375) * 4;
			} else if (value < 0.875) {
				r = 1;
				g = 1 - (value - 0.625) * 4;
				b = 0;
			} else {
				r = 1 - (value - 0.875) * 4;
				g = 0;
				b = 0;
			}

			colormap.push([
				Math.round(r * 255),
				Math.round(g * 255),
				Math.round(b * 255)
			]);
		}
		return colormap;
	}

	generateHot() {
		// Hot colormap: black -> red -> orange -> yellow -> white
		const colormap = [];
		for (let i = 0; i < 256; i++) {
			const value = i / 255.0;
			let r, g, b;

			if (value < 0.33) {
				r = value / 0.33;
				g = 0;
				b = 0;
			} else if (value < 0.66) {
				r = 1;
				g = (value - 0.33) / 0.33;
				b = 0;
			} else {
				r = 1;
				g = 1;
				b = (value - 0.66) / 0.34;
			}

			colormap.push([
				Math.round(r * 255),
				Math.round(g * 255),
				Math.round(b * 255)
			]);
		}
		return colormap;
	}

	generateCool() {
		// Cool colormap: cyan -> magenta
		const colormap = [];
		for (let i = 0; i < 256; i++) {
			const value = i / 255.0;
			colormap.push([
				Math.round(value * 255),
				Math.round((1 - value) * 255),
				255
			]);
		}
		return colormap;
	}

	// Viridis colormap (perceptually uniform)
	generateViridis() {
		// Simplified viridis - in production, use actual lookup table
		const colormap = [];
		const viridisData = [
			[0.267004, 0.004874, 0.329415],
			[0.282623, 0.140926, 0.457517],
			[0.253935, 0.265254, 0.529983],
			[0.206756, 0.371758, 0.553117],
			[0.163625, 0.471133, 0.558148],
			[0.127568, 0.566949, 0.550556],
			[0.134692, 0.658636, 0.517649],
			[0.266941, 0.748751, 0.440573],
			[0.477504, 0.821444, 0.318195],
			[0.741388, 0.873449, 0.149561],
			[0.993248, 0.906157, 0.143936]
		];

		// Interpolate to 256 colors
		for (let i = 0; i < 256; i++) {
			const pos = (i / 255.0) * (viridisData.length - 1);
			const idx = Math.floor(pos);
			const frac = pos - idx;

			const color1 = viridisData[Math.min(idx, viridisData.length - 1)];
			const color2 = viridisData[Math.min(idx + 1, viridisData.length - 1)];

			colormap.push([
				Math.round(((color1[0] * (1 - frac) + color2[0] * frac) * 255)),
				Math.round(((color1[1] * (1 - frac) + color2[1] * frac) * 255)),
				Math.round(((color1[2] * (1 - frac) + color2[2] * frac) * 255))
			]);
		}
		return colormap;
	}

	// Plasma colormap (perceptually uniform)
	generatePlasma() {
		const colormap = [];
		const plasmaData = [
			[0.050383, 0.029803, 0.527975],
			[0.287076, 0.010384, 0.627010],
			[0.476230, 0.011158, 0.657865],
			[0.647257, 0.125289, 0.593542],
			[0.785914, 0.274290, 0.472908],
			[0.877850, 0.439704, 0.345067],
			[0.936213, 0.605205, 0.231465],
			[0.972355, 0.771125, 0.155626],
			[0.994617, 0.938336, 0.165141],
			[0.987053, 0.991438, 0.749504]
		];

		for (let i = 0; i < 256; i++) {
			const pos = (i / 255.0) * (plasmaData.length - 1);
			const idx = Math.floor(pos);
			const frac = pos - idx;

			const color1 = plasmaData[Math.min(idx, plasmaData.length - 1)];
			const color2 = plasmaData[Math.min(idx + 1, plasmaData.length - 1)];

			colormap.push([
				Math.round(((color1[0] * (1 - frac) + color2[0] * frac) * 255)),
				Math.round(((color1[1] * (1 - frac) + color2[1] * frac) * 255)),
				Math.round(((color1[2] * (1 - frac) + color2[2] * frac) * 255))
			]);
		}
		return colormap;
	}

	// Inferno colormap (perceptually uniform)
	generateInferno() {
		const colormap = [];
		const infernoData = [
			[0.001462, 0.000466, 0.013866],
			[0.094329, 0.042852, 0.225802],
			[0.239903, 0.067979, 0.343397],
			[0.412470, 0.102815, 0.380271],
			[0.591217, 0.155410, 0.347824],
			[0.758643, 0.237267, 0.275196],
			[0.889650, 0.360829, 0.210001],
			[0.969788, 0.514135, 0.186861],
			[0.994738, 0.683489, 0.240902],
			[0.988362, 0.998364, 0.644924]
		];

		for (let i = 0; i < 256; i++) {
			const pos = (i / 255.0) * (infernoData.length - 1);
			const idx = Math.floor(pos);
			const frac = pos - idx;

			const color1 = infernoData[Math.min(idx, infernoData.length - 1)];
			const color2 = infernoData[Math.min(idx + 1, infernoData.length - 1)];

			colormap.push([
				Math.round(((color1[0] * (1 - frac) + color2[0] * frac) * 255)),
				Math.round(((color1[1] * (1 - frac) + color2[1] * frac) * 255)),
				Math.round(((color1[2] * (1 - frac) + color2[2] * frac) * 255))
			]);
		}
		return colormap;
	}

	// Magma colormap (perceptually uniform)
	generateMagma() {
		const colormap = [];
		const magmaData = [
			[0.001462, 0.000466, 0.013866],
			[0.091904, 0.051667, 0.200303],
			[0.234547, 0.090739, 0.348341],
			[0.408198, 0.131574, 0.416555],
			[0.595732, 0.180653, 0.421399],
			[0.776405, 0.266630, 0.373397],
			[0.924010, 0.406370, 0.330720],
			[0.987622, 0.583041, 0.382914],
			[0.996212, 0.771453, 0.543135],
			[0.987053, 0.991438, 0.749504]
		];

		for (let i = 0; i < 256; i++) {
			const pos = (i / 255.0) * (magmaData.length - 1);
			const idx = Math.floor(pos);
			const frac = pos - idx;

			const color1 = magmaData[Math.min(idx, magmaData.length - 1)];
			const color2 = magmaData[Math.min(idx + 1, magmaData.length - 1)];

			colormap.push([
				Math.round(((color1[0] * (1 - frac) + color2[0] * frac) * 255)),
				Math.round(((color1[1] * (1 - frac) + color2[1] * frac) * 255)),
				Math.round(((color1[2] * (1 - frac) + color2[2] * frac) * 255))
			]);
		}
		return colormap;
	}

	// Turbo colormap (improved rainbow)
	generateTurbo() {
		const colormap = [];
		const turboData = [
			[0.18995, 0.07176, 0.23217],
			[0.25107, 0.25237, 0.63374],
			[0.19659, 0.47276, 0.82300],
			[0.12756, 0.66813, 0.82565],
			[0.13094, 0.82030, 0.65899],
			[0.37408, 0.92478, 0.41642],
			[0.66987, 0.95987, 0.19659],
			[0.90842, 0.87640, 0.10899],
			[0.98999, 0.64450, 0.03932],
			[0.93702, 0.25023, 0.01583]
		];

		for (let i = 0; i < 256; i++) {
			const pos = (i / 255.0) * (turboData.length - 1);
			const idx = Math.floor(pos);
			const frac = pos - idx;

			const color1 = turboData[Math.min(idx, turboData.length - 1)];
			const color2 = turboData[Math.min(idx + 1, turboData.length - 1)];

			colormap.push([
				Math.round(((color1[0] * (1 - frac) + color2[0] * frac) * 255)),
				Math.round(((color1[1] * (1 - frac) + color2[1] * frac) * 255)),
				Math.round(((color1[2] * (1 - frac) + color2[2] * frac) * 255))
			]);
		}
		return colormap;
	}
}
