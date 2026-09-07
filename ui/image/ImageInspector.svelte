<script lang="ts">
  import { tick } from 'svelte';
  import Section from '../primitives/Section.svelte';
  import NumberField from '../primitives/NumberField.svelte';
  import type { ImageUiBridge } from './bridge';
  let { bridge }: { bridge: ImageUiBridge } = $props();
  const snapshot = $derived(bridge.state);
  let area = $state<'Display' | 'Inspect' | 'Tools' | null>(null);
  let error = $state('');
  let gammaOpen = $state(false);
  async function focusInspector(event: MessageEvent) {
    if (event.data?.type !== 'focusImageInspector') return;
    area = 'Display';
    if (event.data.control === 'gamma') gammaOpen = true;
    await tick();
    document.querySelector<HTMLElement>('#image-inspector select')?.focus();
  }
  const mode = $derived($snapshot.settings.normalization.autoNormalize ? 'auto' : $snapshot.settings.normalization.gammaMode ? 'gamma' : 'range');
  function range(min: number, max: number) {
    if (min >= max) { error = 'Maximum must be greater than minimum.'; return; }
    error = '';
    bridge.edit({ kind: 'range', min, max });
  }
  function toggle(next: typeof area) { area = area === next ? null : next; error = ''; }
</script>

<svelte:window onmessage={focusInspector} />

<div class="viewer-inspector-shell" data-open={area !== null}>
  <nav aria-label="Image workspace">
    {#each ['Display', 'Inspect', 'Tools'] as item}
      <button class:active={area === item} aria-expanded={area === item} aria-controls="image-inspector" onclick={() => toggle(item as typeof area)}>{item}</button>
    {/each}
  </nav>
  {#if area}
    <aside id="image-inspector" aria-label={`${area} inspector`}>
      <header>
        <div><span class="eyebrow">{$snapshot.format === '—' ? 'IMAGE' : $snapshot.format.split('-')[0].toUpperCase()}</span><strong title={$snapshot.name}>{$snapshot.name}</strong></div>
        <button class="close" aria-label="Close inspector" onclick={() => { area = null; }}>×</button>
      </header>
      {#if !$snapshot.ready}
        <p class="empty">Open an image to inspect its data and adjust its display.</p>
      {:else if area === 'Display'}
        <Section title="Tone mapping">
          <label class="row">Mapping
            <select aria-label="Mapping" value={mode} onchange={e => { error = ''; bridge.edit({ kind: 'mode', value: e.currentTarget.value as 'auto' | 'range' | 'gamma' }); }}>
              <option value="auto">Auto range</option><option value="range">Manual range</option><option value="gamma">Gamma & exposure</option>
            </select>
          </label>
          {#if mode === 'auto'}
            <p class="hint">Map the data’s minimum and maximum to the display range.</p>
          {:else if mode === 'range'}
            <NumberField label="Minimum" value={$snapshot.settings.normalization.min} onchange={min => range(min, $snapshot.settings.normalization.max)} />
            <NumberField label="Maximum" value={$snapshot.settings.normalization.max} onchange={max => range($snapshot.settings.normalization.min, max)} />
          {:else}
            <NumberField label="Exposure · EV" value={$snapshot.settings.brightness.offset} min={-16} max={16} onchange={value => bridge.edit({ kind: 'exposure', value })} />
            <input class="exposure" type="range" aria-label="Exposure" min="-16" max="16" step="0.1" value={$snapshot.settings.brightness.offset} oninput={e => bridge.edit({ kind: 'exposure', value: e.currentTarget.valueAsNumber })} ondblclick={() => bridge.edit({ kind: 'exposure', value: 0 })} title="Double-click to reset exposure to 0 EV" />
            <details class="advanced" bind:open={gammaOpen}><summary>Gamma</summary><div>
              <NumberField label="Input gamma" value={$snapshot.settings.gamma.in} min={0.000001} onchange={input => bridge.edit({ kind: 'gamma', input, output: $snapshot.settings.gamma.out })} />
              <NumberField label="Output gamma" value={$snapshot.settings.gamma.out} min={0.000001} onchange={output => bridge.edit({ kind: 'gamma', input: $snapshot.settings.gamma.in, output })} />
            </div></details>
          {/if}
          {#if error}<p role="alert" class="error">{error}</p>{/if}
        </Section>
        <Section title="Color and channels" open={false}>
          <button class="action" onclick={() => bridge.command('toggleChannels')}>Channels… <span>›</span></button>
          <button class="action" onclick={() => bridge.command('applyColormap')}>Colormap… <span>›</span></button>
          <button class="action" onclick={() => bridge.command('toggleNanColor')}>Cycle no-value color <span>›</span></button>
        </Section>
        {#if $snapshot.normalizedFloatAvailable}
          <Section title="Interpretation" open={false}>
            <label class="check"><input type="checkbox" checked={$snapshot.settings.normalizedFloatMode} onchange={e => bridge.edit({ kind: 'normalizedFloat', value: e.currentTarget.checked })} /> Normalize integer values to 0–1</label>
          </Section>
        {/if}
        <Section title="View" open={false}>
          <button class="action" onclick={() => bridge.command('resetZoom')}>Fit image <span>{$snapshot.zoom}</span></button>
          <button class="action" onclick={() => bridge.command('toggleScaleBar')}>Toggle scale bar <span>›</span></button>
        </Section>
        <p class="note">Display adjustments preserve the source values.</p>
      {:else if area === 'Inspect'}
        <Section title="Image information">
          <dl><dt>Dimensions</dt><dd>{$snapshot.size}</dd><dt>Channels</dt><dd>{$snapshot.channels}</dd><dt>Bits per sample</dt><dd>{$snapshot.bits}</dd></dl>
          <button class="action" onclick={() => bridge.command('toggleMetadata')}>Full metadata… <span>›</span></button>
        </Section>
        <Section title="Pixel values">
          <p class="pixel">{$snapshot.pixel || 'Move over the image to inspect a pixel.'}</p>
          <button class="action" onclick={() => bridge.command('toggleColorPickerMode')}>Switch source / displayed values <span>›</span></button>
        </Section>
        <Section title="Analysis">
          <button class="action" onclick={() => bridge.command('toggleHistogram')}>Histogram… <span>›</span></button>
          <button class="action" onclick={() => bridge.command('toggleMeasure')}>Measurements & calibration… <span>›</span></button>
        </Section>
      {:else}
        <Section title="Sources">
          <button class="action" onclick={() => bridge.command('browseAndAddToCollection')}>Add images… <span>›</span></button>
          <button class="action" onclick={() => bridge.command('toggleLayers')}>Compose layers… <span>›</span></button>
        </Section>
        <Section title="Process" open={false}>
          <button class="action" onclick={() => bridge.command('convertColormapToFloat')}>Decode colormap… <span>›</span></button>
          <button class="action" onclick={() => bridge.command('toggleRgb24Mode')}>Toggle packed RGB values <span>›</span></button>
          <button class="action" onclick={() => bridge.command('revertToOriginal')}>Revert to original <span>›</span></button>
        </Section>
        <Section title="Export">
          <button class="action" onclick={() => bridge.command('exportLayers')}>Export… <span>›</span></button>
          <button class="action" onclick={() => bridge.command('copyImage')}>Copy image <span>›</span></button>
        </Section>
      {/if}
    </aside>
  {/if}
</div>

<style>
  .viewer-inspector-shell {
    --viewer-bg: var(--vscode-sideBar-background, #202124);
    --viewer-text: var(--vscode-foreground, #e5e5e7);
    --viewer-muted: var(--vscode-descriptionForeground, #a0a2aa);
    --viewer-border: var(--vscode-widget-border, #393b42);
    --viewer-input: var(--vscode-input-background, #292b30);
    --viewer-accent: var(--vscode-focusBorder, #8da7f5);
    position: fixed; top: 12px; right: 12px; z-index: 900; width: 296px;
    font: 12px/1.45 var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    color: var(--viewer-text); text-align: left;
  }
  :global(.web-app) .viewer-inspector-shell { top: 84px; }
  :global(.web-app) .viewer-inspector-shell {
    --viewer-bg: #202124; --viewer-text: #e5e5e7; --viewer-muted: #a0a2aa;
    --viewer-border: #393b42; --viewer-input: #292b30; --viewer-accent: #94a8ec;
  }
  :global(.jetbrains-host) .viewer-inspector-shell { top: 12px; }
  :global(.vscode-light) .viewer-inspector-shell { --viewer-bg: var(--vscode-sideBar-background, #f6f6f7); --viewer-text: var(--vscode-foreground, #24252a); --viewer-muted: var(--vscode-descriptionForeground, #60636c); --viewer-border: var(--vscode-widget-border, #d5d6da); --viewer-input: var(--vscode-input-background, #fff); }
  nav { display: flex; width: max-content; margin-left: auto; background: var(--viewer-bg); border: 1px solid var(--viewer-border); border-radius: 6px; padding: 3px; gap: 2px; }
  button, select { font: inherit; color: inherit; }
  button { cursor: pointer; }
  nav button { border: 0; border-radius: 3px; padding: 6px 13px; color: var(--viewer-muted); background: transparent; }
  nav button:hover, nav button.active { background: var(--viewer-input); color: var(--viewer-text); }
  nav button.active { box-shadow: inset 0 -2px var(--viewer-accent); }
  button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--viewer-accent); outline-offset: 2px; }
  aside { margin-top: 8px; max-height: calc(100dvh - 150px); overflow: auto; overscroll-behavior: contain; background: var(--viewer-bg); border: 1px solid var(--viewer-border); border-radius: 6px; box-shadow: 0 8px 28px #0002; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 16px; gap: 12px; }
  header div { min-width: 0; display: grid; gap: 3px; }
  strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; }
  .eyebrow { color: var(--viewer-muted); font-size: 10px; letter-spacing: 0.06em; }
  .close { background: transparent; border: 0; color: var(--viewer-muted); font-size: 20px; padding: 0 3px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .check { display: flex; align-items: start; gap: 8px; }
  select { border: 1px solid var(--viewer-border); background: var(--viewer-input); border-radius: 4px; padding: 6px; max-width: 175px; }
  p { margin: 0; }
  .hint, .note, .empty { color: var(--viewer-muted); font-size: 11px; }
  .note, .empty { padding: 16px; }
  .exposure { width: 100%; accent-color: var(--viewer-accent); margin: 0; }
  .advanced summary { cursor: pointer; color: var(--viewer-muted); }
  .advanced div { display: grid; gap: 12px; padding-top: 12px; }
  .action { display: flex; width: 100%; justify-content: space-between; align-items: center; border: 0; border-radius: 4px; background: transparent; text-align: left; padding: 6px 0; }
  .action:hover { color: var(--viewer-accent); }
  .action span { color: var(--viewer-muted); }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin: 0; }
  dt { color: var(--viewer-muted); } dd { margin: 0; font-variant-numeric: tabular-nums; }
  .pixel { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .error { color: var(--vscode-errorForeground, #ed9292); }
  @media (max-width: 420px) { .viewer-inspector-shell { right: 8px; width: min(296px, calc(100vw - 16px)); } }
</style>
