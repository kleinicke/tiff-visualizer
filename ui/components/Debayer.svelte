<script lang="ts">
  import type { Writable } from 'svelte/store';
  import type { Snippet } from 'svelte';
  import type { DebayerModel } from '../../media/modules/debayer-panel';
  import { PATTERNS, getPatternInfo, type DebayerAlgorithm, type DebayerView, type DebayerSettings } from '../../media/modules/debayer';
  import { panelGestures } from '../panel-gestures';
  let { model }: { model: Writable<DebayerModel> } = $props();
  const settings = $derived($model.settings);
  const info = $derived(getPatternInfo(settings.pattern));
  function pattern(value: string) {
    $model.change({ pattern: value, enabled: true, view: settings.view === 'i' && getPatternInfo(value).channels < 4 ? 'rgb' : settings.view });
  }
  function number(event: Event, key: keyof DebayerSettings, gain = false) {
    const input = event.currentTarget as HTMLInputElement;
    const value = input.value === '' ? NaN : Number(input.value);
    if (!Number.isFinite(value) || (gain && value < 0)) { input.value = String(settings[key]); return; }
    $model.change({ [key]: value, ...(gain ? { autoWb: false, enabled: true } : {}) });
  }
</script>
{#snippet row(label: string, content: Snippet)}
  <div class="debayer-row"><div class="debayer-label">{label}</div>{@render content()}</div>
{/snippet}
<div class="debayer-panel" style:display={$model.visible ? 'flex' : 'none'} use:panelGestures={'debayer-header'}>
  <div class="debayer-header" style:cursor="move">
    <div class="debayer-title">Debayer</div>
    <label class="debayer-enable"><input type="checkbox" checked={settings.enabled} onchange={e => $model.change({ enabled: e.currentTarget.checked })}>On</label>
    <button class="debayer-close" title="Close debayer panel" onclick={$model.close}>×</button>
  </div>
  <div class="debayer-body">
    {#snippet patternControl()}<select class="debayer-select" aria-label="Pattern" value={settings.pattern} onchange={e => pattern(e.currentTarget.value)}>{#each PATTERNS as p}<option value={p.id} title={p.description}>{p.label}</option>{/each}</select>{/snippet}
    {@render row('Pattern', patternControl)}
    {#snippet method()}<select class="debayer-select" aria-label="Method" value={settings.algorithm} onchange={e => $model.change({ algorithm: e.currentTarget.value as DebayerAlgorithm })}>
      <option value="malvar" title="Gradient-corrected linear. Best quality on detail. 2×2 Bayer only; other patterns use bilinear.">Malvar-He-Cutler</option>
      <option value="bilinear" title="Plain linear interpolation. Works for every pattern.">Bilinear</option>
      <option value="nearest" title="Copies the nearest sampled site. Invents no values — preferred for measurement.">Nearest (no interpolation)</option>
    </select>{/snippet}
    {@render row('Method', method)}
    {#snippet phase()}<div class="debayer-offset">{#each ['X', 'Y'] as axis}{@const key = axis === 'X' ? 'offsetX' : 'offsetY'}
      <button class="debayer-button" data-axis={axis} class:active={settings[key] !== 0} disabled={info.period < 2} title={`Shift the CFA phase by one pixel in ${axis}. Wraps at the pattern period.`} onclick={() => $model.change({ [key]: (settings[key] + 1) % info.period, enabled: true })}>{axis}: {settings[key]}</button>
    {/each}</div>{/snippet}
    {@render row(`Phase (0-${info.period - 1})`, phase)}
    {#snippet levels()}<div class="debayer-levels" title="Sensor black/white level in raw units, e.g. 256 / 4351 for 12-bit data in uint16. Leave both at 0 to skip.">
      <label class="debayer-gain-label">Black<input type="number" step="1" class="debayer-number" value={settings.blackLevel} onchange={e => number(e, 'blackLevel')}></label>
      <label class="debayer-gain-label">White<input type="number" step="1" class="debayer-number" value={settings.whiteLevel} onchange={e => number(e, 'whiteLevel')}></label>
    </div>{/snippet}
    {@render row('Levels', levels)}
    {#snippet balance()}<div class="debayer-wb"><button class="debayer-button" class:active={settings.autoWb} title="Estimate gains by assuming the scene averages to neutral. Fails on strongly tinted scenes — enter gains manually there." onclick={() => $model.change({ autoWb: !settings.autoWb, enabled: true })}>Auto (gray world)</button></div>{/snippet}
    {@render row('White balance', balance)}
    {#snippet gains()}<div class="debayer-gains">{#each ['R', 'G', 'B'] as name}{@const key = `gain${name}` as 'gainR' | 'gainG' | 'gainB'}
      <label class="debayer-gain-label">{name}<input type="number" step="0.01" min="0" class="debayer-number" title={`${name} gain`} value={settings[key].toFixed(2)} disabled={settings.autoWb} onchange={e => number(e, key, true)}></label>
    {/each}</div>{/snippet}
    {@render row('Gains', gains)}
    {#snippet views()}<div class="debayer-views">{#each [{ id: 'rgb', label: 'RGB', title: 'Full colour composite' }, { id: 'r', label: 'R', title: 'Red channel only' }, { id: 'g', label: 'G', title: 'Green channel only' }, { id: 'b', label: 'B', title: 'Blue channel only' }, { id: 'i', label: info.fourthLabel || 'IR', title: 'Fourth channel (IR / clear / white), if the pattern has one' }, { id: 'mosaic', label: 'Raw', title: 'Undemosaiced mosaic, as stored' }] as view}
      <button class="debayer-button debayer-view-button" data-view={view.id} class:active={settings.view === view.id} disabled={view.id === 'i' && info.channels < 4} title={view.title} onclick={() => $model.change({ view: view.id as DebayerView, enabled: view.id !== 'mosaic' || settings.enabled })}>{view.label}</button>
    {/each}</div>{/snippet}
    {@render row('View', views)}
    <div class="debayer-status">{!settings.enabled ? 'Off — showing the raw mosaic.' : settings.view === 'mosaic' ? 'Showing the undemosaiced mosaic.' : settings.view === 'rgb' ? `${info.label}, ${info.period}×${info.period} period.` : 'Single channel — Apply Colormap works on this view.'}</div>
  </div>
</div>
