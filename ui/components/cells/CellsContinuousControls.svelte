<script lang="ts">
  import type { CellsModel } from '../../../media/modules/cells/cells-model';
  let { range, onrange, oncolormap }: {
    range: NonNullable<CellsModel['continuous']>;
    onrange: (low: number, high: number) => void;
    oncolormap: (name: string) => void;
  } = $props();
  const span = $derived(range.max - range.min || 1);
  const position = (value: number) => Math.round((value - range.min) / span * 1000);
  const valueAt = (slider: string) => range.min + Number(slider) / 1000 * span;
  const peak = $derived(Math.max(1, ...range.histogram));
  function short(value: number): string {
    if (!Number.isFinite(value)) return '—';
    const magnitude = Math.abs(value);
    if (magnitude !== 0 && (magnitude < 0.01 || magnitude >= 100000)) return value.toExponential(2);
    return String(Math.round(value * 100) / 100);
  }
</script>
<div class="cells-continuous">
  <svg class="cells-histogram" viewBox="0 0 {range.histogram.length} 20" preserveAspectRatio="none" aria-hidden="true">
    {#each range.histogram as count, bin (bin)}
      <rect x={bin} y={20 - Math.sqrt(count / peak) * 20} width="0.9" height={Math.sqrt(count / peak) * 20} fill="currentColor" />
    {/each}
  </svg>
  <div class="channel-range">
    <input type="range" min="0" max="1000" step="1" class="channel-slider" title="Lowest value that gets the first colour"
      value={position(range.low)} oninput={e => onrange(valueAt(e.currentTarget.value), range.high)}>
    <input type="range" min="0" max="1000" step="1" class="channel-slider" title="Highest value that gets the last colour"
      value={position(range.high)} oninput={e => onrange(range.low, valueAt(e.currentTarget.value))}>
  </div>
  <div class="channel-readout">{short(range.low)} – {short(range.high)}  (data {short(range.min)} – {short(range.max)})</div>
  <select class="measure-select cells-colormap" title="Colormap for the fill" value={range.colormap} onchange={e => oncolormap(e.currentTarget.value)}>
    {#each range.colormaps as name (name)}<option value={name}>{name}</option>{/each}
  </select>
</div>
