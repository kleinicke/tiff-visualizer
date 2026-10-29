<script lang="ts">
  import type { CellsDiscreteRow } from '../../../media/modules/cells/cells-model';
  let { rows, more, onset, onall }: {
    rows: CellsDiscreteRow[]; more: number;
    onset: (label: string, patch: { enabled?: boolean; color?: string }) => void;
    onall: (enabled: boolean) => void;
  } = $props();
</script>
<div class="cells-legend">
  <div class="cells-legend-tools">
    <button class="measure-button" title="Show every category" onclick={() => onall(true)}>All</button>
    <button class="measure-button" title="Hide every category" onclick={() => onall(false)}>None</button>
  </div>
  <div class="cells-legend-list">
    {#each rows as row (row.label)}
      <div class="channel-row-top cells-legend-row" class:dimmed={!row.enabled}>
        <input type="checkbox" checked={row.enabled} title="Show cells in this category" onchange={e => onset(row.label, { enabled: e.currentTarget.checked })}>
        <input type="color" class="channel-swatch" value={row.color} title="Category tint" oninput={e => onset(row.label, { color: e.currentTarget.value })}>
        <span class="channel-name" title={row.label}>{row.label}</span>
        <span class="channel-group-count">{row.count}</span>
      </div>
    {/each}
    {#if more > 0}<div class="measure-note">{more} more categories are not listed.</div>{/if}
  </div>
</div>
