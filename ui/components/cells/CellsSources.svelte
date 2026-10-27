<script lang="ts">
  import type { CellsModel } from '../../../media/modules/cells/cells-model';
  let { cells }: { cells: CellsModel } = $props();
  let text = $state('');
  function add(event: Event) {
    event.preventDefault();
    if (!text.trim()) return;
    cells.addSource(text);
    text = '';
  }
</script>
<div class="cells-sources">
  <form class="cells-add" onsubmit={add}>
    <input type="text" class="measure-input" bind:value={text} spellcheck="false" aria-label="Path of a cells .parquet file"
      placeholder="Path to a .parquet file"
      title="A cell table (cell_id plus metrics, merged into the active segmentation) or a cell_boundaries.parquet (a new segmentation). Relative paths start at the workspace folder.">
    <button type="button" class="measure-button" title="Choose a file" onclick={cells.browseSource}>Browse…</button>
    <button type="submit" class="measure-button" disabled={!text.trim()}>Add</button>
  </form>
  {#if cells.sourceMessage}<div class="measure-note cells-source-error">{cells.sourceMessage}</div>{/if}
  {#if cells.sources.length}
    <ul class="cells-source-list">
      {#each cells.sources as row (row.id)}
        <li class="cells-source" class:active={row.active} class:table={row.kind === 'table'} class:unavailable={row.state === 'missing' || row.state === 'error'} title={row.detail ? `${row.path}\n${row.detail}` : row.path}>
          {#if row.kind === 'segmentation' && row.state === 'loaded'}
            <input type="checkbox" checked={row.visible} title="Show this segmentation" onchange={e => cells.showSource(row.id, e.currentTarget.checked)}>
            <input type="color" class="cells-source-swatch" value={row.color} title="Outline colour" oninput={e => cells.colorSource(row.id, e.currentTarget.value)}>
            <button class="cells-source-name" aria-pressed={row.active} title="Use this segmentation for Colour by and measurements" onclick={() => cells.activateSource(row.id)}>{row.name}</button>
          {:else}
            <span class="cells-source-kind">{row.kind === 'table' ? 'table' : 'cells'}</span>
            <span class="cells-source-name plain">{row.name}</span>
          {/if}
          <span class="cells-source-detail">{row.detail}</span>
          {#if row.state === 'available'}
            <button class="measure-chip" title="Load this file" onclick={() => cells.loadSource(row.id)}>Load</button>
          {:else if row.state === 'error'}
            <button class="measure-chip" title="Try again" onclick={() => cells.loadSource(row.id)}>Retry</button>
          {/if}
          {#if row.origin !== 'native' && row.state !== 'missing' && (row.state === 'loaded' || row.origin === 'added' || row.state === 'error')}
            <button class="cells-source-remove" title={row.origin === 'added' ? 'Remove from the list' : 'Unload'} aria-label="Remove {row.name}" onclick={() => cells.removeSource(row.id)}>×</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
