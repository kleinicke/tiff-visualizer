<script lang="ts">
  import type { Writable } from 'svelte/store';
  import type { MeasureModel, MeasureTab } from '../../media/modules/measure-panel';
  import { panelGestures } from '../panel-gestures';
  import MeasureTools from './MeasureTools.svelte';
  import MeasureRois from './MeasureRois.svelte';
  import MeasureScale from './MeasureScale.svelte';
  import MeasureResults from './MeasureResults.svelte';
  import MeasureSegment from './MeasureSegment.svelte';
  let { model }: { model: Writable<MeasureModel> } = $props();
  const tabs: [MeasureTab,string][] = [['tools','Tools'],['rois','ROIs'],['results','Results'],['segment','Segment'],['setup','Scale']];
</script>
<div class="measure-panel" style:display="none" bind:this={$model.panel.overlayRoot} use:panelGestures={'measure-header'}>
  <div class="measure-header" style:cursor="move"><div class="measure-title">Measure</div><div class="measure-spacer"></div>
    <button class="measure-chip" bind:this={$model.panel.maskToggle} title="Show the threshold over the image (M)" onclick={() => { $model.panel.showMaskOverlay = !$model.panel.showMaskOverlay; $model.panel.refreshMaskOverlay(); $model.panel.syncHeaderToggles(); }}>Mask</button>
    <button class="measure-chip" bind:this={$model.panel.roiToggle} title="Show the ROI outlines (O). Hiding them does not delete anything." onclick={() => { const overlay = $model.panel.host.overlay; overlay.setShowRois(!overlay.getShowRois()); $model.panel.syncHeaderToggles(); }}>ROIs</button>
    <button class="measure-close" title="Close the measure panel" onclick={() => $model.panel.hide()}>×</button>
  </div>
  <div class="measure-tabs">{#each tabs as [id,label]}<button class="measure-tab" class:active={$model.tab === id} onclick={() => $model.panel.setTab(id)}>{label}</button>{/each}</div>
  <div class="measure-body" bind:this={$model.panel.body}>
    {#key $model.revision}
      {#if $model.tab === 'tools'}<MeasureTools panel={$model.panel} />
      {:else if $model.tab === 'rois'}<MeasureRois panel={$model.panel} />
      {:else if $model.tab === 'setup'}<MeasureScale panel={$model.panel} />
      {:else if $model.tab === 'results'}<MeasureResults panel={$model.panel} />
      {:else}<MeasureSegment panel={$model.panel} />{/if}
    {/key}
  </div>
  <div class="measure-hint" bind:this={$model.panel.hintLine}></div>
</div>
