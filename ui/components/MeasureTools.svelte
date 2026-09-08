<script lang="ts">
  import { TOOLS, type MeasurePanel } from '../../media/modules/measure-panel';
  import { isLineKind, type LineRoi, type Roi } from '../../media/modules/measure/types';
  import Section from './MeasureSection.svelte';
  import Field from './MeasureField.svelte';
  let { panel }: { panel: MeasurePanel } = $props();
  const overlay = $derived(panel.host.overlay);
  const selected = $derived(panel.host.manager.selectedRois());
  const line = $derived(selected.find(roi => isLineKind(roi.kind)) as LineRoi | undefined);
  function profile(canvas: HTMLCanvasElement) { if (line) panel.paintProfile(canvas,line); }
</script>
<Section title="Tool"><div class="measure-tool-grid">{#each TOOLS as tool}<button class="measure-tool" class:active={overlay.getTool()===tool.id} title={tool.key?`${tool.label} (${tool.key})`:tool.label} onclick={()=>{overlay.setTool(tool.id);panel.render();}}>{tool.label}</button>{/each}</div></Section>
{#if overlay.getTool()==='wand'}<Section title="Wand">
  <Field type="checkbox" label="Choose tolerance automatically" value={overlay.getWandTolerance()===null} change={checked=>{overlay.setWandTolerance(checked?null:1);panel.render();}} title="Sweeps the tolerance and keeps the value at which the region stops growing — the object boundary — instead of asking you to guess one." />
  {#if overlay.getWandTolerance()!==null}<Field label="Tolerance" value={overlay.getWandTolerance()??1} min={0} change={value=>overlay.setWandTolerance(value)} />{/if}
  <div class="measure-note">Hover to preview, scroll to adjust, Shift-click to merge into the selected object.</div>
</Section>{/if}
{#if overlay.getTool()==='brush'}<Section title="Brush"><Field label="Radius (px)" value={overlay.getBrushRadius()} min={1} step="1" change={value=>overlay.setBrushRadius(value)} /><div class="measure-note">Paints into the selected object. Alt-drag erases, scroll resizes.</div></Section>{/if}
<Section title="Overlay"><Field type="checkbox" label="Show all ROI names" value={false} change={value=>overlay.setShowLabels(value)} title="Off by default: only the object you point at or have selected is named, so a segmented field stays readable." /><div class="measure-note">Mask and ROIs toggle from the header, or with M and O. The scale bar toggles from the image right-click menu. Hold H to hide everything and look at the raw image.</div></Section>
{#if line}<Section title={`Profile — ${line.name}`}>
  {#if panel.host.getSource()}<canvas class="measure-profile" width="460" height="150" use:profile></canvas><div class="measure-row"><Field label="Line width (px)" value={line.lineWidth||1} min={1} step="1" change={value=>panel.host.manager.update(line!.id,current=>({...current,lineWidth:Math.max(1,Math.round(value))} as Roi))} /></div><button class="measure-button" onclick={()=>panel.exportProfile(line!)}>Export profile as CSV</button>
  {:else}<div class="measure-note">No image loaded.</div>{/if}
</Section>
{:else if selected.length===1}<Section title={selected[0].name}>{#if panel.rows.some(row=>row.roiId===selected[0].id)}<div class="measure-quick-stats">{#each panel.quickStats(selected[0]) as [label,value]}<div class="measure-quick-label">{label}</div><div class="measure-quick-value">{value}</div>{/each}</div>{:else}<div class="measure-note">Not measurable on this image.</div>{/if}</Section>{/if}
