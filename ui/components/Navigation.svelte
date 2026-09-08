<script lang="ts">
  import type { Writable } from 'svelte/store';
  import type { NavigationModel } from '../navigation-model';
  import NavigationRow from './NavigationRow.svelte';
  let { model }: { model: Writable<NavigationModel> } = $props();
  function ready(node: HTMLDivElement) { $model.ready(node); }
</script>
<div class="dataset-overlay nav-overlay" class:dataset-overlay--readonly={$model.controls.length === 0 && !$model.note} class:dataset-overlay--resolution={!!$model.resolution} class:dataset-overlay--loading={$model.loading} style:display="none" use:ready>
  <div class="dataset-title" role="button" tabindex="0" aria-expanded="true" onkeydown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); $model.toggle(); } }}><span class="dataset-title-label">{$model.title}</span></div>
  <div class="dataset-resolution" hidden={!$model.resolution} title={$model.resolution?.description} aria-label={$model.resolution ? `Automatic resolution. Preview ${$model.resolution.preview}. ${$model.resolution.detail ? `Loaded detail ${$model.resolution.detail}.` : ''} ${$model.resolution.description}` : undefined}>
    <span>Preview <b data-resolution="preview">{$model.resolution?.preview}</b></span>
    <span class="dataset-detail" class:dataset-detail--empty={!$model.resolution?.detail}>Detail <b data-resolution="detail">{$model.resolution?.detail || '—'}</b></span>
  </div>
  <div class="dataset-axis-controls">
    {#each $model.controls as spec, index (spec.key)}
      <NavigationRow {spec} hint={$model.hints[index] || ''} held={$model.held} hold={$model.hold} />
    {/each}
  </div>
  <div class="dataset-note" hidden={!$model.note}>{$model.note}</div>
</div>
