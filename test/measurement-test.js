/**
 * Measurement subsystem tests.
 *
 * These run against the unbundled ESM output in out/media/modules/measure, so
 * they exercise exactly the code the webview loads. Every assertion checks a
 * number against an independently known answer (an analytic area, a synthetic
 * image with a planted object, a round trip through a file format) rather than
 * against a previously recorded output, because the whole point of this
 * subsystem is that the numbers are right.
 *
 * Run with: node test/measurement-test.js  (after npm run compile)
 */

const assert = require('assert');
const path = require('path');

const OUT = path.join(__dirname, '..', 'out', 'media', 'modules', 'measure');
const moduleUrl = name => require('url').pathToFileURL(path.join(OUT, name)).href;

let passed = 0;
let failed = 0;

function test(name, fn) {
	try {
		fn();
		passed++;
		console.log(`  ✅ ${name}`);
	} catch (error) {
		failed++;
		console.log(`  ❌ ${name}`);
		console.log(`     ${error.message}`);
	}
}

/** Assert two numbers agree to a relative tolerance. */
function close(actual, expected, tolerance, label) {
	const scale = Math.max(1e-12, Math.abs(expected));
	const relative = Math.abs(actual - expected) / scale;
	assert.ok(
		relative <= tolerance,
		`${label}: expected ~${expected}, got ${actual} (relative error ${relative.toFixed(4)} > ${tolerance})`,
	);
}

/** A single-channel float image with a filled disc of the given radius. */
function discImage(width, height, cx, cy, radius, inside = 200, outside = 20) {
	const data = new Float32Array(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const dx = x - cx;
			const dy = y - cy;
			data[y * width + x] = (dx * dx + dy * dy <= radius * radius) ? inside : outside;
		}
	}
	return { width, height, channels: 1, data, isFloat: true, typeMax: 255 };
}

async function main() {
	const geometry = await import(moduleUrl('geometry.js'));
	const statistics = await import(moduleUrl('statistics.js'));
	const threshold = await import(moduleUrl('threshold.js'));
	const particles = await import(moduleUrl('particles.js'));
	const segmentation = await import(moduleUrl('segmentation.js'));
	const imagej = await import(moduleUrl('imagej-roi.js'));
	const expression = await import(moduleUrl('expression.js'));
	const roiIo = await import(moduleUrl('roi-io.js'));
	const calibration = await import(moduleUrl('calibration.js'));

	const PIXELS = { pixelWidth: 1, pixelHeight: 1, unit: 'px', origin: 'none' };

	console.log('\n📐 Geometry');

	test('rectangle rasterises to exactly its pixel count', () => {
		const roi = { id: 'a', name: 'a', kind: 'rect', x: 10, y: 20, width: 30, height: 40 };
		const mask = geometry.rasterizeRoi(roi, 200, 200);
		assert.strictEqual(mask.count, 30 * 40);
		assert.strictEqual(mask.x, 10);
		assert.strictEqual(mask.y, 20);
	});

	test('rectangle clips to the image instead of overflowing', () => {
		const roi = { id: 'a', name: 'a', kind: 'rect', x: 90, y: 90, width: 50, height: 50 };
		const mask = geometry.rasterizeRoi(roi, 100, 100);
		assert.strictEqual(mask.count, 10 * 10);
	});

	test('ellipse area approaches pi*a*b', () => {
		const roi = { id: 'a', name: 'a', kind: 'ellipse', x: 0, y: 0, width: 100, height: 60 };
		const mask = geometry.rasterizeRoi(roi, 200, 200);
		close(mask.count, Math.PI * 50 * 30, 0.01, 'ellipse area');
	});

	test('polygon area matches the shoelace formula', () => {
		// A 40x40 square expressed as a polygon.
		const points = [10, 10, 50, 10, 50, 50, 10, 50];
		const mask = geometry.rasterizePolygon(points, 100, 100);
		close(mask.count, geometry.polygonArea(points), 0.05, 'polygon area');
	});

	test('adjacent polygons do not double-count their shared edge', () => {
		// The half-open scanline rule is what guarantees this; without it a
		// shared boundary lands in both regions and every area is inflated.
		const left = geometry.rasterizePolygon([0, 0, 20, 0, 20, 20, 0, 20], 100, 100);
		const right = geometry.rasterizePolygon([20, 0, 40, 0, 40, 20, 20, 20], 100, 100);
		let overlap = 0;
		for (let y = 0; y < 20; y++) {
			for (let x = 0; x < 40; x++) {
				const inLeft = x >= left.x && x < left.x + left.width && y >= left.y && y < left.y + left.height
					&& left.mask[(y - left.y) * left.width + (x - left.x)];
				const inRight = x >= right.x && x < right.x + right.width && y >= right.y && y < right.y + right.height
					&& right.mask[(y - right.y) * right.width + (x - right.x)];
				if (inLeft && inRight) { overlap++; }
			}
		}
		assert.strictEqual(overlap, 0, 'shared edge was counted twice');
	});

	test('convex hull of a square keeps four corners', () => {
		const points = [0, 0, 5, 0, 10, 0, 10, 10, 5, 5, 0, 10, 3, 1];
		const hull = geometry.convexHull(points);
		assert.strictEqual(hull.length / 2, 4);
	});

	test('Feret diameter of a square is its diagonal', () => {
		const points = [0, 0, 10, 0, 10, 10, 0, 10];
		const feret = geometry.feretDiameters(points);
		close(feret.feret, Math.hypot(10, 10), 0.001, 'max Feret');
		close(feret.minFeret, 10, 0.001, 'min Feret');
	});

	test('Feret honours anisotropic calibration', () => {
		const points = [0, 0, 10, 0, 10, 10, 0, 10];
		// 2 units per pixel in x makes the square a 20x10 rectangle.
		const feret = geometry.feretDiameters(points, 2, 1);
		close(feret.feret, Math.hypot(20, 10), 0.001, 'calibrated max Feret');
	});

	test('fitted ellipse recovers the axes of a known ellipse', () => {
		const roi = { id: 'a', name: 'a', kind: 'ellipse', x: 0, y: 0, width: 120, height: 40 };
		const mask = geometry.rasterizeRoi(roi, 200, 200);
		const fit = geometry.fitEllipse(mask);
		close(fit.major, 120, 0.03, 'major axis');
		close(fit.minor, 40, 0.05, 'minor axis');
		close(fit.centroidX, 60, 0.02, 'centroid x');
	});

	test('traced perimeter of a disc is near 2*pi*r', () => {
		const roi = { id: 'a', name: 'a', kind: 'ellipse', x: 0, y: 0, width: 101, height: 101 };
		const mask = geometry.rasterizeRoi(roi, 200, 200);
		// The corrected chain-code estimator should land within a few percent;
		// an uncorrected staircase count would be ~27% high.
		close(geometry.maskPerimeter(mask), 2 * Math.PI * 50.5, 0.06, 'disc perimeter');
	});

	test('freehand simplification keeps the shape but drops redundant points', () => {
		const dense = [];
		for (let i = 0; i <= 100; i++) { dense.push(i, 0); }
		const simplified = geometry.simplifyPolyline(dense, 0.5);
		assert.strictEqual(simplified.length / 2, 2, 'a straight line needs two points');
	});

	console.log('\n📊 Statistics');

	test('mean and stddev of a uniform region are exact', () => {
		const source = discImage(64, 64, 32, 32, 100, 42, 42);
		const roi = { id: 'a', name: 'a', kind: 'rect', x: 0, y: 0, width: 64, height: 64 };
		const row = statistics.measureRoi(roi, source, PIXELS, 0);
		close(row.mean, 42, 1e-9, 'mean');
		assert.ok(row.stdDev < 1e-6, `stddev should be 0, got ${row.stdDev}`);
		assert.strictEqual(row.min, 42);
		assert.strictEqual(row.max, 42);
	});

	test('NaN pixels are excluded from statistics, not treated as zero', () => {
		const source = discImage(10, 10, 5, 5, 100, 10, 10);
		source.data[0] = NaN;
		source.data[1] = Infinity;
		const roi = { id: 'a', name: 'a', kind: 'rect', x: 0, y: 0, width: 10, height: 10 };
		const row = statistics.measureRoi(roi, source, PIXELS, 0);
		// Coercing NaN to 0 would drag the mean to 9.8.
		close(row.mean, 10, 1e-9, 'mean with non-finite pixels');
		assert.strictEqual(row.nonFiniteCount, 2);
		assert.strictEqual(row.pixelCount, 100, 'area still counts every pixel in the ROI');
	});

	test('calibration scales area but never intensity', () => {
		const source = discImage(64, 64, 32, 32, 100, 7, 7);
		const roi = { id: 'a', name: 'a', kind: 'rect', x: 0, y: 0, width: 10, height: 10 };
		const micro = { pixelWidth: 0.5, pixelHeight: 0.25, unit: 'µm', origin: 'manual' };
		const row = statistics.measureRoi(roi, source, micro, 0);
		close(row.area, 100 * 0.5 * 0.25, 1e-9, 'calibrated area');
		close(row.mean, 7, 1e-9, 'mean must stay in raw units');
	});

	test('circularity of a disc is near 1 and of a thin rectangle is small', () => {
		const disc = geometry.rasterizeRoi(
			{ id: 'a', name: 'a', kind: 'ellipse', x: 0, y: 0, width: 81, height: 81 }, 100, 100);
		const source = discImage(100, 100, 50, 50, 40);
		const discRow = statistics.measureRoi(
			{ id: 'a', name: 'a', kind: 'ellipse', x: 0, y: 0, width: 81, height: 81 }, source, PIXELS, 0);
		assert.ok(discRow.circularity > 0.9, `disc circularity ${discRow.circularity} should exceed 0.9`);
		void disc;

		const thin = statistics.measureRoi(
			{ id: 'b', name: 'b', kind: 'rect', x: 0, y: 0, width: 80, height: 4 }, source, PIXELS, 0);
		assert.ok(thin.circularity < 0.4, `thin rect circularity ${thin.circularity} should be well below 1`);
	});

	test('line profile reports the values actually crossed', () => {
		const width = 20;
		const source = { width, height: 3, channels: 1, isFloat: true, typeMax: 255, data: new Float32Array(width * 3) };
		for (let x = 0; x < width; x++) { source.data[width + x] = x; }
		const roi = { id: 'a', name: 'a', kind: 'line', points: [0, 1, width - 1, 1], lineWidth: 1 };
		const profile = statistics.sampleLineProfile(source, roi, 0);
		close(profile.value[0], 0, 1e-6, 'profile start');
		close(profile.value[profile.value.length - 1], width - 1, 1e-6, 'profile end');
	});

	test('line length is calibrated', () => {
		const source = discImage(50, 50, 25, 25, 10);
		const roi = { id: 'a', name: 'a', kind: 'line', points: [0, 0, 30, 40] };
		const row = statistics.measureRoi(roi, source, { pixelWidth: 2, pixelHeight: 2, unit: 'µm', origin: 'manual' }, 0);
		close(row.length, 100, 1e-9, 'calibrated line length');
	});

	console.log('\n🎚️  Thresholding');

	test('Otsu separates a clean bimodal image at the valley', () => {
		const source = discImage(128, 128, 64, 64, 40, 200, 20);
		const histogram = threshold.buildHistogram(source.data);
		const bin = threshold.autoThresholdBin(histogram.counts, 'otsu');
		const value = threshold.thresholdValueFromBin(histogram, bin);
		assert.ok(value > 20 && value <= 200, `Otsu threshold ${value} should fall between the two modes`);
		// The cut must actually select the disc and nothing else.
		const mask = threshold.globalThresholdMask(source.data, value, Infinity);
		let selected = 0;
		for (let i = 0; i < mask.length; i++) { if (mask[i]) { selected++; } }
		close(selected, Math.PI * 1600, 0.02, 'pixels selected by the Otsu cut');
	});

	test('every auto-threshold method returns a value inside the data range', () => {
		const source = discImage(96, 96, 48, 48, 25, 180, 30);
		const histogram = threshold.buildHistogram(source.data);
		for (const method of threshold.THRESHOLD_METHODS) {
			const bin = threshold.autoThresholdBin(histogram.counts, method.id);
			// -1 is the documented "no threshold found" answer and is acceptable
			// for the methods that require a genuinely bimodal histogram.
			if (bin < 0) { continue; }
			assert.ok(bin >= 0 && bin < 256, `${method.id} returned bin ${bin}`);
			const value = threshold.binToValue(histogram, bin);
			assert.ok(
				value >= histogram.min && value <= histogram.max,
				`${method.id} produced ${value}, outside [${histogram.min}, ${histogram.max}]`,
			);
		}
	});

	test('subsampling the histogram does not move the chosen threshold', () => {
		const source = discImage(256, 256, 128, 128, 70, 210, 15);
		const full = threshold.buildHistogram(source.data, 1);
		const sampled = threshold.buildHistogram(source.data, 7);
		const a = threshold.autoThresholdBin(full.counts, 'otsu');
		const b = threshold.autoThresholdBin(sampled.counts, 'otsu');
		assert.ok(Math.abs(a - b) <= 1, `threshold moved from bin ${a} to ${b} under subsampling`);
	});

	test('stability curve finds a plateau on a clean image', () => {
		const source = discImage(128, 128, 64, 64, 30, 200, 20);
		const histogram = threshold.buildHistogram(source.data);
		const curve = threshold.computeStabilityCurve(source.data, 128, 128, histogram, { samples: 48 });
		assert.ok(curve.points.length === 48);
		assert.ok(curve.plateauWidth > 3, `expected a broad plateau, got width ${curve.plateauWidth}`);
		const suggested = threshold.thresholdValueFromBin(histogram, curve.suggestedBin);
		assert.ok(suggested > 20 && suggested < 200, `suggested threshold ${suggested} is outside the gap`);
	});

	test('a global method applied per window handles patchy illumination', () => {
		// Two halves lit differently, with one object in each. The left object is
		// *darker* than the right half's background, so no single global cut can
		// catch both — this is the situation per-window thresholding exists for.
		const width = 128;
		const height = 128;
		const data = new Float32Array(width * height);
		let seed = 1;
		const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 4; };
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) { data[y * width + x] = (x < 64 ? 20 : 120) + noise(); }
		}
		const stamp = (cx, cy, value) => {
			for (let y = cy - 9; y <= cy + 9; y++) {
				for (let x = cx - 9; x <= cx + 9; x++) {
					if ((x - cx) ** 2 + (y - cy) ** 2 <= 81) { data[y * width + x] = value + noise(); }
				}
			}
		};
		stamp(32, 64, 80);
		stamp(96, 64, 180);

		const expected = Math.PI * 81;
		const looksLikeObject = particle => Math.abs(particle.area - expected) / expected < 0.15;

		const histogram = threshold.buildHistogram(data);
		const globalBin = threshold.autoThresholdBin(histogram.counts, 'otsu');
		const globalMask = threshold.globalThresholdMask(
			data, threshold.thresholdValueFromBin(histogram, globalBin), Infinity);
		const globalFound = particles.analyzeParticles(globalMask, width, height, { minArea: 30 }, {});
		assert.ok(globalFound.particles.filter(looksLikeObject).length < 2,
			'a global cut was expected to fail here, so the comparison is meaningful');

		const localMask = threshold.localAutoThresholdMask(data, width, height, {
			method: 'otsu', radius: 16, darkBackground: true,
		});
		const localFound = particles.analyzeParticles(localMask, width, height, { minArea: 30 }, {});
		const objects = localFound.particles.filter(looksLikeObject);
		assert.strictEqual(objects.length, 2,
			`per-window Otsu should recover both objects, found ${objects.length} of ${localFound.particles.length} components`);
	});

	test('per-window thresholding leaves uniform background alone', () => {
		// The contrast guard: a window holding nothing but flat background has no
		// split to make, and every method above would otherwise invent one.
		const width = 96;
		const height = 96;
		const data = new Float32Array(width * height);
		let seed = 7;
		const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 3; };
		for (let i = 0; i < data.length; i++) { data[i] = 40 + noise(); }
		for (let y = 40; y < 56; y++) {
			for (let x = 40; x < 56; x++) { data[y * width + x] = 200; }
		}

		const mask = threshold.localAutoThresholdMask(data, width, height, {
			method: 'otsu', radius: 12, darkBackground: true,
		});
		let selected = 0;
		for (let i = 0; i < mask.length; i++) { if (mask[i]) { selected++; } }
		// The planted square is 256 px; anything far above that means background
		// windows were split.
		assert.ok(selected < 700, `background was carved up: ${selected} px selected for a 256 px object`);
		assert.ok(selected >= 200, `the object itself was lost: only ${selected} px selected`);
	});

	test('every global method survives being applied per window', () => {
		const source = discImage(96, 96, 48, 48, 20, 190, 25);
		for (const method of threshold.THRESHOLD_METHODS) {
			const mask = threshold.localAutoThresholdMask(source.data, 96, 96, {
				method: method.id, radius: 12, darkBackground: true,
			});
			assert.strictEqual(mask.length, 96 * 96, `${method.id} returned a wrong-sized mask`);
			let selected = 0;
			for (let i = 0; i < mask.length; i++) { if (mask[i]) { selected++; } }
			// A method that selects everything or nothing everywhere would mean the
			// per-window path silently degenerated.
			assert.ok(selected < mask.length, `${method.id} selected the entire image`);
		}
	});

	test('local adaptive thresholding beats a global one under a gradient', () => {
		// Background ramps from 0 to 150 across the frame; two objects sit 60
		// above their local background. No single global value can catch both.
		const width = 128;
		const height = 128;
		const data = new Float32Array(width * height);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				data[y * width + x] = (x / width) * 150;
			}
		}
		const stamp = (cx, cy) => {
			for (let y = cy - 8; y <= cy + 8; y++) {
				for (let x = cx - 8; x <= cx + 8; x++) {
					if ((x - cx) ** 2 + (y - cy) ** 2 <= 64) { data[y * width + x] += 60; }
				}
			}
		};
		stamp(24, 64);
		stamp(104, 64);

		const histogram = threshold.buildHistogram(data);
		const globalBin = threshold.autoThresholdBin(histogram.counts, 'otsu');
		const globalMask = threshold.globalThresholdMask(data, threshold.thresholdValueFromBin(histogram, globalBin), Infinity);
		const globalObjects = particles.analyzeParticles(globalMask, width, height, { minArea: 20 }, {});

		const localMask = threshold.localThresholdMask(data, width, height, {
			method: 'sauvola', radius: 12, k: 0.25, darkBackground: true,
		});
		const localObjects = particles.analyzeParticles(localMask, width, height, { minArea: 20 }, {});

		assert.strictEqual(localObjects.particles.length, 2,
			`Sauvola should find both objects and nothing else, found ${localObjects.particles.length}`);
		// Both must be the planted discs (~pi*64 px), not one object plus debris.
		for (const particle of localObjects.particles) {
			close(particle.area, Math.PI * 64, 0.05, 'Sauvola object area');
		}
		// The control: a global cut on this ramp swallows the bright half of the
		// background, so at least one "object" is far larger than a planted disc.
		// (It happens to also produce two components, which is why the count
		// alone would not show the failure.)
		const largestGlobal = globalObjects.particles.reduce((a, b) => (a.area > b.area ? a : b));
		assert.ok(largestGlobal.area > Math.PI * 64 * 10,
			'the global threshold was expected to fail on this gradient, so the comparison is meaningful');
	});

	console.log('\n🔬 Particles');

	test('connected components counts planted objects', () => {
		const width = 100;
		const height = 100;
		const mask = new Uint8Array(width * height);
		const stamp = (cx, cy, r) => {
			for (let y = cy - r; y <= cy + r; y++) {
				for (let x = cx - r; x <= cx + r; x++) {
					if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) { mask[y * width + x] = 1; }
				}
			}
		};
		stamp(20, 20, 8);
		stamp(70, 20, 8);
		stamp(20, 70, 8);
		stamp(70, 70, 12);

		const result = particles.labelComponents(mask, width, height, 8);
		assert.strictEqual(result.count, 4);
		const extracted = particles.extractParticles(result);
		assert.strictEqual(extracted.length, 4);
		// The largest planted disc must come out largest.
		const largest = extracted.reduce((a, b) => (a.area > b.area ? a : b));
		close(largest.area, Math.PI * 144, 0.1, 'largest particle area');
	});

	test('size and edge filters drop the right objects', () => {
		const width = 60;
		const height = 60;
		const mask = new Uint8Array(width * height);
		// One large interior blob, one tiny speck, one blob on the border.
		for (let y = 20; y < 40; y++) { for (let x = 20; x < 40; x++) { mask[y * width + x] = 1; } }
		mask[5 * width + 50] = 1;
		for (let y = 0; y < 10; y++) { mask[y * width + 0] = 1; }

		const all = particles.analyzeParticles(mask, width, height, {}, {});
		assert.strictEqual(all.particles.length, 3);

		const filtered = particles.analyzeParticles(mask, width, height, { minArea: 5, excludeEdges: true }, {});
		assert.strictEqual(filtered.particles.length, 1);
		assert.strictEqual(filtered.rejected.tooSmall, 1);
		assert.strictEqual(filtered.rejected.edge, 1);
	});

	test('hole filling closes an interior gap', () => {
		const width = 30;
		const height = 30;
		const mask = new Uint8Array(width * height);
		for (let y = 5; y < 25; y++) { for (let x = 5; x < 25; x++) { mask[y * width + x] = 1; } }
		for (let y = 12; y < 18; y++) { for (let x = 12; x < 18; x++) { mask[y * width + x] = 0; } }
		const filled = particles.fillMaskHoles(mask, width, height);
		let count = 0;
		for (let i = 0; i < filled.length; i++) { if (filled[i]) { count++; } }
		assert.strictEqual(count, 400, 'the 6x6 hole should be filled back in');
	});

	test('distance transform peaks at the centre of a disc', () => {
		const width = 64;
		const height = 64;
		const mask = new Uint8Array(width * height);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				if ((x - 32) ** 2 + (y - 32) ** 2 <= 400) { mask[y * width + x] = 1; }
			}
		}
		const distance = particles.distanceTransform(mask, width, height);
		// Squared distance, so the centre of a radius-20 disc is near 400.
		close(Math.sqrt(distance[32 * width + 32]), 20, 0.1, 'peak distance');
	});

	test('watershed splits two overlapping discs into two objects', () => {
		const width = 120;
		const height = 80;
		const mask = new Uint8Array(width * height);
		const stamp = (cx, cy, r) => {
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) { mask[y * width + x] = 1; }
				}
			}
		};
		stamp(45, 40, 25);
		stamp(75, 40, 25);

		const joined = particles.analyzeParticles(mask, width, height, { minArea: 50 }, {});
		assert.strictEqual(joined.particles.length, 1, 'the two discs overlap, so they start as one object');

		const split = particles.analyzeParticles(mask, width, height, { minArea: 50 }, { watershed: true });
		assert.strictEqual(split.particles.length, 2, `watershed produced ${split.particles.length} objects`);
	});

	test('intensity maxima split cells that touch without pinching', () => {
		// Two bright nuclei sharing a flat border: the union is a single rounded
		// rectangle, so a distance-transform watershed sees one object. Only the
		// two intensity peaks distinguish them — this is the case ImageJ solves
		// with Find Maxima plus an AND in the Image Calculator.
		const width = 120;
		const height = 60;
		const plane = new Float32Array(width * height).fill(10);
		const mask = new Uint8Array(width * height);
		for (let y = 10; y < 50; y++) {
			for (let x = 10; x < 110; x++) {
				mask[y * width + x] = 1;
				// Two Gaussian-ish peaks at x = 35 and x = 85.
				const a = 120 * Math.exp(-(((x - 35) ** 2) / 200 + ((y - 30) ** 2) / 200));
				const b = 120 * Math.exp(-(((x - 85) ** 2) / 200 + ((y - 30) ** 2) / 200));
				plane[y * width + x] = 10 + a + b;
			}
		}

		const byShape = particles.analyzeParticles(mask, width, height, { minArea: 50 }, { split: 'shape' });
		assert.strictEqual(byShape.particles.length, 1,
			'a flat-bordered pair has no shape saddle, so this control must find one object');

		const byIntensity = particles.analyzeParticles(mask, width, height, { minArea: 50 }, {
			split: 'intensity', prominence: 30, plane,
		});
		assert.strictEqual(byIntensity.particles.length, 2,
			`intensity maxima should separate the two nuclei, got ${byIntensity.particles.length}`);
	});

	test('prominence controls how many centres are accepted', () => {
		const width = 100;
		const height = 40;
		const plane = new Float32Array(width * height).fill(0);
		const mask = new Uint8Array(width * height).fill(1);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				// Three peaks: two tall, one lesser bump between them. The bump's
				// *prominence* is its height above the saddle joining it to a
				// taller peak — about 21 here — not its absolute height of 40.
				// Confusing the two is the usual reason a prominence value
				// behaves unexpectedly.
				const a = 100 * Math.exp(-((x - 20) ** 2) / 120);
				const b = 100 * Math.exp(-((x - 80) ** 2) / 120);
				const c = 40 * Math.exp(-((x - 50) ** 2) / 120);
				plane[y * width + x] = a + b + c;
			}
		}

		const lenient = particles.countIntensityMaxima(plane, mask, width, height, 10);
		const strict = particles.countIntensityMaxima(plane, mask, width, height, 40);
		assert.strictEqual(lenient, 3, `a prominence below the bump's should keep it, got ${lenient}`);
		assert.strictEqual(strict, 2, `a prominence above it should keep only the two real peaks, got ${strict}`);
		// Monotone: raising the prominence can only ever merge, never split.
		let previous = Infinity;
		for (const prominence of [1, 5, 10, 20, 30, 50, 80]) {
			const count = particles.countIntensityMaxima(plane, mask, width, height, prominence);
			assert.ok(count <= previous, `count rose from ${previous} to ${count} at prominence ${prominence}`);
			previous = count;
		}
	});

	test('the maximum-area filter drops merged clumps', () => {
		const width = 80;
		const height = 40;
		const mask = new Uint8Array(width * height);
		// One small object and one large one.
		for (let y = 5; y < 10; y++) { for (let x = 5; x < 10; x++) { mask[y * width + x] = 1; } }
		for (let y = 15; y < 35; y++) { for (let x = 40; x < 70; x++) { mask[y * width + x] = 1; } }

		const all = particles.analyzeParticles(mask, width, height, {}, {});
		assert.strictEqual(all.particles.length, 2);

		const capped = particles.analyzeParticles(mask, width, height, { maxArea: 100 }, {});
		assert.strictEqual(capped.particles.length, 1);
		assert.strictEqual(capped.rejected.tooLarge, 1);
	});

	test('the summary reports n, mean, SD and SEM per measured column', () => {
		const rows = [
			{ roiId: '1', roiName: 'A', roiKind: 'mask', channel: 0, area: 10, mean: 100 },
			{ roiId: '2', roiName: 'B', roiKind: 'mask', channel: 0, area: 20, mean: 110 },
			{ roiId: '3', roiName: 'C', roiKind: 'mask', channel: 0, area: 30, mean: 120 },
		];
		const summary = roiIo.summarizeRows(rows);
		const byColumn = new Map(summary.map(entry => [entry.column, entry.summary]));

		assert.ok(byColumn.has('area') && byColumn.has('mean'));
		// Identifier-like columns must not be averaged.
		assert.ok(!byColumn.has('channel'), 'channel is an index, not a measurement');
		assert.ok(!byColumn.has('roiName'));

		const area = byColumn.get('area');
		assert.strictEqual(area.n, 3);
		close(area.mean, 20, 1e-9, 'summary mean');
		close(area.stdDev, 10, 1e-9, 'summary SD');
		close(area.sem, 10 / Math.sqrt(3), 1e-9, 'summary SEM');
		close(area.min, 10, 1e-9, 'summary min');
		close(area.max, 30, 1e-9, 'summary max');
	});

	console.log('\n🪄 Interactive segmentation');

	test('region growing selects the planted disc and nothing else', () => {
		const source = discImage(128, 128, 64, 64, 30, 200, 20);
		const region = segmentation.growRegion(source.data, 128, 128, 64, 64, { tolerance: 10 });
		close(region.count, Math.PI * 900, 0.02, 'grown region area');
	});

	test('automatic tolerance finds the object without being told a number', () => {
		// A little noise, so the automatic path has something realistic to work
		// against rather than a perfectly flat plateau.
		const source = discImage(128, 128, 64, 64, 25, 200, 20);
		for (let i = 0; i < source.data.length; i++) { source.data[i] += (Math.sin(i * 12.9898) * 43758.5453 % 1) * 3; }
		const region = segmentation.growRegionAuto(source.data, 128, 128, 64, 64);
		const expected = Math.PI * 625;
		assert.ok(
			region.count > expected * 0.7 && region.count < expected * 1.4,
			`auto region ${region.count} px is not close to the planted ${Math.round(expected)} px disc`,
		);
	});

	test('region growing cannot run away across the whole image', () => {
		const source = discImage(64, 64, 32, 32, 100, 50, 50);
		const region = segmentation.growRegion(source.data, 64, 64, 10, 10, {
			tolerance: 1e6, maxAreaFraction: 0.25,
		});
		assert.ok(region.count <= 64 * 64 * 0.25 + 1, `region grew to ${region.count}, past the cap`);
	});

	test('the brush paints and erases', () => {
		const start = { x: 10, y: 10, width: 1, height: 1, mask: new Uint8Array([0]) };
		const painted = segmentation.brushStroke(start, 20, 20, 5, false, 100, 100);
		assert.ok(painted.count > 50, `brush painted only ${painted.count} px`);
		const erased = segmentation.brushStroke(painted, 20, 20, 5, true, 100, 100);
		assert.strictEqual(erased.count, 0);
	});

	test('Gaussian blur ignores NaN instead of spreading it', () => {
		const width = 16;
		const data = new Float32Array(width * width).fill(10);
		data[8 * width + 8] = NaN;
		const blurred = segmentation.gaussianBlur(data, width, width, 1.5);
		close(blurred[0], 10, 1e-6, 'far from the NaN');
		assert.ok(Number.isFinite(blurred[8 * width + 7]), 'the NaN leaked into its neighbour');
	});

	console.log('\n💾 Interop and persistence');

	test('ImageJ .roi round-trips a polygon', () => {
		const roi = {
			id: 'a', name: 'Cell 3', kind: 'polygon',
			points: [10, 20, 60, 25, 55, 70, 12, 65],
		};
		const encoded = imagej.encodeImageJRoi(roi);
		assert.ok(encoded, 'encoding produced no bytes');
		const decoded = imagej.decodeImageJRoi(encoded);
		assert.ok(decoded, 'decoding failed');
		assert.strictEqual(decoded.roi.kind, 'polygon');
		assert.strictEqual(decoded.roi.name, 'Cell 3');
		assert.strictEqual(decoded.roi.points.length, roi.points.length);
		for (let i = 0; i < roi.points.length; i++) {
			close(decoded.roi.points[i], roi.points[i], 1e-5, `vertex ${i}`);
		}
	});

	test('ImageJ .roi round-trips rectangles, ellipses, lines and points', () => {
		const cases = [
			{ id: 'r', name: 'r', kind: 'rect', x: 5, y: 7, width: 40, height: 25 },
			{ id: 'e', name: 'e', kind: 'ellipse', x: 3, y: 4, width: 20, height: 30 },
			{ id: 'l', name: 'l', kind: 'line', points: [1, 2, 30, 40], lineWidth: 3 },
			{ id: 'p', name: 'p', kind: 'point', points: [5, 5, 10, 12, 20, 3] },
		];
		for (const roi of cases) {
			const decoded = imagej.decodeImageJRoi(imagej.encodeImageJRoi(roi));
			assert.ok(decoded, `${roi.kind} failed to decode`);
			assert.strictEqual(decoded.roi.kind, roi.kind, `${roi.kind} changed kind`);
			if (roi.x !== undefined) {
				assert.strictEqual(decoded.roi.x, roi.x, `${roi.kind} x`);
				assert.strictEqual(decoded.roi.width, roi.width, `${roi.kind} width`);
			}
			if (roi.points) {
				assert.strictEqual(decoded.roi.points.length, roi.points.length, `${roi.kind} point count`);
			}
		}
	});

	test('a RoiSet.zip written here reads back with every ROI', () => {
		const rois = [
			{ id: '1', name: 'A', kind: 'rect', x: 0, y: 0, width: 10, height: 10 },
			{ id: '2', name: 'B', kind: 'polygon', points: [0, 0, 20, 0, 20, 20] },
			{ id: '3', name: 'C', kind: 'line', points: [0, 0, 5, 5] },
		];
		const { bytes, exported } = imagej.exportImageJRois(rois, () => []);
		assert.strictEqual(exported, 3);
		const imported = imagej.importImageJRois(bytes, 'RoiSet.zip');
		assert.strictEqual(imported.length, 3);
		const names = imported.map(entry => entry.roi.name).sort();
		assert.deepStrictEqual(names, ['A', 'B', 'C']);
	});

	test('non-ImageJ bytes are rejected rather than misread', () => {
		assert.strictEqual(imagej.decodeImageJRoi(new Uint8Array(128)), null);
		assert.strictEqual(imagej.importImageJRois(new Uint8Array([1, 2, 3]), 'x.roi').length, 0);
	});

	test('mask run-length encoding round-trips', () => {
		const mask = new Uint8Array(100);
		for (let i = 10; i < 40; i++) { mask[i] = 1; }
		for (let i = 70; i < 95; i++) { mask[i] = 1; }
		const runs = roiIo.encodeMaskRuns(mask);
		const decoded = roiIo.decodeMaskRuns(runs, mask.length);
		assert.deepStrictEqual(Array.from(decoded), Array.from(mask));
	});

	test('the ROI sidecar round-trips including a mask ROI', () => {
		const mask = new Uint8Array(25);
		mask.fill(1, 6, 19);
		const rois = [
			{ id: '1', name: 'Rect', kind: 'rect', x: 1, y: 2, width: 3, height: 4 },
			{ id: '2', name: 'Object', kind: 'mask', x: 10, y: 10, width: 5, height: 5, mask },
		];
		const sidecar = roiIo.buildSidecar(rois, PIXELS, { image: 'a.tif' });
		const parsed = roiIo.parseSidecar(JSON.stringify(sidecar));
		assert.strictEqual(parsed.warnings.length, 0);
		assert.strictEqual(parsed.rois.length, 2);
		assert.deepStrictEqual(Array.from(parsed.rois[1].mask), Array.from(mask));
	});

	test('a corrupt sidecar reports a warning instead of throwing', () => {
		const parsed = roiIo.parseSidecar('{ not json');
		assert.strictEqual(parsed.rois.length, 0);
		assert.ok(parsed.warnings.length > 0);
	});

	console.log('\n📤 Export');

	test('CSV export is long-form with provenance on every row', () => {
		const rows = [
			{ roiId: '1', roiName: 'A', roiKind: 'rect', channel: 0, area: 100, mean: 12.5 },
			{ roiId: '2', roiName: 'B', roiKind: 'rect', channel: 0, area: 200, mean: 25 },
		];
		const text = roiIo.rowsToDelimitedText(rows, {
			fileName: 'sample.tif', unit: 'µm', pixelWidth: 0.5, pixelHeight: 0.5,
			calibrationOrigin: 'ome', thresholdMethod: 'otsu',
		});
		const lines = text.trim().split('\n');
		assert.strictEqual(lines.length, 3, 'header plus one row per ROI');
		assert.ok(lines[0].includes('thresholdMethod'), 'provenance columns are missing');
		assert.ok(lines[1].includes('otsu') && lines[2].includes('otsu'),
			'provenance must repeat on every row so exports concatenate');
	});

	test('German CSV uses a comma decimal mark and a semicolon separator', () => {
		const rows = [{ roiId: '1', roiName: 'A', roiKind: 'rect', channel: 0, area: 412.7 }];
		const text = roiIo.rowsToDelimitedText(rows, {
			unit: 'px', pixelWidth: 1, pixelHeight: 1, calibrationOrigin: 'none',
		}, { delimiter: ';', decimal: ',' });
		assert.ok(text.includes('412,7'), 'the decimal mark was not converted');
		assert.ok(!text.includes('412.7'), 'a dot decimal survived, which German Excel reads as a date');
	});

	test('non-finite values export as text, never as zero', () => {
		const rows = [{ roiId: '1', roiName: 'A', roiKind: 'rect', channel: 0, mean: NaN, max: Infinity }];
		const text = roiIo.rowsToDelimitedText(rows, {
			unit: 'px', pixelWidth: 1, pixelHeight: 1, calibrationOrigin: 'none',
		});
		assert.ok(text.includes('NaN'), 'NaN was not preserved');
		assert.ok(text.includes('Inf'), 'Infinity was not preserved');
	});

	test('filename patterns become grouping columns', () => {
		const matched = roiIo.matchFilenamePattern('control_rep2_005.tif', '{condition}_{replicate}_{index}.tif');
		assert.deepStrictEqual(matched, { condition: 'control', replicate: 'rep2', index: '005' });
		assert.strictEqual(roiIo.matchFilenamePattern('other.tif', '{a}_{b}.tif'), null);
	});

	test('group summaries report n, mean and SEM', () => {
		const rows = [
			{ roiId: '1', roiName: 'A', roiKind: 'rect', channel: 0, area: 10, group: 'x' },
			{ roiId: '2', roiName: 'B', roiKind: 'rect', channel: 0, area: 20, group: 'x' },
			{ roiId: '3', roiName: 'C', roiKind: 'rect', channel: 0, area: 30, group: 'x' },
		];
		const [summary] = roiIo.summarizeByGroup(rows, 'area', row => row.group);
		assert.strictEqual(summary.n, 3);
		close(summary.mean, 20, 1e-9, 'group mean');
		close(summary.stdDev, 10, 1e-9, 'group stddev');
		close(summary.sem, 10 / Math.sqrt(3), 1e-9, 'group SEM');
	});

	test('the pandas script reflects the actual session, not a fixed template', () => {
		const script = roiIo.buildPandasScript({
			csvName: 'sample-results.csv',
			columns: ['area', 'channel', 'mean', 'roiName'],
			unit: 'µm',
			pixelWidth: 0.325,
			pixelHeight: 0.325,
			calibrationOrigin: 'ome',
			groupColumns: ['condition', 'replicate'],
			derivedColumns: [{ name: 'density', expression: 'mean / area ^ 2' }],
			thresholdMethod: 'otsu',
			roiCount: 42,
			channelCount: 3,
		});

		assert.ok(script.includes('sample-results.csv'), 'the CSV name is missing');
		assert.ok(script.includes('0.325') && script.includes('µm'), 'the calibration is missing');
		assert.ok(script.includes('otsu'), 'the threshold provenance is missing');
		assert.ok(script.includes('42 ROI'), 'the ROI count is missing');
		assert.ok(script.includes('"condition", "replicate"'), 'the grouping columns are missing');
		assert.ok(script.includes('area, channel, mean, roiName'), 'the column list is missing');
		// ^ is exponentiation in our expressions and XOR in pandas; translating it
		// is the difference between a right answer and a silently wrong one.
		assert.ok(script.includes('mean / area ** 2'), 'the derived expression was not translated for pandas');
		assert.ok(!script.includes('area ^ 2'), 'a raw ^ survived into the pandas expression');
		assert.ok(script.includes('df["channel"] == 0'), 'multi-channel handling is missing');

		// A different session must produce a different script.
		const other = roiIo.buildPandasScript({
			csvName: 'other-results.csv',
			columns: ['length', 'channel', 'roiName'],
			unit: 'px',
			pixelWidth: 1,
			pixelHeight: 1,
			calibrationOrigin: 'none',
			groupColumns: [],
			derivedColumns: [],
			roiCount: 1,
			channelCount: 1,
		});
		assert.notStrictEqual(other, script);
		assert.ok(other.includes('Uncalibrated'), 'an uncalibrated session should say so');
		assert.ok(other.includes('"length"'), 'the summary column should follow the available measurements');
		assert.ok(!other.includes('df["channel"] == 0'), 'single-channel data needs no channel filter');
	});

	console.log('\n🧮 Expressions');

	test('arithmetic, precedence and functions evaluate correctly', () => {
		const cases = [
			['1 + 2 * 3', {}, 7],
			['(1 + 2) * 3', {}, 9],
			['2 ^ 3 ^ 2', {}, 512],
			['-4 + 10', {}, 6],
			['sqrt(16)', {}, 4],
			['max(3, 7)', {}, 7],
			['rawIntegratedDensity / area', { rawIntegratedDensity: 500, area: 20 }, 25],
			['log10(1000)', {}, 3],
			['1e-2 * 100', {}, 1],
		];
		for (const [source, scope, expected] of cases) {
			const value = expression.compileExpression(source)(scope);
			close(value, expected, 1e-9, source);
		}
	});

	test('unknown identifiers become NaN rather than throwing', () => {
		assert.ok(Number.isNaN(expression.compileExpression('missingColumn * 2')({})));
	});

	test('malformed expressions raise a positioned error', () => {
		assert.throws(() => expression.compileExpression('1 +'), /Unexpected end/);
		assert.throws(() => expression.compileExpression('nope(3)'), /Unknown function/);
		assert.throws(() => expression.compileExpression('1 $ 2'), /Unexpected character/);
	});

	console.log('\n📏 Calibration');

	test('TIFF resolution tags become a pixel size', () => {
		const result = calibration.calibrationFromTiffTags({ t282: 300, t283: 300, t296: 2 });
		close(result.pixelWidth, 1 / 300, 1e-12, 'pixel width');
		assert.strictEqual(result.unit, 'inch');
		assert.strictEqual(result.origin, 'tiff-resolution');
	});

	test('meaningless resolution tags are rejected, not reported as inches', () => {
		// ResolutionUnit 1 means "no absolute unit", and 1x1 is the placeholder
		// writers emit when they have nothing to say.
		assert.strictEqual(calibration.calibrationFromTiffTags({ t282: 300, t283: 300, t296: 1 }), null);
		assert.strictEqual(calibration.calibrationFromTiffTags({ t282: 1, t283: 1, t296: 2 }), null);
		assert.strictEqual(calibration.calibrationFromTiffTags({}), null);
	});

	test('OME physical sizes win over resolution tags', () => {
		const result = calibration.autoCalibration(
			{ physicalSizeX: 0.325, physicalSizeY: 0.325, physicalSizeXUnit: 'µm' },
			{ t282: 300, t283: 300, t296: 2 },
		);
		assert.strictEqual(result.origin, 'ome');
		close(result.pixelWidth, 0.325, 1e-12, 'OME pixel width');
	});

	test('mixed OME units are refused rather than silently mismatched', () => {
		const result = calibration.calibrationFromOme({
			physicalSizeX: 1, physicalSizeY: 1, physicalSizeXUnit: 'µm', physicalSizeYUnit: 'nm',
		});
		assert.strictEqual(result, null);
	});

	test('a known distance sets the scale', () => {
		const result = calibration.calibrationFromKnownDistance(200, 50, 'µm');
		close(result.pixelWidth, 0.25, 1e-12, 'pixel width from a known distance');
		assert.strictEqual(result.origin, 'manual');
	});

	test('the scale bar picks a round number', () => {
		const bar = calibration.chooseScaleBarLength(
			1000, { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm', origin: 'manual' }, 0.2);
		assert.ok(/^(1|2|5)0*(\.\d+)? µm$/.test(bar.label), `scale bar label "${bar.label}" is not a round number`);
	});

	console.log('\n' + '─'.repeat(60));
	if (failed === 0) {
		console.log(`🎉 All ${passed} measurement tests passed.`);
	} else {
		console.log(`❌ ${failed} of ${passed + failed} measurement tests failed.`);
		process.exitCode = 1;
	}
}

main().catch(error => {
	console.error('Test harness failed:', error);
	process.exitCode = 1;
});
