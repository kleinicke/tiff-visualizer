<script lang="ts">
  import type { CellSetModel } from '../../../media/modules/cells/cells-model';
  import CellsContinuousControls from './CellsContinuousControls.svelte';
  import CellsDiscreteLegend from './CellsDiscreteLegend.svelte';
  import CellsDisplayToggle from './CellsDisplayToggle.svelte';
  import CellsSelection from './CellsSelection.svelte';
  import CellsTables from './CellsTables.svelte';
  let { set }: { set: CellSetModel } = $props();
  let open = $state(true);
  const view = $derived(set.view);
  const discreteMetrics = $derived(view.metrics.filter(metric => metric.kind === 'discrete'));
  const continuousMetrics = $derived(view.metrics.filter(metric => metric.kind === 'continuous'));
</script>
<div class="cell-set" class:dimmed={!set.visible}>
  <div class="cell-set-top" title={set.path}>
    <button class="channel-fold" aria-expanded={open} title={open ? 'Hide this cell set\'s controls' : 'Show this cell set\'s controls'} onclick={() => (open = !open)}>{open ? '▾' : '▸'}</button>
    <input type="checkbox" checked={set.visible} title="Show these cells" onchange={e => set.setVisible(e.currentTarget.checked)}>
    <input type="color" class="channel-swatch" value={set.color} title="Outline colour" oninput={e => set.setColor(e.currentTarget.value)}>
    <span class="channel-name">{set.name}</span>
    <span class="channel-group-count">{set.count.toLocaleString()}</span>
    {#if set.origin !== 'native'}<button class="cells-source-remove" title="Remove this cell set" aria-label="Remove {set.name}" onclick={set.remove}>×</button>{/if}
  </div>
  {#if open}
    <div class="cell-set-body">
      <CellsTables {set} />
      <CellsDisplayToggle show={view.show} hasNuclei={view.hasNuclei} onchange={view.setShow} />
      <label class="cells-field">
        <span>Colour by</span>
        <select class="measure-select" value={view.metric ?? ''} title="Table column that sets the fill colour" onchange={e => view.setMetric(e.currentTarget.value || null)}>
          <option value="">None (outline only)</option>
          {#if discreteMetrics.length}<optgroup label="Categories">{#each discreteMetrics as metric (metric.name)}<option value={metric.name}>{metric.name}</option>{/each}</optgroup>{/if}
          {#if continuousMetrics.length}<optgroup label="Numbers">{#each continuousMetrics as metric (metric.name)}<option value={metric.name}>{metric.name}</option>{/each}</optgroup>{/if}
        </select>
      </label>
      {#if view.discrete}<CellsDiscreteLegend rows={view.discrete.rows} more={view.discrete.more} onset={view.setCategory} onall={view.setAllCategories} />{/if}
      {#if view.continuous}<CellsContinuousControls range={view.continuous} onrange={view.setRange} oncolormap={view.setColormap} />{/if}
      {#if view.metric}
        <label class="cells-field">
          <span>Fill opacity</span>
          <input type="range" min="0" max="100" class="channel-slider" value={Math.round(view.opacity * 100)} oninput={e => view.setOpacity(Number(e.currentTarget.value) / 100)}>
        </label>
      {/if}
      {#if view.selection}<CellsSelection selection={view.selection} onclear={view.clearSelection} />{/if}
    </div>
  {/if}
</div>
