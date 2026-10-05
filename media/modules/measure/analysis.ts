import { analyzeParticles, countIntensityMaxima, type SplitMode } from './particles.js';
import { gaussianBlur, subtractBackground } from './segmentation.js';
import { autoThresholdBin, buildHistogram, computeStabilityCurve, globalThresholdMask, localAutoThresholdMask, localThresholdMask, THRESHOLD_METHODS, thresholdValueFromBin, type LocalMethod, type ScalarHistogram, type StabilityCurve, type ThresholdMethod } from './threshold.js';
import type { MeasurementSource } from './types.js';

interface AnalysisHost {
  getSource(): MeasurementSource | null;
  getScalarPlane(): Float32Array | null;
  changed(): void;
  maskChanged(): void;
  isVisible(): boolean;
}
interface ThresholdState {
	method: ThresholdMethod;
	localMethod: LocalMethod;
	/** Run the selected global method per window instead of once. */
	localizeGlobal: boolean;
	localRadius: number;
	localK: number;
	low: number;
	high: number;
	darkBackground: boolean;
	blurSigma: number;
	backgroundRadius: number;
	split: SplitMode;
	prominence: number;
	fillHoles: boolean;
	excludeEdges: boolean;
	minArea: number;
	maxArea: number;
	minCircularity: number;
	maxCircularity: number;
	manual: boolean;
}

const DEFAULT_THRESHOLD: ThresholdState = {
	method: 'otsu',
	localMethod: 'none',
	localizeGlobal: false,
	localRadius: 15,
	localK: 0.25,
	low: 0,
	high: 1,
	darkBackground: true,
	blurSigma: 0,
	backgroundRadius: 0,
	split: 'none',
	prominence: 0,
	fillHoles: true,
	excludeEdges: false,
	minArea: 10,
	maxArea: Number.POSITIVE_INFINITY,
	minCircularity: 0,
	maxCircularity: 1,
	manual: false,
};


/** Numerical jobs and cancellation state; no DOM or panel dependency. */
export class MeasurementAnalysis {
	threshold: ThresholdState = { ...DEFAULT_THRESHOLD };
	histogram: ScalarHistogram | null = null;
	stability: StabilityCurve | null = null;
	thresholdMask: Uint8Array | null = null;
	previewPlane: Float32Array | null = null;
	/**
	 * Rises on every threshold-affecting change (preprocessing, method, range).
	 * `buildHistogram`/`autoThresholdBin`/the mask builders now reach the
	 * Rust/WASM module, so their callers are lazy-async: a stale in-flight
	 * result is dropped by comparing against this token when it resolves,
	 * exactly like `particleToken` below. Eager precomputation on every
	 * keystroke would stall the range-field inputs, which is why these stay
	 * lazy rather than being awaited inline.
	 */
	thresholdToken = 0;
	thresholdPrepareBusy = false;
	thresholdApplyBusy = false;
	stabilityBusy = false;
	/** Auto-threshold bin per method, cached per histogram for the gallery. */
	methodBins: Map<ThresholdMethod, number> | null = null;
	methodBinsBusy = false;
	/** Discards a stale hover-preview mask that resolves after the pointer left. */
	hoverToken = 0;
	/** Cached particle pass, so the stats line and the preview agree and the
	 *  analysis is not run twice per render. */
	particleResult: Awaited<ReturnType<typeof analyzeParticles>> | null = null;
	/** Rises on every invalidation so a late analysis can be discarded. */
	particleToken = 0;
	particleAnalysisRunning = false;

 private preparePending: number | null = null;
 private applyPending: number | null = null;
 constructor(private host: AnalysisHost) {}

  invalidateImage(): void {
    this.preparePending = this.applyPending = null;
    this.thresholdToken++;
    this.particleToken++;
    this.hoverToken++;
    this.histogram = null;
    this.stability = null;
    this.thresholdMask = null;
    this.previewPlane = null;
    this.particleResult = null;
    this.methodBins = null;
  }

	ensureMethodBins(): Map<ThresholdMethod, number> | null {
		if (this.methodBins) { return this.methodBins; }
		void this.computeMethodBins(this.thresholdToken);
		return null;
	}

	async computeMethodBins(token: number): Promise<void> {
		if (this.methodBinsBusy) { return; }
		const histogram = this.histogram;
		if (!histogram) { return; }
		this.methodBinsBusy = true;
		try {
			const bins = new Map<ThresholdMethod, number>();
			for (const method of THRESHOLD_METHODS) {
				const bin = await autoThresholdBin(histogram.counts, method.id);
				if (token !== this.thresholdToken) { return; }
				bins.set(method.id, bin);
			}
			this.methodBins = bins;
			this.host.changed();
		} finally {
			this.methodBinsBusy = false;
		}
	}

	async preprocessedPlane(): Promise<Float32Array | null> {
		const plane = this.host.getScalarPlane();
		const source = this.host.getSource();
		if (!plane || !source) { return null; }
		let working = plane;
		if (this.threshold.blurSigma > 0) {
			working = await gaussianBlur(working, source.width, source.height, this.threshold.blurSigma);
		}
		if (this.threshold.backgroundRadius > 0) {
			working = await subtractBackground(
				working, source.width, source.height,
				this.threshold.backgroundRadius, !this.threshold.darkBackground,
			);
		}
		return working;
	}

	prepareThreshold(): void {
		this.thresholdToken++;
		this.histogram = null;
		this.stability = null;
		this.methodBins = null;
		void this.runPrepareThreshold(this.thresholdToken);
	}

	async runPrepareThreshold(token: number): Promise<void> {
		if (this.thresholdPrepareBusy) { this.preparePending = token; return; }
		this.thresholdPrepareBusy = true;
		try {
			const source = this.host.getSource();
			const plane = await this.preprocessedPlane();
			if (!source || !plane) { return; }
			// Subsample the histogram on large images; every method below is
			// scale-invariant in the counts, so the chosen bin does not move.
			const step = Math.max(1, Math.floor(plane.length / 1_000_000));
			const histogram = await buildHistogram(plane, step);
			if (token !== this.thresholdToken) { return; }
			this.previewPlane = plane;
			this.histogram = histogram;
			if (!this.threshold.manual) {
				await this.runApplyThreshold(token);
				if (token !== this.thresholdToken) { return; }
			}
			this.host.changed();
		} finally {
			this.thresholdPrepareBusy = false;
			const pending = this.preparePending;
			this.preparePending = null;
			if (pending !== null) void this.runPrepareThreshold(pending);
		}
	}

	applyThreshold(): void {
		this.thresholdToken++;
		void this.runApplyThreshold(this.thresholdToken);
	}

	async runApplyThreshold(token: number): Promise<void> {
		if (this.thresholdApplyBusy) { this.applyPending = token; return; }
		this.thresholdApplyBusy = true;
		try {
			const source = this.host.getSource();
			const plane = this.previewPlane;
			const histogram = this.histogram;
			if (!source || !plane || !histogram) { return; }

			const usingGlobalAuto = !this.threshold.manual
				&& this.threshold.localMethod === 'none'
				&& !this.threshold.localizeGlobal;

			if (usingGlobalAuto) {
				const bin = await autoThresholdBin(histogram.counts, this.threshold.method);
				if (token !== this.thresholdToken) { return; }
				if (bin >= 0) {
					const value = thresholdValueFromBin(histogram, bin);
					if (this.threshold.darkBackground) {
						this.threshold.low = value;
						this.threshold.high = histogram.max;
					} else {
						this.threshold.low = histogram.min;
						this.threshold.high = value;
					}
				}
			}

			let mask: Uint8Array;
			if (this.threshold.localMethod !== 'none') {
				mask = await localThresholdMask(plane, source.width, source.height, {
					method: this.threshold.localMethod,
					radius: this.threshold.localRadius,
					k: this.threshold.localK,
					darkBackground: this.threshold.darkBackground,
				});
			} else if (this.threshold.localizeGlobal && !this.threshold.manual) {
				mask = await localAutoThresholdMask(plane, source.width, source.height, {
					method: this.threshold.method,
					radius: this.threshold.localRadius,
					darkBackground: this.threshold.darkBackground,
				});
			} else {
				mask = await globalThresholdMask(plane, this.threshold.low, this.threshold.high);
			}
			if (token !== this.thresholdToken) { return; }
			this.thresholdMask = mask;
			this.particleResult = null;
			this.particleToken++;
			// Raw mask only: this runs on every keystroke in the range fields, and a
			// full labelling pass per keystroke would stall a large image. The green
			// accepted layer is added once per render, where the particle analysis
			// has to happen anyway for the object count.
			this.host.maskChanged();
			this.host.changed();
		} finally {
			this.thresholdApplyBusy = false;
			const pending = this.applyPending;
			this.applyPending = null;
			if (pending !== null) void this.runApplyThreshold(pending);
		}
	}

	adoptThresholdValue(value: number): void {
		if (!this.histogram) { return; }
		this.threshold.manual = true;
		if (this.threshold.darkBackground) {
			this.threshold.low = value;
			this.threshold.high = this.histogram.max;
		} else {
			this.threshold.low = this.histogram.min;
			this.threshold.high = value;
		}
		this.applyThreshold();
	}

	computeStability(): void {
		void this.runComputeStability(this.thresholdToken);
	}

	async runComputeStability(token: number): Promise<void> {
		if (this.stabilityBusy) { return; }
		this.stabilityBusy = true;
		try {
			const source = this.host.getSource();
			const plane = this.previewPlane;
			const histogram = this.histogram;
			if (!source || !plane || !histogram) { return; }
			const curve = await computeStabilityCurve(plane, source.width, source.height, histogram, {
				darkBackground: this.threshold.darkBackground,
			});
			if (token !== this.thresholdToken) { return; }
			this.stability = curve;
			this.host.changed();
		} finally {
			this.stabilityBusy = false;
		}
	}

	ensureParticles() {
		if (this.particleResult) { return this.particleResult; }
		void this.startParticleAnalysis();
		return null;
	}

	async startParticleAnalysis(): Promise<void> {
		if (this.particleAnalysisRunning) { return; }
		const token = this.particleToken;
		this.particleAnalysisRunning = true;
		try {
			const result = await this.runParticles();
			if (token !== this.particleToken) { return; }
			this.particleResult = result;
			// The count, CTA, and green accepted-object preview are one result and
			// must update together. Refreshing only the canvas left the panel saying
			// "No objects" even while accepted objects were visibly green.
			if (result && this.host.isVisible()) { this.host.changed(); }
		} catch (error) {
			console.warn('[MeasurePanel] Particle analysis failed:', error);
		} finally {
			this.particleAnalysisRunning = false;
			// A filter can change while the worker/WASM pass is in flight. The old
			// result is correctly discarded above; immediately service the newer
			// request so the panel cannot remain stuck in its pending state.
			if (token !== this.particleToken && this.thresholdMask && this.host.isVisible()) {
				void this.startParticleAnalysis();
			}
		}
	}

	async runParticles() {
		const source = this.host.getSource();
		if (!this.thresholdMask || !source) { return null; }
		return await analyzeParticles(this.thresholdMask, source.width, source.height, {
			minArea: this.threshold.minArea,
			maxArea: Number.isFinite(this.threshold.maxArea) ? this.threshold.maxArea : undefined,
			minCircularity: this.threshold.minCircularity > 0 ? this.threshold.minCircularity : undefined,
			maxCircularity: this.threshold.maxCircularity < 1 ? this.threshold.maxCircularity : undefined,
			excludeEdges: this.threshold.excludeEdges,
			fillHoles: this.threshold.fillHoles,
		}, {
			split: this.threshold.split,
			prominence: this.threshold.prominence,
			plane: this.previewPlane || undefined,
		});
	}

	countMaxima(): number | null {
		const source = this.host.getSource();
		if (!this.thresholdMask || !this.previewPlane || !source) { return null; }
		return countIntensityMaxima(
			this.previewPlane, this.thresholdMask, source.width, source.height, this.threshold.prominence,
		);
	}
}
