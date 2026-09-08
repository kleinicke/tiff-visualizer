<script lang="ts">
  let { kind, settings, zoom, isSingleChannelInteger, submit }: {
    kind: 'normalization' | 'gamma' | 'exposure' | 'zoom';
    settings: { normalization: { autoNormalize: boolean; gammaMode: boolean; min: number; max: number }; gamma: { in: number; out: number }; brightness: { offset: number }; normalizedFloatMode: boolean };
    zoom: number | 'fit'; isSingleChannelInteger: boolean; submit: (event: SubmitEvent) => void;
  } = $props();
  const mode = $derived(settings.normalization.autoNormalize ? 'auto' : settings.normalization.gammaMode ? 'gamma' : 'manual');
</script>
<form class="web-control-form" onsubmit={submit}>
  {#if kind === 'normalization'}
    <fieldset><legend>Mode</legend>
      <label class="web-radio"><input type="radio" name="mode" value="auto" checked={mode === 'auto'}><span>Auto-normalize to the image minimum and maximum</span></label>
      <label class="web-radio"><input type="radio" name="mode" value="gamma" checked={mode === 'gamma'}><span>Gamma and exposure mode using the complete sample range</span></label>
      <label class="web-radio"><input type="radio" name="mode" value="manual" checked={mode === 'manual'}><span>Manual display range</span></label>
    </fieldset>
    <label>Minimum <input name="minimum" type="number" step="any" value={settings.normalization.min}></label>
    <label>Maximum <input name="maximum" type="number" step="any" value={settings.normalization.max}></label>
    {#if isSingleChannelInteger}<label class="web-radio"><input name="normalizedFloat" type="checkbox" checked={settings.normalizedFloatMode}><span>Show unsigned integer values normalized to 0–1</span></label>{/if}
    <p class="web-control-note">Raw pixel values are preserved. These settings only change how the image is displayed.</p>
  {:else if kind === 'gamma'}
    <label>Source gamma <input name="gammaIn" type="number" min="0" step="any" value={settings.gamma.in}></label>
    <label>Target gamma <input name="gammaOut" type="number" min="0" step="any" value={settings.gamma.out}></label>
    <p class="web-control-note">2.2 is typical display gamma; 1.0 is linear.</p>
  {:else if kind === 'exposure'}
    <label>Exposure stops <input name="exposure" type="number" min="-16" max="16" step="0.1" value={settings.brightness.offset}></label>
    <p class="web-control-note">+1 EV doubles linear brightness; −1 EV halves it.</p>
  {:else}
    <label>Scale <select name="scale" value={zoom}><option value="fit">Whole image</option>{#each [0.1, 0.2, 0.5, 1, 2, 5, 10] as scale}<option value={scale}>{scale * 100}%</option>{/each}</select></label>
  {/if}
  <button class="web-control-submit" type="submit">Apply</button>
</form>
