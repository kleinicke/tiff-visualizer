<script lang="ts">
  import RangeSlider from '../RangeSlider.svelte';
  import type { CellsModel } from '../../../media/modules/cells/cells-model';
  let { range, onrange, oncolormap }: {
    range: NonNullable<CellsModel['continuous']>;
    onrange: (low: number, high: number) => void;
    oncolormap: (name: string) => void;
  } = $props();
  function short(value: number): string {
    if (!Number.isFinite(value)) return '—';
    const magnitude = Math.abs(value);
    if (magnitude !== 0 && (magnitude < 0.01 || magnitude >= 100000)) return value.toExponential(2);
    return String(Math.round(value * 100) / 100);
  }
</script>
<div class="cells-continuous">
  <RangeSlider min={range.min} max={range.max} low={range.low} high={range.high} histogram={range.histogram}
    readout="{short(range.low)} – {short(range.high)}  (data {short(range.min)} – {short(range.max)})"
    lowTitle="Lowest value that gets the first colour" highTitle="Highest value that gets the last colour"
    onchange={(low, high) => onrange(low, high)} />
  <select class="measure-select cells-colormap" title="Colormap for the fill" value={range.colormap} onchange={e => oncolormap(e.currentTarget.value)}>
    {#each range.colormaps as name (name)}<option value={name}>{name}</option>{/each}
  </select>
</div>
