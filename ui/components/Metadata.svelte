<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Writable } from 'svelte/store';
  import type { MetadataModel } from '../../media/modules/metadata-panel';
  import type { TagEntry } from '../../media/modules/tiff-tag-utils';
  import { panelGestures } from '../panel-gestures';
  let { model }: { model: Writable<MetadataModel> } = $props();
  let copyLabel = $state('Copy as JSON');
  let timer: ReturnType<typeof setTimeout>;
  onDestroy(() => clearTimeout(timer));
  const groups = $derived.by(() => {
    const groups = new Map<string, TagEntry[]>();
    for (const tag of $model.info?.tags ?? []) {
      const key = tag.group || 'Tags';
      groups.set(key, [...(groups.get(key) ?? []), tag]);
    }
    const order = ['TIFF', 'GeoKeys', 'Exif', 'GPS'];
    return [...order.filter(g => groups.has(g)), ...[...groups.keys()].filter(g => !order.includes(g))]
      .map(name => ({ name, tags: groups.get(name)! }));
  });
  async function copy() {
    if (!$model.info) return;
    try { await navigator.clipboard.writeText(JSON.stringify($model.info, null, 2)); copyLabel = 'Copied!'; }
    catch { copyLabel = 'Copy failed'; }
    clearTimeout(timer);
    timer = setTimeout(() => copyLabel = 'Copy as JSON', 1500);
  }
</script>

{#snippet row(name: string, value: string)}
  <div class="metadata-panel-row"><span class="metadata-panel-row-name">{name}</span><span class="metadata-panel-row-value" title={value}>{value}</span></div>
{/snippet}
<div class="metadata-panel" style:display={$model.visible ? 'flex' : 'none'} use:panelGestures={'metadata-panel-header'}>
  <div class="metadata-panel-header">
    <div class="metadata-panel-title">Metadata</div>
    <button class="metadata-panel-button" title="Copy all metadata and statistics as JSON" onclick={copy}>{copyLabel}</button>
    <button class="metadata-panel-close" title="Close metadata panel" onclick={$model.close}>×</button>
  </div>
  <div class="metadata-panel-body">
    {#if $model.info}
      {@const info = $model.info}
      <details class="metadata-panel-section" open><summary>File ({info.formatLabel})</summary><div class="metadata-panel-section-content">
        {#each Object.entries(info.fileFields) as [name, value]}{@render row(name, value)}{/each}
      </div></details>
      {#if info.stats}
        <details class="metadata-panel-section" open><summary>Statistics</summary><div class="metadata-panel-section-content">
          {@render row('Min', $model.formatNumber(info.stats.min))}
          {@render row('Max', $model.formatNumber(info.stats.max))}
          {@render row('Mean', $model.formatNumber(info.stats.mean))}
          {@render row('Std Dev', $model.formatNumber(info.stats.std))}
          {@render row('Valid Samples', `${info.stats.validCount.toLocaleString()} / ${info.stats.totalCount.toLocaleString()}`)}
          {#if info.stats.nonFiniteCount > 0}{@render row('NaN/Infinite', info.stats.nonFiniteCount.toLocaleString())}{/if}
        </div></details>
      {/if}
      {#each groups as group (group.name)}
        <details class="metadata-panel-section" open={group.name === 'TIFF'}><summary>{group.name} Tags ({group.tags.length})</summary><div class="metadata-panel-section-content">
          {#each group.tags as tag}{@render row(tag.name, tag.value)}{/each}
        </div></details>
      {/each}
    {:else}<div class="metadata-panel-empty">No metadata available for this image.</div>{/if}
  </div>
</div>
