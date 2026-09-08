<script lang="ts">
  import type { Writable } from 'svelte/store';
  import type { ChannelsModel } from '../../media/modules/channels-panel';
  import { COLORMAP_NAMES } from '../../media/modules/colormaps';
  import { panelGestures } from '../panel-gestures';
  let { model }: { model: Writable<ChannelsModel> } = $props();
  function short(value: number): string {
    if (!Number.isFinite(value)) return '—';
    const magnitude = Math.abs(value);
    if (magnitude !== 0 && (magnitude < 0.01 || magnitude >= 100000)) return value.toExponential(2);
    return String(Math.round(value * 100) / 100);
  }
  function range(index: number, which: 'min' | 'max', value: string, interactive: boolean) {
    const plane = $model.planes[index], setting = $model.settings[index];
    const raw = plane.min + Number(value) / 1000 * (plane.max - plane.min || 1);
    $model.update(index, which === 'min' ? { min: Math.min(raw, setting.max) } : { max: Math.max(raw, setting.min) }, interactive);
  }
</script>
<div class="channels-panel" style:display={$model.visible ? 'flex' : 'none'} use:panelGestures={'channels-header'}>
  <div class="channels-header" style:cursor="move">
    <div class="channels-title">Channels</div><div class="channels-spacer"></div>
    <button class="measure-chip" class:active={$model.composite} title="Show all visible channels at once, additively blended (C)" onclick={$model.toggleComposite}>Composite</button>
    <button class="measure-close" title="Close the channels panel" onclick={$model.close}>×</button>
  </div>
  <div class="channels-body">
    {#if $model.planes.length < 2}<div class="measure-note">This image has a single channel.</div>
    {:else}
      {#each $model.planes as plane, index (plane.index)}
        {@const setting = $model.settings[index]}
        <div class="channel-row" class:dimmed={$model.solo !== null && $model.solo !== plane.index}>
          <div class="channel-row-top">
            <input type="checkbox" checked={setting.visible} title="Include this channel in the composite" onchange={e => $model.update(index, { visible: e.currentTarget.checked })}>
            <input type="color" class="channel-swatch" value={setting.color} title="Channel tint" oninput={e => $model.update(index, { color: e.currentTarget.value }, true)} onchange={e => $model.update(index, { color: e.currentTarget.value })}>
            <span class="channel-name" title={plane.name}>{plane.name}</span>
            <button class="measure-chip channel-solo" class:active={$model.solo === plane.index} title="Show only this channel. Solo is a view, not a change to the settings." onclick={() => $model.setSolo(plane.index)}>Solo</button>
          </div>
          <div class="channel-range">
            {#each ['min', 'max'] as key}
              {@const which = key as 'min' | 'max'}
              <input type="range" min="0" max="1000" step="1" class="channel-slider" title={which === 'min' ? 'Black point' : 'White point'} value={Math.round((setting[which] - plane.min) / (plane.max - plane.min || 1) * 1000)} oninput={e => range(index, which, e.currentTarget.value, true)} onchange={e => range(index, which, e.currentTarget.value, false)}>
            {/each}
          </div>
          <div class="channel-readout">{short(setting.min)} – {short(setting.max)}</div>
          <div class="channel-controls">
            <input type="range" min="0" max="100" value={Math.round(setting.opacity * 100)} class="channel-slider" title="Channel opacity" oninput={e => $model.update(index, { opacity: Number(e.currentTarget.value) / 100 }, true)} onchange={e => $model.update(index, { opacity: Number(e.currentTarget.value) / 100 })}>
            <select class="measure-select channel-colormap" title="Use a colormap instead of a flat tint" value={setting.colormap || 'none'} onchange={e => $model.update(index, { colormap: e.currentTarget.value })}>
              {#each ['none', ...COLORMAP_NAMES] as name}<option value={name}>{name === 'none' ? 'Tint' : name}</option>{/each}
            </select>
          </div>
          <button class="measure-button channel-auto" onclick={() => $model.range(index, true)}>Auto</button>
        </div>
      {/each}
      <div class="measure-button-row">
        <button class="measure-button" onclick={() => $model.range(null, true)}>Auto range all</button>
        <button class="measure-button" onclick={() => $model.range(null, false)}>Full range all</button>
        <button class="measure-button" onclick={$model.showAll}>Show all</button>
      </div>
      <div class="measure-note">{$model.composite ? `Channels are added together, each scaled by its own range — the way emission combines at the detector. Compositing on ${$model.backend === 'webgpu' ? 'the GPU (WebGPU)' : 'the CPU'}.` : 'Composite is off; the image is shown as decoded. Turn it on to blend the channels.'}</div>
    {/if}
  </div>
</div>
