<script lang="ts">
  import type { MeasurePanel } from '../../media/modules/measure-panel';
  import { calibrationFromKnownDistance, describeCalibration, formatNumber } from '../../media/modules/measure/calibration';
  import Field from './MeasureField.svelte';
  import Section from './MeasureSection.svelte';
  let { panel }: { panel: MeasurePanel } = $props();
  const calibration = $derived(panel.host.getCalibration());
  let length = $state<number>();
  let unit = $state('');
</script>
<Section title="Spatial calibration"><div class="measure-note">{describeCalibration(calibration)}</div>
  <Field label="Pixel width" value={calibration.pixelWidth} min={0} change={value => { panel.host.setCalibration({...calibration,pixelWidth:value,origin:'manual'}); panel.refresh(); }} />
  <Field label="Pixel height" value={calibration.pixelHeight} min={0} change={value => { panel.host.setCalibration({...calibration,pixelHeight:value,origin:'manual'}); panel.refresh(); }} />
  <Field label="Unit" type="text" value={calibration.unit} change={value => { panel.host.setCalibration({...calibration,unit:value || 'px',origin:'manual'}); panel.refresh(); }} />
</Section>
<Section title="Set scale from a known distance"><div class="measure-note">Draw a line along a feature whose real length you know — a scale bar, a calibration grid — and enter that length.</div>
  <button class="measure-button" onclick={() => {panel.host.overlay.setTool('calibrate');panel.setTab('setup');}}>Draw calibration line</button>
  {#if panel.pendingCalibrationDistance > 0}<div class="measure-note">Measured {formatNumber(panel.pendingCalibrationDistance,5)} px.</div>
    <div class="measure-button-row"><input class="measure-input" type="number" step="any" placeholder="Known length" bind:value={length} onkeydown={e=>e.stopPropagation()}>
    <input class="measure-input measure-unit-input" aria-label="Calibration unit" value={calibration.unit === 'px' ? 'µm' : calibration.unit} oninput={e=>unit=e.currentTarget.value} onkeydown={e=>e.stopPropagation()}>
    <button class="measure-button" onclick={() => {const updated=calibrationFromKnownDistance(panel.pendingCalibrationDistance,length ?? NaN,(unit || (calibration.unit==='px'?'µm':calibration.unit)).trim());if(updated){panel.host.setCalibration(updated);panel.pendingCalibrationDistance=0;panel.host.overlay.setTool('select');panel.refresh();}}}>Apply</button></div>
  {/if}
</Section>
<Section title="Reset"><button class="measure-button" onclick={() => {panel.host.setCalibration({pixelWidth:1,pixelHeight:1,unit:'px',origin:'none'});panel.refresh();}}>Back to pixels</button></Section>
