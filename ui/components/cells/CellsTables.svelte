<script lang="ts">
  import type { CellSetModel } from '../../../media/modules/cells/cells-model';
  let { set }: { set: CellSetModel } = $props();
  let text = $state('');
  function add(event: Event) {
    event.preventDefault();
    if (!text.trim()) return;
    set.addTable(text);
    text = '';
  }
</script>
<div class="cells-tables">
  {#each set.tables as table (table.id)}
    <div class="cells-table-row" class:unavailable={table.state === 'missing' || table.state === 'error'} title={table.detail ? `${table.path}\n${table.detail}` : table.path}>
      <span class="cells-source-kind">{table.kind === 'nuclei' ? 'nuclei' : 'table'}</span>
      <span class="cells-source-name plain">{table.name}</span>
      <span class="cells-source-detail">{table.detail}</span>
      {#if table.state === 'available'}<button class="measure-chip" title="Load this file into {set.name}" onclick={() => set.loadTable(table.id)}>Load</button>
      {:else if table.state === 'error'}<button class="measure-chip" title="Try again" onclick={() => set.loadTable(table.id)}>Retry</button>{/if}
      {#if table.origin !== 'native' && (table.state === 'loaded' || table.state === 'error' || table.origin === 'added')}
        <button class="cells-source-remove" title={table.origin === 'added' ? 'Remove this file' : 'Unload this file'} aria-label="Remove {table.name}" onclick={() => set.removeTable(table.id)}>×</button>
      {/if}
    </div>
  {/each}
  <form class="cells-add" onsubmit={add}>
    <input type="text" class="measure-input" bind:value={text} spellcheck="false" aria-label="Path of a table or nucleus boundaries .parquet file for {set.name}" placeholder="Add a table or nuclei (.parquet)"
      title="A table (cell_id plus metrics, merged into {set.name} by cell_id) or nucleus outlines (a nucleus_boundaries.parquet, which replaces the current nuclei). Relative paths start at the workspace folder.">
    <button type="button" class="measure-button" title="Choose a file" onclick={set.browseTable}>Browse…</button>
    <button type="submit" class="measure-button" disabled={!text.trim()}>Add</button>
  </form>
  {#if set.tableMessage}<div class="measure-note cells-source-error">{set.tableMessage}</div>{/if}
</div>
