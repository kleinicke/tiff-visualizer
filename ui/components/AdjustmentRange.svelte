<script lang="ts">
  import type { AdjustmentField } from '../layer-adjustment-fields';
  import type { LayersPanel } from '../../media/modules/layers-panel';
  let { field, host }: { field: AdjustmentField; host: LayersPanel } = $props();
  function history(node: HTMLInputElement) { host._bindContinuousHistory(node, () => host.onChange({ settled: true })); }
</script>
<label class="layer-adjustment-range"><span>{field.label}</span>
  <input type="range" min={field.min} max={field.max} step={field.step} value={field.value} data-default-value={field.defaultValue} title={`${field.label} · Double-click to reset`} use:history oninput={e => field.change(Number(e.currentTarget.value))}>
  <output>{field.value.toFixed(field.decimals)}{field.suffix}</output>
</label>
