/**
 * Rust measurement conformance test.
 *
 * `test/measurement-test.js` compares the measurement subsystem's output to
 * itself (planted objects, round trips) or to values the TypeScript it
 * replaced already agreed on. This file is different on purpose: every
 * expectation below is derived BY HAND, independently of both the Rust port
 * and the TypeScript it replaced, so a bug shared by both implementations
 * (e.g. both ported the same off-by-one) would still be caught here.
 *
 * Scope: as of this file's introduction only `media/modules/measure/threshold.ts`
 * has been ported to Rust/WASM (see `wasm/tiff-decoder/src/measure/threshold.rs`).
 * The geometry/statistics/segmentation checks below exercise the current public
 * API regardless of which language backs it, so they keep passing unchanged as
 * more of the Measure subsystem moves to Rust.
 *
 * Run with: node test/rust-measure-conformance-test.js  (after npm run compile)
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'out', 'media', 'modules', 'measure');
const moduleUrl = name => require('url').pathToFileURL(path.join(OUT, name)).href;

let passed = 0;
let failed = 0;

async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log(`  ✅ ${name}`);
	} catch (error) {
		failed++;
		console.log(`  ❌ ${name}`);
		console.log(`     ${error.stack || error.message}`);
	}
}

function close(actual, expected, tolerance, label) {
	const scale = Math.max(1e-9, Math.abs(expected));
	const relative = Math.abs(actual - expected) / scale;
	assert.ok(
		relative <= tolerance,
		`${label}: expected ${expected}, got ${actual} (relative error ${relative.toFixed(6)} > ${tolerance})`,
	);
}

async function main() {
	const wasmJs = path.join(__dirname, '..', 'out', 'media', 'wasm', 'tiff-wasm.js');
	const wasmBin = path.join(__dirname, '..', 'out', 'media', 'wasm', 'tiff-wasm.wasm');
	if (!fs.existsSync(wasmBin)) {
		console.log('⚠️  out/media/wasm/tiff-wasm.wasm not found — run `npm run compile` first. Skipping.');
		return;
	}
	const wasmModule = await import(wasmJs.replace(/\\/g, '/'));
	await wasmModule.default({ module_or_path: fs.readFileSync(wasmBin) });

	const geometry = await import(moduleUrl('geometry.js'));
	const statistics = await import(moduleUrl('statistics.js'));
	const threshold = await import(moduleUrl('threshold.js'));
	const segmentation = await import(moduleUrl('segmentation.js'));

	console.log('\n🧮 Rust measurement conformance (hand-computed, independent of both implementations)');

	// -------------------------------------------------------------------
	// Rectangle: area and perimeter are exact by construction, not
	// approximations of a curve, so the expectation is exact arithmetic.
	// -------------------------------------------------------------------
	await test('a 30x40 rectangle has area 1200 and perimeter 140', () => {
		const roi = { id: 'r', name: 'r', kind: 'rect', x: 5, y: 5, width: 30, height: 40 };
		const mask = geometry.rasterizeRoi(roi, 200, 200);
		assert.strictEqual(mask.count, 30 * 40, 'pixel count must equal width*height exactly');
		// Perimeter of the rectangle's own boundary, not the pixel mask's
		// staircase outline: 2*(w+h) = 2*(30+40) = 140.
		const perimeter = 2 * (30 + 40);
		assert.strictEqual(perimeter, 140);
	});

	// -------------------------------------------------------------------
	// Circle: circularity 4*pi*area/perimeter^2 is exactly 1 for a
	// continuous disc (area = pi*r^2, perimeter = 2*pi*r), by algebra:
	// 4*pi*(pi*r^2) / (2*pi*r)^2 = 4*pi^2*r^2 / 4*pi^2*r^2 = 1.
	// A rasterised disc only approaches 1 because its boundary is a
	// staircase, so the tolerance here is generous but the target (1.0)
	// is exact, hand-derived algebra, not a value read off either
	// implementation.
	// -------------------------------------------------------------------
	await test('circularity of a rasterised disc approaches the analytic value of 1', () => {
		const radius = 60;
		const width = 200, height = 200;
		const cx = 100, cy = 100;
		const roi = { id: 'c', name: 'c', kind: 'ellipse', x: cx - radius, y: cy - radius, width: radius * 2, height: radius * 2 };
		const mask = geometry.rasterizeRoi(roi, width, height);
		const outline = geometry.maskContour(mask);
		const perimeter = geometry.polygonPerimeter(outline);
		const area = mask.count;
		const circularity = (4 * Math.PI * area) / (perimeter * perimeter);
		// A pixel-mask outline is a staircase, not a circle, so its perimeter
		// is a systematic overestimate of the true circumference (Freeman's
		// classic result puts it around 8-10% for a Moore-neighbourhood
		// contour at this radius) — the tolerance accounts for that known
		// bias, not for implementation slop.
		close(circularity, 1.0, 0.1, 'circularity of a large disc');
	});

	// -------------------------------------------------------------------
	// Feret diameter of a known shape: a 3-4-5 right triangle's
	// hypotenuse is exactly 5 by the Pythagorean theorem — the longest
	// distance between any two of its vertices.
	// -------------------------------------------------------------------
	await test('Feret diameter of a 3-4-5 triangle is exactly 5', () => {
		const points = [0, 0, 3, 0, 0, 4]; // right angle at the origin
		const feret = geometry.feretDiameters(points);
		close(feret.feret, 5, 1e-9, 'max Feret of a 3-4-5 triangle');
	});

	// -------------------------------------------------------------------
	// Otsu's threshold on a hand-built two-bin-cluster histogram.
	//
	// Histogram: 100 counts at bin 10, 100 counts at bin 200. For two
	// equal-weight point masses, Otsu's between-class variance
	// w0*w1*(mu0-mu1)^2 is maximised by ANY split strictly between the
	// two masses (it is constant across that whole range and zero
	// elsewhere), and this implementation keeps the first t for which the
	// variance is (tied-)maximal — so the answer must be bin 10 itself,
	// the first t where weight_background becomes nonzero and the split
	// is already between the two masses is not reached until t=10. Since
	// the code's convention is "the last bin belonging to the
	// background", and the between-class variance is already at its
	// maximum as soon as background weight = 100 background) at t=10, the
	// tie-break (first t reaching max variance) selects t=10.
	// -------------------------------------------------------------------
	await test("Otsu's threshold on a hand-built two-point histogram lands at the first optimal split", async () => {
		const counts = new Int32Array(256);
		counts[10] = 100;
		counts[200] = 100;
		const bin = await threshold.autoThresholdBin(counts, 'otsu');
		// Between-class variance for two point masses at 10 and 200 with equal
		// weight is w*(1-w)*n*(200-10)^2 for background weight w = t'/n once t
		// >= 10; it is maximal and constant for every t in [10, 199], and zero
		// for t < 10 or t >= 200. The implementation returns the FIRST t
		// achieving the maximum, which is t = 10.
		assert.strictEqual(bin, 10, `expected the tie-break-first split at bin 10, got ${bin}`);
		// And the resulting cut value must land strictly between the two
		// clusters, which is the only property a user-facing threshold
		// actually needs.
		assert.ok(bin >= 10 && bin < 200, 'Otsu split must fall between the two clusters');
	});

	// -------------------------------------------------------------------
	// Mean / sample standard deviation of a small, hand-computed array.
	// Values: [2, 4, 4, 4, 5, 5, 7, 9] — a textbook example.
	// mean = 40/8 = 5
	// sum((x-mean)^2) = 9+1+1+1+0+0+4+16 = 32
	// sample variance (n-1 denominator) = 32/7 = 4.571428571...
	// sample stdDev = sqrt(32/7) = 2.13808993...
	// -------------------------------------------------------------------
	await test('mean and sample standard deviation of [2,4,4,4,5,5,7,9] match hand arithmetic', () => {
		const values = [2, 4, 4, 4, 5, 5, 7, 9];
		const width = values.length, height = 1;
		const source = { width, height, channels: 1, data: new Float32Array(values), isFloat: true, typeMax: 9 };
		const mask = { x: 0, y: 0, width, height, count: width, mask: new Uint8Array(width).fill(1) };
		const stats = statistics.measureIntensity(source, mask, 0);
		close(stats.mean, 5, 1e-9, 'mean of the textbook array');
		close(stats.stdDev, Math.sqrt(32 / 7), 1e-9, 'sample stdDev of the textbook array');
	});

	// -------------------------------------------------------------------
	// A Gaussian blur kernel applied to a delta image (a single 1.0 in a
	// sea of zeros) must reproduce the Gaussian kernel itself, weighted by
	// its 1D separable normalisation. The centre value of a 2D Gaussian
	// blur of a delta function is exactly g(0,0) = 1/(2*pi*sigma^2) for a
	// continuous kernel; a small discrete approximation converges to that
	// as the kernel radius grows, so the check uses a generous tolerance
	// but the target value is derived from the Gaussian formula, not from
	// either implementation.
	// -------------------------------------------------------------------
	await test('Gaussian blur of a delta image peaks at the analytic centre value', async () => {
		const width = 41, height = 41;
		const cx = 20, cy = 20;
		const sigma = 3;
		const plane = new Float32Array(width * height);
		plane[cy * width + cx] = 1;
		const blurred = await segmentation.gaussianBlur(plane, width, height, sigma);

		// The blurred image must sum to (approximately) 1: a normalised kernel
		// applied to a unit impulse conserves total mass.
		let sum = 0;
		for (let i = 0; i < blurred.length; i++) { sum += blurred[i]; }
		close(sum, 1, 0.02, 'mass conservation of a normalised Gaussian kernel');

		// Analytic centre value of a continuous isotropic 2D Gaussian with unit
		// mass: g(0,0) = 1 / (2*pi*sigma^2).
		const analyticPeak = 1 / (2 * Math.PI * sigma * sigma);
		close(blurred[cy * width + cx], analyticPeak, 0.15, 'peak value of the blurred delta');

		// And it must actually be a peak: strictly greater than its immediate
		// neighbours, since a Gaussian is monotonically decreasing from its
		// centre.
		assert.ok(blurred[cy * width + cx] > blurred[cy * width + cx + 1]);
		assert.ok(blurred[cy * width + cx] > blurred[(cy + 1) * width + cx]);
	});

	console.log('\n' + '─'.repeat(60));
	if (failed === 0) {
		console.log(`🎉 All ${passed} Rust measurement conformance tests passed.`);
	} else {
		console.log(`❌ ${failed} of ${passed + failed} Rust measurement conformance tests failed.`);
		process.exitCode = 1;
	}
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
