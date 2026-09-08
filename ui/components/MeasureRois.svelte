<script lang="ts">
  import type { MeasurePanel } from '../../media/modules/measure-panel';
  import Section from './MeasureSection.svelte';
  let { panel }: { panel: MeasurePanel } = $props();
  const manager = $derived(panel.host.manager);
</script>
<Section title={`ROIs (${manager.count()})`}>
  {#if !manager.count()}<div class="measure-note">No ROIs yet. Pick a tool and draw on the image, or import an ImageJ ROI set below.</div>
  {:else}<div class="measure-roi-list">{#each manager.list() as roi}
    <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events (The name input and delete button remain keyboard accessible.) -->
    <div class="measure-roi-row" class:selected={manager.isSelected(roi.id)} onmouseenter={() => panel.host.overlay.setHoveredRoi(roi.id)} onmouseleave={() => panel.host.overlay.setHoveredRoi(null)} onclick={event => { if ((event.target as HTMLElement).tagName !== 'INPUT') panel.selectRoi(roi.id, event); }}>
      <span class="measure-roi-swatch" style:background={roi.color || '#ffd400'}></span>
      <input class="measure-roi-name" aria-label="ROI name" value={roi.name} onchange={e => manager.rename(roi.id, e.currentTarget.value.trim() || roi.name)} onkeydown={e => e.stopPropagation()}>
      <span class="measure-roi-kind">{roi.kind}</span><button class="measure-roi-remove" title="Delete this ROI" onclick={e => { e.stopPropagation(); manager.remove([roi.id]); }}>×</button>
    </div>
  {/each}</div>{/if}
</Section>
<Section title="Edit"><div class="measure-button-row">
  <button class="measure-button" disabled={!manager.canUndo()} onclick={() => manager.undo()}>Undo</button><button class="measure-button" disabled={!manager.canRedo()} onclick={() => manager.redo()}>Redo</button>
  <button class="measure-button" disabled={!manager.selectedIds().length} onclick={() => manager.remove(manager.selectedIds())}>Delete selected</button>
  <button class="measure-button" disabled={!manager.count()} onclick={() => manager.renumber()}>Renumber</button><button class="measure-button" disabled={!manager.count()} onclick={() => manager.clear()}>Clear all</button>
</div></Section>
<Section title="Store and exchange"><div class="measure-button-row">
  <button class="measure-button" disabled={!manager.count()} onclick={() => panel.saveSidecar()}>Save ROIs</button><button class="measure-button" onclick={() => panel.host.requestImport('sidecar')}>Load ROIs</button>
  <button class="measure-button" onclick={() => panel.host.requestImport('imagej')}>Import ImageJ…</button><button class="measure-button" disabled={!manager.count()} onclick={() => panel.exportImageJ()}>Export ImageJ</button>
</div><div class="measure-note">ROIs are saved as a readable JSON file next to the image, so they diff in review and can be edited by hand. ImageJ .roi / RoiSet.zip is supported for exchange.</div></Section>
