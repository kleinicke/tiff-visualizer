<script lang="ts">
  import type { Writable } from 'svelte/store';
  import type { HistogramUi } from '../../media/modules/histogram-overlay';
  import { panelGestures } from '../panel-gestures';
  let { model }: { model: Writable<HistogramUi> } = $props();
  const host = $derived($model.host);
</script>
<div class="histogram-overlay" style:display="none" bind:this={host.overlay} use:panelGestures={{ headerClass: 'histogram-header', onDragEnd: () => { const position = host.getPosition(); if (position) host.vscode.postMessage({ type: 'histogramPositionChanged', position }); } }}>
  <div class="histogram-header" style:cursor="move">
    <div class="histogram-title">Histogram</div>
    <button class="histogram-button" title="Toggle Linear/Sqrt scale" onclick={e => host.toggleScaleMode(e.currentTarget)}>Sqrt Mode</button>
    <button class="histogram-close" title="Close histogram" onclick={() => host.hide()}>×</button>
  </div>
  <canvas class="histogram-canvas" width="300" height="150" bind:this={host.canvas} onmousemove={e => host.handleMouseMove(e)} onmouseleave={() => host.handleMouseLeave()}></canvas>
  <div class="histogram-labels" style="display:flex;justify-content:space-between;font-size:10px;color:#cccccc">
    <span bind:this={host.minLabel}>0</span><span bind:this={host.maxLabel}>255</span>
  </div>
  <div class="histogram-stats" id="histogram-stats">
    <div class="histogram-stat-line">{#each $model.statsRows as row}<span class="histogram-stat-item" style:color={row.color}>{row.text}</span>{/each}</div>
    <div class="histogram-stat-line histogram-stat-nan" style:visibility={$model.nanCount > 0 ? 'visible' : 'hidden'}><span class="histogram-stat-item histogram-stat-nan">NaN/Inf: {$model.nanCount.toLocaleString()}</span></div>
  </div>
  <div class="histogram-tooltip" bind:this={host.tooltip} style="position:absolute;display:none;background-color:rgba(0,0,0,0.8);color:white;padding:4px 8px;border-radius:4px;font-size:11px;pointer-events:none;z-index:1000">
    <div><strong>{$model.tooltipTitle}</strong></div>
    {#each $model.tooltipRows as row}<div><span style:color={row.color}>{row.text}</span></div>{/each}
  </div>
</div>
