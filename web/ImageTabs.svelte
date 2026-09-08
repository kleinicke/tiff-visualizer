<script lang="ts">
  import type { Writable } from 'svelte/store';
  let { model }: { model: Writable<{ entries: { name: string; title: string }[]; index: number; overview: boolean; select: (index: number) => void; close: (index: number) => void }> } = $props();
</script>
{#each $model.entries as entry, index}
  <div class="web-image-tab" data-active={!$model.overview && index === $model.index}>
    <button type="button" class="web-image-tab-select" data-image-index={index} title={entry.title} role="tab" aria-selected={!$model.overview && index === $model.index} tabindex={index === $model.index ? 0 : -1} onclick={() => $model.select(index)}>{entry.name}</button>
    <button type="button" class="web-image-tab-close" data-close-image-index={index} aria-label={`Close ${entry.name}`} onclick={() => $model.close(index)}>×</button>
  </div>
{/each}
