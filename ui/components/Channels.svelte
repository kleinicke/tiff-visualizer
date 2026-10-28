<script lang="ts">
  import type { Writable } from 'svelte/store';
  import type { ChannelsModel } from '../../media/modules/channels-panel';
  import { COLORMAP_NAMES } from '../../media/modules/colormaps';
  import { panelGestures } from '../panel-gestures';
  import RangeSlider from './RangeSlider.svelte';
  import CellsSection from './cells/CellsSection.svelte';
  import TranscriptsSection from './transcripts/TranscriptsSection.svelte';
  let { model }: { model: Writable<ChannelsModel> } = $props();
  let open = $state(true);
  let query = $state('');
  const matches = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase());
  let filterGroups = $state<string[]>([]);
  function toggleGroupFilter(name: string) { filterGroups = filterGroups.includes(name) ? filterGroups.filter(entry => entry !== name) : [...filterGroups, name]; }
  // Union over the active group filters, intersected with the text filter.
  // A filter naming a group that no longer exists is ignored.
  const inActiveGroup = (position: number) => {
    const active = $model.groups.filter(group => filterGroups.includes(group.name));
    return active.length === 0 || active.some(group => group.positions.includes(position));
  };
  const shows = (position: number, name: string) => inActiveGroup(position) && matches(name);
  const filtering = () => !!query.trim() || $model.groups.some(group => filterGroups.includes(group.name));
  const shownCount = () => $model.planes.filter((plane, position) => shows(position, plane.name)).length;
  function clearFilters() { query = ''; filterGroups = []; }
  let unfolded = $state<number[]>([]);
  function toggleFold(plane: number) { unfolded = unfolded.includes(plane) ? unfolded.filter(entry => entry !== plane) : [...unfolded, plane]; }
  // Positions the whole-panel actions apply to: every channel, or the filtered ones while filtering.
  const scope = () => filtering() ? $model.planes.flatMap((plane, position) => shows(position, plane.name) ? [position] : []) : undefined;
  function foldAll(fold: boolean) {
    const listed = new Set((scope() ?? $model.planes.map((_plane, position) => position)).map(position => $model.planes[position].index));
    unfolded = fold ? unfolded.filter(entry => !listed.has(entry)) : [...new Set([...unfolded, ...listed])];
  }
  function short(value: number): string {
    if (!Number.isFinite(value)) return '—';
    const magnitude = Math.abs(value);
    if (magnitude !== 0 && (magnitude < 0.01 || magnitude >= 100000)) return value.toExponential(2);
    return String(Math.round(value * 100) / 100);
  }
</script>
<div class="channels-panel" style:display={$model.visible ? 'flex' : 'none'} use:panelGestures={'channels-header'}>
  <div class="channels-header" style:cursor="move">
    <button class="channel-fold" aria-expanded={open} title={open ? 'Collapse the Channels section' : 'Expand the Channels section'} onclick={() => (open = !open)} onpointerdown={e => e.stopPropagation()}>{open ? '▾' : '▸'}</button>
    <div class="channels-title">Channels</div><div class="channels-spacer"></div>
    <button class="measure-chip" class:active={$model.composite} title="Show all visible channels at once, additively blended (C)" onclick={$model.toggleComposite}>Composite</button>
    <button class="measure-close" title="Close the channels panel" onclick={$model.close}>×</button>
  </div>
  {#if open && $model.planes.length >= 2}
    <details class="channels-global" open={!$model.compact}>
      <summary class="channels-section-title">{filtering() ? `Filtered channels (${shownCount()}/${$model.planes.length})` : `All channels (${$model.planes.length})`}</summary>
      <div class="channels-toolbar">
        <button class="measure-button" title={filtering() ? 'Switch the filtered channels on' : 'Switch every channel on'} onclick={() => $model.selectAll(scope())}>Select all</button>
        <button class="measure-button" title={filtering() ? 'Switch the filtered channels off' : 'Switch every channel off'} onclick={() => $model.deselectAll(scope())}>Deselect all</button>
        <button class="measure-button" title={filtering() ? 'Percentile range for the filtered channels' : 'Percentile range for every channel'} onclick={() => $model.range(null, true, scope())}>Auto range all</button>
        <button class="measure-button" title={filtering() ? 'True minimum to maximum for the filtered channels' : 'True minimum to maximum for every channel'} onclick={() => $model.range(null, false, scope())}>Full range all</button>
        <button class="measure-button" title={filtering() ? 'Collapse the filtered channels to their first row' : 'Collapse every channel to its first row'} onclick={() => foldAll(true)}>Fold all</button>
        <button class="measure-button" title={filtering() ? 'Show the sliders of the filtered channels' : 'Show the sliders of every channel'} onclick={() => foldAll(false)}>Unfold all</button>
      </div>
    </details>
  {/if}
  {#if open}
  <div class="channels-body">
    {#if $model.planes.length < 2}<div class="measure-note">{$model.status ?? 'This image has a single channel.'}</div>
    {:else}
      {#if $model.groups.length}
        <details class="channel-groups" open={!$model.compact}>
          <summary>Groups ({$model.groups.length})</summary>
          {#each $model.groups as group (group.name)}
            {@const unusable = !$model.composite || group.found === 0}
            <div class="channel-group-row" class:disabled={!$model.composite} class:soloed={group.soloed}>
              <input type="checkbox" disabled={unusable} checked={group.state === 'all'} indeterminate={group.state === 'some'}
                title={group.state === 'all' ? 'Switch this group off' : 'Switch every channel in this group on'} onchange={() => $model.toggleGroup(group.name)}>
              <span class="channel-name" title={group.name}>{group.name}</span>
              <span class="channel-group-count" title={`${group.on} of ${group.found} channels on${group.missing.length ? `. Not found: ${group.missing.join(', ')}` : ''}`}>{group.on}/{group.found}</span>
              <button class="group-filter" class:active={filterGroups.includes(group.name)} disabled={group.found === 0} aria-pressed={filterGroups.includes(group.name)}
                title={filterGroups.includes(group.name) ? 'Stop filtering the list to this group' : 'Show only this group in the channel list. Several groups combine (union); the text filter narrows them further.'} onclick={() => toggleGroupFilter(group.name)}>
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M1.5 2h13L9.5 8.5V14l-3-1.5V8.5z" fill="currentColor"/></svg>
              </button>
              <button class="measure-chip channel-solo" class:active={group.soloed} disabled={unusable}
                title="Show only the channels in this group, switching them on if they are off. The other channels keep their settings." onclick={() => $model.soloGroup(group.name)}>Solo</button>
            </div>
            {#if group.missing.length}<div class="measure-note">{group.name}: not found — {group.missing.join(', ')}</div>{/if}
          {/each}
          {#if !$model.composite}<div class="measure-note">Turn on Composite to use groups.</div>{/if}
        </details>
      {/if}
      <div class="channel-search">
        <input type="search" class="measure-input" placeholder="Filter channels…" aria-label="Filter channels by name" bind:value={query}>
        {#if filtering()}<span class="channel-group-count">{shownCount()}/{$model.planes.length}</span><button class="measure-chip" title="Clear the text and group filters" onclick={clearFilters}>Clear</button>{/if}
      </div>
      {#if filtering() && shownCount() === 0}<div class="measure-note">No channel matches the current filters.</div>{/if}
      {#each $model.planes as plane, index (plane.index)}
        {@const setting = $model.settings[index]}
        {@const isFolded = !unfolded.includes(plane.index)}
        {#if shows(index, plane.name)}
        <div class="channel-row" class:dimmed={$model.composite && $model.solo !== null && $model.solo !== plane.index} class:current={$model.current === plane.index}>
          <div class="channel-row-top">
            <button class="channel-fold" aria-expanded={!isFolded} title={isFolded ? 'Show this channel\'s sliders' : 'Hide this channel\'s sliders'} onclick={() => toggleFold(plane.index)}>{isFolded ? '▸' : '▾'}</button>
            <input type="checkbox" checked={setting.visible} title="Include this channel in the composite" onchange={e => $model.update(index, { visible: e.currentTarget.checked })}>
            <input type="color" class="channel-swatch" value={setting.color} title="Channel tint" oninput={e => $model.update(index, { color: e.currentTarget.value }, true)} onchange={e => $model.update(index, { color: e.currentTarget.value })}>
            <span class="channel-name" title={plane.name}>{plane.name}</span>
            <button class="measure-chip channel-solo" class:active={$model.composite ? $model.solo === plane.index : $model.current === plane.index} title={$model.composite ? 'Show only this channel, switching it on if it is off. The other channels keep their settings.' : 'Show this channel on its own. The channel selector follows.'} onclick={() => $model.setSolo(plane.index)}>{$model.composite ? 'Solo' : 'Show'}</button>
          </div>
          {#if !isFolded}
            <RangeSlider min={plane.min} max={plane.max} low={setting.min} high={setting.max} histogram={plane.histogram}
              readout="{short(setting.min)} – {short(setting.max)}" lowTitle="Black point" highTitle="White point"
              onchange={(low, high, interactive) => $model.update(index, { min: low, max: high }, interactive)} />
            <div class="channel-controls">
              <input type="range" min="0" max="100" value={Math.round(setting.opacity * 100)} class="channel-slider" title="Channel opacity" oninput={e => $model.update(index, { opacity: Number(e.currentTarget.value) / 100 }, true)} onchange={e => $model.update(index, { opacity: Number(e.currentTarget.value) / 100 })}>
              <select class="measure-select channel-colormap" title="Use a colormap instead of a flat tint" value={setting.colormap || 'none'} onchange={e => $model.update(index, { colormap: e.currentTarget.value })}>
                {#each ['none', ...COLORMAP_NAMES] as name}<option value={name}>{name === 'none' ? 'Tint' : name}</option>{/each}
              </select>
            </div>
            <button class="measure-button channel-auto" onclick={() => $model.range(index, true)}>Auto</button>
          {/if}
        </div>
        {/if}
      {/each}
      <div class="measure-note">{$model.composite ? `Channels are added together, each scaled by its own range — the way emission combines at the detector. Compositing on ${$model.backend === 'webgpu' ? 'the GPU (WebGPU)' : 'the CPU'}.` : 'Composite is off; the image is shown as decoded. Turn it on to blend the channels.'}</div>
    {/if}
  </div>
  {/if}
  {#if $model.cells}<CellsSection cells={$model.cells} />{/if}
  {#if $model.transcripts}<TranscriptsSection transcripts={$model.transcripts} />{/if}
</div>
