<script lang="ts">
  import type { MeasurePanel, MeasureModel, ThresholdMethodView } from '../../media/modules/measure-panel';
  import { formatNumber } from '../../media/modules/measure/calibration';
  import type { SplitMode } from '../../media/modules/measure/particles';
  import Field from './MeasureField.svelte';
  import Section from './MeasureSection.svelte';
  let { panel, viewData }: { panel: MeasurePanel; viewData: NonNullable<MeasureModel['segment']> } = $props();
  const t = $derived(viewData.threshold);
  const adaptive = $derived(t.localMethod!=='none'||t.localizeGlobal);
  const methods = $derived(viewData.methods);
  const pending = $derived(viewData.pending);
  const count = $derived(viewData.count);
  const suggested = $derived(viewData.stability?.suggested ?? 0);
  function refilter() {Object.assign(panel.analysis.threshold,t);panel.analysis.particleResult=null;panel.analysis.particleToken++;panel.refreshMaskOverlay();panel.render();}
  function apply() {Object.assign(panel.analysis.threshold,t);panel.analysis.applyThreshold();panel.render();}
  function preprocess() {Object.assign(panel.analysis.threshold,t);panel.analysis.prepareThreshold();panel.render();}
  function spark(canvas:HTMLCanvasElement,bin:number) { const paint = (value: number) => panel.paintSpark(canvas,value); paint(bin); return { update: paint }; }
  function histogram(canvas:HTMLCanvasElement, _view: typeof viewData) {panel.bindHistogram(canvas); return { update: () => panel.drawHistogramSlider(canvas, { left: 8, right: 8, top: 6, bottom: 14 }) };}
  function stability(canvas:HTMLCanvasElement, _view: typeof viewData) {panel.bindStability(canvas); return { update: () => panel.drawStability(canvas) };}
  function choose(method:ThresholdMethodView) {method.apply();panel.analysis.applyThreshold();panel.render();}
</script>
{#if !viewData.hasSource}<Section title="Threshold"><div class="measure-note">No measurable image is loaded.</div></Section>
{:else}
  <Section title="Histogram">{#if viewData.hasHistogram}<canvas class="measure-histogram" class:measure-histogram-inactive={adaptive} width="460" height="120" use:histogram={viewData}></canvas><div class="measure-note">{adaptive?'An adaptive method is active, so it computes its own threshold per neighbourhood and this range is not in use. Drag a handle to take manual control.':`Drag either edge of the shaded band to set the range. Currently ${formatNumber(t.low,4)} – ${formatNumber(t.high,4)}.`}</div>{/if}</Section>
  <Section title="Preprocess (segmentation only)"><div class="measure-note">Applied to a copy used for thresholding. The displayed image is never modified.</div>
    <Field label="Gaussian blur σ" value={t.blurSigma} step="0.5" min={0} change={value=>{t.blurSigma=Math.max(0,value);preprocess();}} />
    <Field label="Background radius" value={t.backgroundRadius} step="5" min={0} title="Rolling-ball background subtraction. 0 disables it. Fixes uneven illumination, the usual reason a global threshold appears to have no right value." change={value=>{t.backgroundRadius=Math.max(0,Math.round(value));preprocess();}} />
  </Section>
  <Section title="Method"><Field type="checkbox" label="Objects are brighter than the background" value={t.darkBackground} change={value=>{t.darkBackground=value;apply();}} /><div class="measure-note">{t.manual?'Range set by hand. Pick a method below to go back to an automatic cut.':'Hover any entry to see it on the image; click to keep it.'}</div>
    <Field type="checkbox" label="Apply the chosen method per window" value={t.localizeGlobal} title="Runs the selected method on the histogram of a local neighbourhood instead of the whole image — ImageJ’s Auto Local Threshold. Use it when the same criterion is right but the illumination is not even." change={value=>{t.localizeGlobal=value;if(value){t.localMethod='none';t.manual=false;}apply();}} />
    <div class="measure-method-grid">{#each methods as method}<button class="measure-method" class:active={method.active} disabled={method.disabled} title={method.hint} onmouseenter={()=>panel.previewMethod(method)} onmouseleave={()=>{panel.analysis.hoverToken++;panel.showTemporaryMask(null);}} onclick={()=>choose(method)}><div class="measure-method-label">{method.label}</div><div class="measure-method-value">{method.value}</div>{#if method.spark!==undefined}<canvas class="measure-spark" width="96" height="24" use:spark={method.spark}></canvas>{/if}</button>{/each}</div>
  </Section>
  {#if adaptive}<Section title="Neighbourhood"><Field label="Window radius" value={t.localRadius} step="1" min={1} title="Somewhat larger than your objects: the window has to contain both object and background to tell them apart." change={value=>{t.localRadius=Math.max(1,Math.round(value));apply();}} />
    {#if t.localMethod!=='none'}<Field label="Sensitivity (k)" value={t.localK} step="0.05" title="Higher is stricter — fewer pixels pass. 0.25 is a good starting point." change={value=>{t.localK=value;apply();}} />{/if}
  </Section>{/if}
  <Section title="How robust is this threshold?">
    {#if !viewData.stability||!viewData.hasHistogram}<div class="measure-note">Sweeps the threshold across the whole range and plots how many objects each value gives. Flat stretches are values where the count does not depend on your exact choice — pick one of those and the result stops being a guess.</div><button class="measure-button" onclick={()=>{panel.analysis.computeStability();panel.render();}}>Compute</button>
    {:else}<canvas class="measure-stability" width="460" height="120" use:stability={viewData}></canvas><div class="measure-note">{viewData.stability.plateauWidth>1?`Widest plateau spans ${viewData.stability.plateauWidth} of ${viewData.stability.count} sampled thresholds; its centre is ${formatNumber(suggested,4)}.`:'No clear plateau — the object count changes continuously, so this image may need local adaptive thresholding instead.'}</div><div class="measure-note">Click or drag across the plot to set the threshold.</div><button class="measure-button" onclick={()=>{panel.analysis.adoptThresholdValue(suggested);panel.render();}}>Use the most stable threshold</button>{/if}
  </Section>
  <Section title="Particles"><label class="measure-row"><span class="measure-label">Split touching</span><select class="measure-select" value={t.split} onchange={e=>{t.split=e.currentTarget.value as SplitMode;if(t.split==='intensity'&&t.prominence<=0)t.prominence=panel.analysis.histogram?(panel.analysis.histogram.max-panel.analysis.histogram.min)/10:1;refilter();}}><option value="none" title="Each connected region is one object.">Do not split</option><option value="shape" title="Distance-transform watershed. Separates round objects that overlap.">By shape (watershed)</option><option value="intensity" title="Splits at local intensity peaks, restricted to the threshold mask. Use when objects touch without their outline pinching.">By intensity maxima</option></select></label>
    {#if t.split==='intensity'}<Field label="Prominence" value={t.prominence} min={0} title="How far a peak must rise above the saddle joining it to a brighter one before it counts as its own object. Raise it until the centre count matches what you see." change={value=>{t.prominence=Math.max(0,value);refilter();}} />{@const centres=viewData.maxima}{#if centres!==null}<div class="measure-note">{centres} centre(s) at this prominence.</div>{/if}{/if}
    <Field type="checkbox" label="Fill holes" value={t.fillHoles} change={value=>{t.fillHoles=value;refilter();}} />
    <Field type="checkbox" label="Exclude objects touching the edge" value={t.excludeEdges} title="Edge objects are cut off, so their area and shape are not measurable." change={value=>{t.excludeEdges=value;refilter();}} />
    <Field label="Min area (px)" value={t.minArea} step="1" min={0} change={value=>{t.minArea=Math.max(0,value);refilter();}} />
    <Field label="Max area (px)" value={Number.isFinite(t.maxArea)?t.maxArea:0} step="1" min={0} title="0 means no upper limit. Use it to drop merged clumps that survived splitting." change={value=>{t.maxArea=value>0?value:Infinity;refilter();}} />
    <Field label="Min circularity" value={t.minCircularity} step="0.05" min={0} max={1} change={value=>{t.minCircularity=value;refilter();}} />
    <div class="measure-note">{viewData.maskStats}</div><div class="measure-legend">
      <div class="measure-legend-row"><span class="measure-legend-swatch" style:background="rgb(40, 220, 120)"></span><span>Green — part of an object that will be added</span></div>
      <div class="measure-legend-row"><span class="measure-legend-swatch" style:background="rgb(255, 60, 60)"></span><span>Red — passed the threshold but was filtered out — too small or large, wrong shape, on the edge, or a line where two touching objects were split</span></div>
    </div>
  </Section>
  <div class="measure-cta"><button class="measure-cta-button" disabled={pending||!count} onclick={()=>panel.commitParticles()}>{pending?'Analyzing objects…':!count?'No objects to add':`Add ${count} object${count===1?'':'s'} as ROIs`}</button>
    <div class="measure-cta-caption">{pending?'Applying the size, shape, edge, and splitting settings to the current mask.':!count?viewData.hasMask?'Every object was filtered out. Loosen the size or shape limits above.':'Pick a threshold method above first.':'They become measurable ROIs: the Results table fills in, and each one can be renamed, exported, or measured on another channel.'}</div>
  </div>
{/if}
