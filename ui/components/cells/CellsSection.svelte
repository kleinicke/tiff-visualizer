<script lang="ts">
  import type { CellsPanelModel } from '../../../media/modules/cells/cells-model';
  import CellSet from './CellSet.svelte';
  let { cells }: { cells: CellsPanelModel } = $props();
  let open = $state(true);
  let text = $state('');
  function add(event: Event) {
    event.preventDefault();
    if (!text.trim()) return;
    cells.addSource(text);
    text = '';
  }
</script>
<section class="cells-section">
  <div class="cells-header">
    <button class="channel-fold" aria-expanded={open} title={open ? 'Collapse the Cells section' : 'Expand the Cells section'} onclick={() => (open = !open)}>{open ? '▾' : '▸'}</button>
    <div class="cells-title">Cells</div><div class="channels-spacer"></div>
    {#if cells.sets.length === 1}<span class="channel-group-count">{cells.sets[0].count.toLocaleString()}</span>
    {:else if cells.sets.length > 1}<span class="channel-group-count">{cells.sets.length} sets</span>{/if}
  </div>
  {#if open}
    <div class="cells-body">
      {#if cells.status && cells.sets.length === 0}<div class="measure-note">{cells.status}</div>{/if}
      {#each cells.sets as set (set.id)}<CellSet {set} />{/each}
      {#if cells.sets.length === 0 && !cells.status}<div class="measure-note">No cells are loaded. Add a cell_boundaries.parquet below.</div>{/if}
      {#each cells.pending as row (row.id)}
        <div class="cells-table-row" class:unavailable={row.state === 'missing' || row.state === 'error'} title={row.detail ? `${row.path}\n${row.detail}` : row.path}>
          <span class="cells-source-kind">cells</span>
          <span class="cells-source-name plain">{row.name}</span>
          <span class="cells-source-detail">{row.detail}</span>
          {#if row.state === 'available'}<button class="measure-chip" title="Load this segmentation" onclick={() => cells.loadSource(row.id)}>Load</button>
          {:else if row.state === 'error'}<button class="measure-chip" title="Try again" onclick={() => cells.loadSource(row.id)}>Retry</button>{/if}
          {#if row.origin === 'added'}<button class="cells-source-remove" title="Remove from the list" aria-label="Remove {row.name}" onclick={() => cells.removeSource(row.id)}>×</button>{/if}
        </div>
      {/each}
      <form class="cells-add" onsubmit={add}>
        <input type="text" class="measure-input" bind:value={text} spellcheck="false" aria-label="Path of a cell boundaries .parquet file" placeholder="Add cells (cell_boundaries.parquet)"
          title="A Xenium-style cell_boundaries.parquet (cell_id, vertex_x, vertex_y in microns), shown as another cell set. Relative paths start at the workspace folder.">
        <button type="button" class="measure-button" title="Choose a file" onclick={cells.browseSource}>Browse…</button>
        <button type="submit" class="measure-button" disabled={!text.trim()}>Add</button>
      </form>
      {#if cells.sourceMessage}<div class="measure-note cells-source-error">{cells.sourceMessage}</div>{/if}
    </div>
  {/if}
</section>
