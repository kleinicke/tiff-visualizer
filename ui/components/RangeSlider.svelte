<script lang="ts">
  let { min, max, low, high, histogram = null, readout = '', lowTitle = 'Lower limit', highTitle = 'Upper limit', onchange }: {
    min: number;
    max: number;
    low: number;
    high: number;
    histogram?: number[] | null;
    readout?: string;
    lowTitle?: string;
    highTitle?: string;
    onchange: (low: number, high: number, interactive: boolean) => void;
  } = $props();
  let log = $state(true);
  let track: HTMLDivElement;
  let dragging = $state<'low' | 'high' | 'pending' | null>(null);
  const span = $derived(max - min || 1);
  const fraction = (value: number) => Math.max(0, Math.min(1, (value - min) / span));
  const lowAt = $derived(fraction(low));
  const highAt = $derived(fraction(high));
  const peak = $derived(Math.max(1, ...(histogram ?? [])));
  const height = (count: number) => (log ? Math.log1p(count) / Math.log1p(peak) : count / peak) * 28;
  function valueAt(event: PointerEvent): number {
    const box = track.getBoundingClientRect();
    return min + Math.max(0, Math.min(1, (event.clientX - box.left) / (box.width || 1))) * span;
  }
  function move(value: number, interactive: boolean) {
    if (dragging === 'low') onchange(Math.min(value, high), high, interactive);
    else if (dragging === 'high') onchange(low, Math.max(value, low), interactive);
  }
  function down(event: PointerEvent) {
    if (event.button !== 0) return;
    const box = track.getBoundingClientRect();
    const value = valueAt(event);
    const toLow = Math.abs(event.clientX - (box.left + lowAt * box.width));
    const toHigh = Math.abs(event.clientX - (box.left + highAt * box.width));
    dragging = Math.abs(toLow - toHigh) < 1 ? (low === high ? 'pending' : value < low ? 'low' : 'high') : toLow < toHigh ? 'low' : 'high';
    track.setPointerCapture(event.pointerId);
    if (dragging !== 'pending') move(value, true);
    event.preventDefault();
  }
  function drag(event: PointerEvent) {
    if (!dragging) return;
    const value = valueAt(event);
    if (dragging === 'pending') { if (value === low) return; dragging = value < low ? 'low' : 'high'; }
    move(value, true);
  }
  function up(event: PointerEvent) {
    if (!dragging) return;
    if (dragging !== 'pending') move(valueAt(event), false);
    dragging = null;
  }
  function key(event: KeyboardEvent, which: 'low' | 'high') {
    const step = (event.shiftKey ? 0.1 : 0.01) * span;
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? step : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -step : 0;
    if (!delta) return;
    event.preventDefault();
    const clamp = (value: number) => Math.max(min, Math.min(max, value));
    if (which === 'low') onchange(Math.min(clamp(low + delta), high), high, false);
    else onchange(low, Math.max(clamp(high + delta), low), false);
  }
</script>
<div class="range-slider">
  <div class="range-body">
    {#if histogram && histogram.length}
      <svg class="range-histogram" viewBox="0 0 {histogram.length} 28" preserveAspectRatio="none" aria-hidden="true">
        {#each histogram as count, bin (bin)}
          {@const centre = (bin + 0.5) / histogram.length}
          <rect x={bin} y={28 - height(count)} width="1" height={height(count)} fill="currentColor" opacity={centre >= lowAt && centre <= highAt ? 0.9 : 0.3} />
        {/each}
      </svg>
    {/if}
    <div class="range-track" bind:this={track} role="presentation" onpointerdown={down} onpointermove={drag} onpointerup={up} onpointercancel={up}>
      <div class="range-rail"></div>
      <div class="range-fill" style:left="{lowAt * 100}%" style:width="{(highAt - lowAt) * 100}%"></div>
      <div class="range-handle" class:active={dragging === 'low'} role="slider" tabindex="0" title={lowTitle} aria-label={lowTitle} aria-valuemin={min} aria-valuemax={max} aria-valuenow={low}
        style:left="{lowAt * 100}%" onkeydown={e => key(e, 'low')}></div>
      <div class="range-handle" class:active={dragging === 'high'} role="slider" tabindex="0" title={highTitle} aria-label={highTitle} aria-valuemin={min} aria-valuemax={max} aria-valuenow={high}
        style:left="{highAt * 100}%" onkeydown={e => key(e, 'high')}></div>
    </div>
  </div>
  <div class="range-foot">
    <span class="range-readout">{readout}</span>
    {#if histogram && histogram.length}
      <button class="measure-chip range-log" class:active={log} aria-pressed={log} title="Plot the histogram counts on a log scale" onclick={() => (log = !log)}>Log</button>
    {/if}
  </div>
</div>
