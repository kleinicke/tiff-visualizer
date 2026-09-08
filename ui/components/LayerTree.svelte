<script lang="ts">
  import { on } from 'svelte/events';
  import LayerAdjustmentEditor from './LayerAdjustment.svelte';
  import type { LayersPanel } from '../../media/modules/layers-panel';
  import { adjustmentLabel, blendModePatch, clippingTarget, type DisplayItem, type GroupDisplayItem } from '../../media/modules/layer-panel-model';
  import { BLEND_MODES, MASK_CONDITIONS, type Layer, type LayerAdjustment } from '../../media/modules/layer-compositor';
  let { host, items }: { host: LayersPanel; items: DisplayItem[] } = $props();
  let renaming = $state<string | null>(null);
  let opacityValues = $state<Record<string, string>>({});
  const filters = [['levels','Levels'],['curves','Curves'],['hue/saturation','Hue/Saturation'],['brightness/contrast','Brightness/Contrast'],['exposure','Exposure / Gamma'],['invert','Invert'],['channel mixer','Channel Mixer'],['color balance','Color Balance'],['black & white','Black & White'],['threshold','Threshold'],['posterize','Posterize'],['gradient map','Gradient Map']];
  function refresh() { host.refresh(); host.onChange(); }
  function patch(id: string, patch: Partial<Layer>) { host.manager.updateLayer(id, patch); refresh(); }
  function toggleGroup(group: GroupDisplayItem) { if (host.collapsedGroups.has(group.key)) host.collapsedGroups.delete(group.key); else host.collapsedGroups.add(group.key); host.refresh(); host.onPersist?.(); }
  function history(node: HTMLElement) { host._bindContinuousHistory(node, () => host.onChange({ settled: true })); }
  function focus(node: HTMLInputElement) { node.focus(); node.select(); }
  function rename(node: HTMLInputElement, layer: Layer) { if (renaming !== layer.id) return; renaming = null; const name = node.value.trim(); if (name && name !== layer.name) { host.manager.updateLayer(layer.id!, { name }); host.onPersist?.(); } host.refresh(); }
  function rowSelection(node: HTMLElement, id: string) { return { destroy: on(node, 'click', event => { if (!event.shiftKey || (event.target as HTMLElement).closest('button, select, input')) return; event.preventDefault(); host._showOnlyLayer(id); }) }; }
  function thumbnail(node: HTMLCanvasElement, params: { layer: Layer; effects: Layer[] }) { host._paintLayerThumbnail(node, params.layer, params.effects); }
  function remove(layer: Layer) {
    const id = layer.id!;
    if (host._pendingRemoveId !== id) {
      host._clearPendingRemove(false); host._pendingRemoveId = id;
      host._pendingRemoveTimer = setTimeout(() => host._clearPendingRemove(true), 1600); host.refresh(); return;
    }
    host._clearPendingRemove(false); if (host.movingLayerId === id) host.movingLayerId = null;
    host.manager.removeLayer(id); refresh();
  }
</script>
{#snippet tree(entries: DisplayItem[], depth: number, nestedEffect = false)}
  {#each entries as item}
    {#if item.kind === 'group'}
      {@const group = item}
      {@const targets = group.group ? [group.group] : group.layers}
      {@const visibleCount = targets.filter(layer => layer.visible !== false).length}
      <div class="layer-group-row" style:--layer-depth={depth} title={group.path.join(' / ')}>
        <button class="layer-group-toggle" title={host.collapsedGroups.has(group.key) ? 'Expand group' : 'Collapse group'} onclick={() => toggleGroup(group)}>{host.collapsedGroups.has(group.key) ? '▸' : '▾'}</button>
        <input type="checkbox" class="layer-visible layer-group-visible" checked={visibleCount === targets.length} indeterminate={visibleCount > 0 && visibleCount < targets.length} title="Toggle all layers in this group (Shift-click to solo; Shift-click again to show all)" onclick={e => { if (!e.shiftKey) return; e.preventDefault(); e.stopPropagation(); host.manager.toggleSoloLayers(new Set([...(group.group ? [group.group] : []), ...group.layers].map(layer => layer.id!))); refresh(); }} onchange={() => { host.manager.beginHistoryGroup(); for (const layer of targets) host.manager.updateLayer(layer.id!, { visible: visibleCount !== targets.length }); host.manager.endHistoryGroup(); refresh(); }}>
        <span class="layer-group-name" role="button" tabindex="0" onclick={() => toggleGroup(group)} onkeydown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGroup(group); } }}>{group.name}</span>
        <span class="layer-group-count">{group.layers.filter(layer => layer.kind !== 'group').length}</span>
        {#if group.group}<div class="layer-group-controls">
          <select class="layer-blend layer-group-blend" title="Group blend mode" value={group.group.blendMode || 'normal'} onchange={e => { host.manager.updateLayer(group.key, { blendMode: e.currentTarget.value }); host.onChange(); }}>{#each BLEND_MODES.filter(mode => !mode.mask) as mode}<option value={mode.id}>{mode.label}</option>{/each}</select>
          <input type="range" class="layer-opacity layer-group-opacity" min="0" max="100" data-default-value="100" value={Math.round((group.group.opacity ?? 1) * 100)} title="Group opacity · Double-click to reset to 100%" use:history oninput={e => { host.manager.updateLayer(group.key, { opacity: Number(e.currentTarget.value) / 100 }); host.onChange({ interactive: true }); }} onchange={e => e.currentTarget.blur()}>
        </div>{/if}
      </div>
      {#if !host.collapsedGroups.has(group.key)}{@render tree(group.items, depth + 1)}{/if}
    {:else}
      {@const layer = item.layer}
      {@const id = layer.id!}
      {@const effects = item.effects || []}
      {@const isAdjustment = layer.kind === 'adjustment' && !!layer.adjustment}
      {@const isBase = item.index === 0 && !host.manager.documentExpanded}
      {@const target = clippingTarget(host.manager.layers, item.index)}
      <div class="layer-row" class:layer-row-base={isBase} class:layer-row-adjustment={isAdjustment} class:layer-row-clipped={layer.clipped} class:layer-row-filter-child={nestedEffect} data-id={id} style:--layer-depth={depth} use:rowSelection={id}>
        <input type="checkbox" class="layer-visible" checked={layer.visible !== false} title={isAdjustment ? 'Toggle filter visibility' : 'Toggle visibility (Shift-click to show only this image; Shift-click again to show all images)'} onclick={e => { if (e.shiftKey) { e.preventDefault(); e.stopPropagation(); host._showOnlyLayer(id); } }} onchange={e => { host.manager.updateLayer(id, { visible: e.currentTarget.checked }); host.onChange(); }}>
        <div class="layer-title-line">
          {#if !isAdjustment && layer.data}<canvas class="layer-thumbnail" width="48" height="48" data-layer-id={id} title="Layer content with its filters applied" use:thumbnail={{ layer, effects: effects.map(effect => effect.layer) }}></canvas>{/if}
          {#if renaming === id}<input class="layer-name-input" value={layer.name || id} use:focus onblur={e => rename(e.currentTarget, layer)} onkeydown={e => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { renaming = null; host.refresh(); } }}>
          {:else}<span class="layer-name" role="button" tabindex="0" title={`${layer.uri || layer.name || id}\nDouble-click to rename · Shift-click to show only`} ondblclick={e => { e.preventDefault(); e.stopPropagation(); renaming = id; }} onkeydown={e => { if (e.key === 'Enter') renaming = id; }}>{layer.name || id}</span>{/if}
          {#if isAdjustment}<span class="layer-adjustment-badge" title="Non-destructive adjustment layer">{adjustmentLabel(layer.adjustment)}</span>{:else}<span class="layer-dimensions">{layer.width}×{layer.height}</span>{/if}
          {#if layer.sourceSupport && layer.sourceSupport !== 'native'}<span class={`layer-support-badge layer-support-${layer.sourceSupport}`} title={`Source compatibility: ${layer.sourceSupport}${layer.sourceBlendMode ? ` · ${layer.sourceBlendMode}` : ''}`}>{layer.sourceSupport === 'approximate' ? '≈' : layer.sourceSupport === 'cached-raster' ? 'cached' : layer.sourceSupport}</span>
          {:else if host.manager.documentExpanded}<span class="layer-support-badge layer-support-native" title="This source layer is represented natively">native</span>{/if}
        </div>
        {#if isBase}<span class="layer-base-tag">base</span>{/if}
        <div class="layer-controls">
          {#if !isAdjustment}<select class="layer-blend" title="Blend mode" value={layer.blendMode || 'normal'} onchange={e => patch(id, blendModePatch(layer, e.currentTarget.value))}>{#each BLEND_MODES as mode}<option value={mode.id}>{mode.label}</option>{/each}</select>{:else}<span class="layer-adjustment-strength-label">Strength</span>{/if}
          <input type="range" class="layer-opacity" min="0" max="100" data-default-value="100" value={Math.round((layer.opacity ?? 1) * 100)} title="Opacity · Double-click to reset to 100%" disabled={layer.blendMode === 'mask'} use:history oninput={e => { opacityValues[id] = e.currentTarget.value; host.manager.updateLayer(id, { opacity: Number(e.currentTarget.value) / 100 }); host.onChange({ interactive: true }); }} onchange={e => { host.manager.updateLayer(id, { opacity: Number(e.currentTarget.value) / 100 }); e.currentTarget.blur(); }} onpointerup={e => e.currentTarget.blur()}>
          <span class="layer-opacity-value">{opacityValues[id] ?? Math.round((layer.opacity ?? 1) * 100)}%</span>
        </div>
        {#snippet clip()}<label class="layer-clipping"><input type="checkbox" checked={!!layer.clipped} title={target ? `Applied only to “${target.name || target.id}”` : 'Clip this layer to the nearest unclipped layer below'} onchange={e => patch(id, { clipped: e.currentTarget.checked })}>{layer.clipped ? ' Clipped' : ' Clip'}</label>{/snippet}
        {#snippet maskBadge()}{#if layer.rasterMask}<span class="layer-mask-badge" title={`${layer.rasterMask.width}×${layer.rasterMask.height} raster mask`}>mask</span>{/if}{/snippet}
        {#if isAdjustment}
          {#if !nestedEffect}<div class="layer-adjustment-scope"><span class="layer-adjustment-target">{layer.clipped ? target ? `Applied to “${target.name || target.id}”` : 'Clipped, but no base layer was found' : 'Applied to the composite below'}</span>{@render clip()}{@render maskBadge()}</div>{/if}
          <LayerAdjustmentEditor {host} {layer} />
        {/if}
        {#if layer.blendMode === 'mask'}
          {@const condition = layer.maskCondition || { op: 'gt', threshold: (layer.typeMax || 1) * 0.5 }}
          <div class="layer-mask"><span class="layer-mask-label">Show layer where mask is</span>
            <select class="layer-mask-op" title="Mask condition" value={condition.op} onchange={e => patch(id, { maskCondition: { ...condition, op: e.currentTarget.value } })}>{#each MASK_CONDITIONS as condition}<option value={condition.id}>{condition.label}</option>{/each}</select>
            <input type="number" step="any" min="0" max={layer.typeMax || 1} class="layer-mask-threshold" value={condition.threshold} title="Threshold" style:display={MASK_CONDITIONS.find(item => item.id === condition.op)?.needsThreshold ? undefined : 'none'} use:history oninput={e => { host.manager.updateLayer(id, { maskCondition: { ...condition, threshold: parseFloat(e.currentTarget.value) } }); host.onChange({ interactive: true }); }}>
          </div>
        {/if}
        {#if !isAdjustment}<div class="layer-position">
          {#each ['X', 'Y'] as axis}{@const key = axis === 'X' ? 'offsetX' : 'offsetY'}<label class="layer-pos-label">{axis}<input type="number" class="layer-offset-input" value={layer[key] ?? 0} title={`${axis} offset`} onchange={e => { const value = parseInt(e.currentTarget.value, 10); if (Number.isFinite(value)) { host.manager.updateLayer(id, { [key]: value }); host.onChange(); } }}></label>{/each}
          <button class="layers-btn layer-move" class:active={host.movingLayerId === id} title="Drag on the image to move this layer" onclick={() => { host.movingLayerId = host.movingLayerId === id ? null : id; host.refresh(); }}>✥</button>
          {#if layer.blendMode !== 'mask'}{@render clip()}{/if}{@render maskBadge()}
        </div>{/if}
        <div class="layer-actions">
          {#if !nestedEffect && !isAdjustment && layer.data}
            <button class="layers-btn layer-filter-toggle-inline" title={host.expandedEffectStacks.has(id) ? 'Hide filters applied to this layer' : 'Show and add filters for this layer'} onclick={() => { if (host.expandedEffectStacks.has(id)) host.expandedEffectStacks.delete(id); else host.expandedEffectStacks.add(id); host.refresh(); }}>{host.expandedEffectStacks.has(id) ? '▾' : '▸'} Filters{effects.length ? ` (${effects.length})` : ''}</button>
            <button class="layers-btn" title="Duplicate this layer with all attached filters" aria-label="Duplicate layer with filters" onclick={() => { const copy = host.manager.duplicateLayerWithAdjustments(id); if (copy && host.expandedEffectStacks.has(id)) host.expandedEffectStacks.add(copy); refresh(); }}>⧉</button>
          {:else if isAdjustment}<button class="layers-btn" title="Copy this filter to an image layer" aria-label="Copy filter to layer" onclick={e => { e.stopPropagation(); host._openFilterCopyMenu(layer, id, e.currentTarget); }}>⧉</button>{/if}
          <button class="layers-btn" title="Move layer up" onclick={() => { host.manager.reorderLayer(id, item.index + 1); refresh(); }}>▲</button>
          <button class="layers-btn" title="Move layer down" onclick={() => { host.manager.reorderLayer(id, item.index - 1); refresh(); }}>▼</button>
          <button class="layers-btn layer-remove" class:pending={host._pendingRemoveId === id} title={host._pendingRemoveId === id ? 'Click again to remove this layer' : 'Remove layer'} onclick={() => remove(layer)}>{host._pendingRemoveId === id ? 'again' : '🗑'}</button>
        </div>
      </div>
      {#if !isAdjustment && layer.data && host.expandedEffectStacks.has(id)}
        <div class="layer-filter-shelf expanded" style:--layer-depth={depth}><select class="layer-add-filter" title="Add a non-destructive filter to this layer" onchange={e => { const value = e.currentTarget.value; if (!value) return; const created = host.manager.addAdjustmentLayer(id, value as LayerAdjustment['type']); if (created) host.expandedAdjustments.add(created); refresh(); }}><option value="">+ Add filter…</option>{#each filters as [value,label]}<option {value}>{label}</option>{/each}</select></div>
        {@render tree([...effects].reverse(), depth + 1, true)}
      {/if}
    {/if}
  {/each}
{/snippet}
{@render tree(items, 0)}
