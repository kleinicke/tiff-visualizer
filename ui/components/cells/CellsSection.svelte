<script lang="ts">
  import type { CellsModel } from '../../../media/modules/cells/cells-model';
  import CellsContinuousControls from './CellsContinuousControls.svelte';
  import CellsDiscreteLegend from './CellsDiscreteLegend.svelte';
  import CellsDisplayToggle from './CellsDisplayToggle.svelte';
  import CellsSelection from './CellsSelection.svelte';
  import CellsSources from './CellsSources.svelte';
  let { cells }: { cells: CellsModel } = $props();
  let open = $state(true);
  const discreteMetrics = $derived(cells.metrics.filter(metric => metric.kind === 'discrete'));
  const continuousMetrics = $derived(cells.metrics.filter(metric => metric.kind === 'continuous'));
</script>
<section class="cells-section">
  <div class="cells-header">
    <button class="channel-fold" aria-expanded={open} title={open ? 'Collapse the Cells section' : 'Expand the Cells section'} onclick={() => (open = !open)}>{open ? '▾' : '▸'}</button>
    <div class="cells-title">Cells</div><div class="channels-spacer"></div>
    {#if cells.count > 0}<span class="channel-group-count">{cells.count.toLocaleString()}</span>{/if}
  </div>
  {#if open}
    <div class="cells-body">
      <CellsSources {cells} />
      {#if cells.status}<div class="measure-note">{cells.status}</div>
      {:else}
        <CellsDisplayToggle show={cells.show} hasNuclei={cells.hasNuclei} onchange={cells.setShow} />
        <label class="cells-field">
          <span>Colour by</span>
          <select class="measure-select" value={cells.metric ?? ''} title="Table column that sets the fill colour" onchange={e => cells.setMetric(e.currentTarget.value || null)}>
            <option value="">None (outline only)</option>
            {#if discreteMetrics.length}<optgroup label="Categories">{#each discreteMetrics as metric (metric.name)}<option value={metric.name}>{metric.name}</option>{/each}</optgroup>{/if}
            {#if continuousMetrics.length}<optgroup label="Numbers">{#each continuousMetrics as metric (metric.name)}<option value={metric.name}>{metric.name}</option>{/each}</optgroup>{/if}
          </select>
        </label>
        {#if cells.discrete}<CellsDiscreteLegend rows={cells.discrete.rows} more={cells.discrete.more} onset={cells.setCategory} onall={cells.setAllCategories} />{/if}
        {#if cells.continuous}<CellsContinuousControls range={cells.continuous} onrange={cells.setRange} oncolormap={cells.setColormap} />{/if}
        {#if cells.metric}
          <label class="cells-field">
            <span>Fill opacity</span>
            <input type="range" min="0" max="100" class="channel-slider" value={Math.round(cells.opacity * 100)} oninput={e => cells.setOpacity(Number(e.currentTarget.value) / 100)}>
          </label>
        {/if}
        {#if cells.selection}<CellsSelection selection={cells.selection} onclear={cells.clearSelection} />
        {:else}<div class="measure-note">Click a cell to see its measurements. Shift-click adds to the selection.</div>{/if}
      {/if}
    </div>
  {/if}
</section>
