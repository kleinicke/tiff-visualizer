<script lang="ts">
  import type { Writable } from 'svelte/store';
  import type { LayersModel } from '../../media/modules/layers-panel';
  import type { LayerCompositorBackendSelection } from '../../media/modules/layer-compositor-worker-client';
  import LayerTree from './LayerTree.svelte';
  import { panelGestures } from '../panel-gestures';
  let { model }: { model: Writable<LayersModel> } = $props();
  const host = $derived($model.host);
</script>
<div class="layers-panel" hidden bind:this={host.root} use:panelGestures={'no-drag-header'}>
  <div class="layers-panel-header">
    <span class="layers-panel-title" bind:this={host.titleEl}>Layers</span>
    <select class="layers-compositor-select" title="Strict layer compositor: unsupported features fail instead of falling back" value={host.compositorBackend} bind:this={host.compositorSelect} onchange={e => { host.compositorBackend = e.currentTarget.value as LayerCompositorBackendSelection; host.onCompositorBackendChange?.(host.compositorBackend); }}>
      {#each [['auto', 'Auto'], ['webgpu', 'WebGPU'], ['gpu', 'WebGL'], ['wasm', 'Wasm'], ['javascript', 'JS (diagnostic)']] as [value, label]}<option {value}>{label}</option>{/each}
    </select>
    <button class="layers-btn layers-add" title="Add image(s) as layers" onclick={() => host.onAddLayer?.()}>+</button>
    <button class="layers-btn layers-export" title="Export as PNG, ORA, XCF, KRA, or PSD" onclick={() => host.onExport?.()}>Export…</button>
    <button class="layers-btn layers-groups" title="Collapse or expand all document groups" bind:this={host.groupsBtn} onclick={() => host.toggleGroups()}>▦</button>
    <button class="layers-btn layers-minimize" title="Minimize / expand panel" bind:this={host.minimizeBtn} onclick={() => host.toggleCollapsed()}>–</button>
    {#if host.closable}<button class="layers-btn layers-close" title="Close panel" onclick={() => host.hide()}>×</button>{/if}
  </div>
  <div class="layers-list" bind:this={host.listEl}>
    {#key $model.revision}<LayerTree {host} items={$model.tree} />{/key}
    <label class="layers-background" bind:this={host.backgroundEl}><span>Background</span>
      <input type="range" class="layers-background-slider" min="0" max="100" step="1" data-default-value={host.themeBackgroundBrightness} value={host.backgroundBrightness ?? host.themeBackgroundBrightness} bind:this={host.backgroundSlider} title="Preview background: darker to lighter while retaining the theme tint · Double-click to restore the VS Code theme background" oninput={e => { host.backgroundBrightness = Number(e.currentTarget.value); host.onBackgroundChange?.(host.backgroundBrightness); }} ondblclick={e => { e.preventDefault(); e.stopPropagation(); host.backgroundBrightness = null; e.currentTarget.value = String(host.themeBackgroundBrightness); host.onBackgroundChange?.(null); }}>
    </label>
  </div>
</div>
