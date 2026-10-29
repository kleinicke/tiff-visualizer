<script lang="ts">
  import type { CellsModel } from '../../../media/modules/cells/cells-model';
  let { selection, onclear }: { selection: NonNullable<CellsModel['selection']>; onclear: () => void } = $props();
</script>
<div class="cells-selection">
  <div class="cells-selection-head">
    <span class="channel-name" title={selection.title}>Selected: {selection.title}</span>
    <button class="measure-chip" title="Clear the selection (Esc)" onclick={onclear}>Clear</button>
  </div>
  <div class="cells-kv-list">
    {#each selection.rows as row (row.label)}
      <div class="cells-kv"><span class="cells-kv-label" title={row.label}>{row.label}</span><span class="cells-kv-value" title={row.value}>{row.value}</span></div>
    {/each}
  </div>
</div>
