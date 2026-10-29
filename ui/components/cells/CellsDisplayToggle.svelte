<script lang="ts">
  import type { CellShow } from '../../../media/modules/cells/cell-style';
  let { show, hasNuclei, onchange }: { show: CellShow; hasNuclei: boolean; onchange: (show: CellShow) => void } = $props();
  const options: { value: CellShow; label: string; needsNuclei: boolean; title: string }[] = [
    { value: 'cells', label: 'Cells', needsNuclei: false, title: 'Draw cell outlines' },
    { value: 'nucleus', label: 'Nucleus', needsNuclei: true, title: 'Draw nucleus outlines' },
    { value: 'both', label: 'Both', needsNuclei: true, title: 'Cells filled by the metric, with nucleus outlines on top' },
    { value: 'none', label: 'None', needsNuclei: false, title: 'Hide the outlines' },
  ];
</script>
<div class="cells-toggle" role="group" aria-label="Which outlines to draw">
  {#each options as option (option.value)}
    <button class="measure-chip" class:active={show === option.value} aria-pressed={show === option.value}
      disabled={option.needsNuclei && !hasNuclei} title={option.needsNuclei && !hasNuclei ? 'This bundle has no nucleus outlines' : option.title}
      onclick={() => onchange(option.value)}>{option.label}</button>
  {/each}
</div>
