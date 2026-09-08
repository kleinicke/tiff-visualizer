<script lang="ts">
  import { untrack } from 'svelte';
  import type { LayersPanel } from '../../media/modules/layers-panel';
  import type { Layer, LayerAdjustment } from '../../media/modules/layer-compositor';
  import { adjustmentSummary } from '../../media/modules/layer-panel-model';
  import { adjustmentFields } from '../layer-adjustment-fields';
  import AdjustmentRange from './AdjustmentRange.svelte';
  import ToneCurve from './ToneCurve.svelte';
  let { host, layer }: { host: LayersPanel; layer: Layer } = $props();
  let adjustment = $state.raw<LayerAdjustment>(untrack(() => layer.adjustment!));
  let selection = $state(untrack(() => adjustment.type === 'hue/saturation' ? 'master' : adjustment.type === 'channel mixer' ? 'red' : adjustment.type === 'color balance' ? 'shadows' : 'rgb'));
  const fields = $derived(adjustmentFields(adjustment, selection, value => commit(value)));
  const colorize = $derived(adjustment.type === 'hue/saturation' && !!adjustment.colorize && adjustment.colorizeEnabled !== false);
  const choices = $derived(adjustment.type === 'hue/saturation' ? [['master','Master'],['reds','Reds'],['yellows','Yellows'],['greens','Greens'],['cyans','Cyans'],['blues','Blues'],['magentas','Magentas']] : adjustment.type === 'channel mixer' ? adjustment.monochrome ? [['gray','Gray']] : [['red','Red output'],['green','Green output'],['blue','Blue output']] : adjustment.type === 'color balance' ? [['shadows','Shadows'],['midtones','Midtones'],['highlights','Highlights']] : [['rgb','RGB'],['red','Red'],['green','Green'],['blue','Blue']]);
  const points = $derived.by(() => {
    if (adjustment.type !== 'curves') return [];
    const value = adjustment[selection as 'rgb'|'red'|'green'|'blue'];
    return Array.isArray(value) && value.length ? value.map(p=>({...p})).sort((a,b)=>a.input-b.input) : [{input:0,output:0},{input:255,output:255}];
  });
  const stops = $derived(adjustment.type === 'gradient map' && adjustment.stops?.length ? adjustment.stops : [{position:0,color:{r:0,g:0,b:0}},{position:1,color:{r:255,g:255,b:255}}]);
  const hex = (color:{r:number;g:number;b:number}) => `#${[color.r,color.g,color.b].map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('')}`;
  function commit(value: LayerAdjustment, interactive = true) { host.manager.updateLayer(layer.id!,{adjustment:value}); adjustment = value; host._refreshAdjustmentThumbnail(layer); host.onChange({interactive}); }
  function history(node: HTMLElement) { host._bindContinuousHistory(node,()=>host.onChange({settled:true})); }
</script>
<details class="layer-adjustment-editor" open={host.expandedAdjustments.has(layer.id!)} ontoggle={e=>{if(e.currentTarget.open)host.expandedAdjustments.add(layer.id!);else host.expandedAdjustments.delete(layer.id!);}}>
  <summary class="layer-adjustment-summary" title="Expand to edit this adjustment">{adjustmentSummary(adjustment)}</summary>
  <div class="layer-adjustment-controls">
    {#if adjustment.type === 'hue/saturation'}
      <label class="layer-adjustment-colorize" title="Colorize assigns a hue and saturation to every pixel, including neutral grayscale. Off: rotate colors that already exist."><input type="checkbox" checked={colorize} onchange={e=>{if(adjustment.type==='hue/saturation')commit({...adjustment,colorizeEnabled:e.currentTarget.checked,colorize:adjustment.colorize||{hue:0,saturation:100,lightness:0}});}}> Colorize</label>
    {:else if adjustment.type === 'channel mixer'}
      <label class="layer-adjustment-colorize"><input type="checkbox" checked={!!adjustment.monochrome} onchange={e=>{if(adjustment.type==='channel mixer'){selection=e.currentTarget.checked?'gray':'red';commit({...adjustment,monochrome:e.currentTarget.checked});}}}> Monochrome</label>
    {/if}
    {#if ['levels','curves','hue/saturation','channel mixer','color balance'].includes(adjustment.type) && !colorize}
      <label class="layer-adjustment-field"><span>{adjustment.type==='hue/saturation'||adjustment.type==='color balance'?'Range':adjustment.type==='channel mixer'?'Output':'Channel'}</span><select class="layer-adjustment-channel" bind:value={selection}>{#each choices as [value,label]}<option {value}>{label}</option>{/each}</select></label>
    {/if}
    {#if adjustment.type === 'color balance'}<label class="layer-adjustment-colorize"><input type="checkbox" checked={adjustment.preserveLuminosity !== false} onchange={e=>{if(adjustment.type==='color balance')commit({...adjustment,preserveLuminosity:e.currentTarget.checked});}}> Preserve luminosity</label>{/if}
    {#if adjustment.type === 'curves'}
      <ToneCurve {points} channel={selection} commit={(points,interactive)=>{if(adjustment.type==='curves')commit({...adjustment,[selection]:points},interactive);}} begin={()=>host.manager.beginHistoryGroup()} end={()=>{host.manager.endHistoryGroup();host._applyCollapsed();host.onChange({settled:true});}} />
    {:else if adjustment.type === 'gradient map'}
      <div class="layer-gradient-colors">{#each [['Dark',0],['Light',stops.length-1]] as [label,index]}{@const at=Number(index)}<label class="layer-adjustment-field"><span>{label}</span><input type="color" value={hex(stops[at].color)} title={`${label} gradient color`} use:history oninput={e=>{if(adjustment.type!=='gradient map')return;const value=e.currentTarget.value,next=[...stops];next[at]={...next[at],color:{r:parseInt(value.slice(1,3),16),g:parseInt(value.slice(3,5),16),b:parseInt(value.slice(5,7),16)}};commit({...adjustment,stops:next});}}></label>{/each}</div>
      <label class="layer-adjustment-colorize"><input type="checkbox" checked={!!adjustment.reverse} onchange={e=>{if(adjustment.type==='gradient map')commit({...adjustment,reverse:e.currentTarget.checked});}}> Reverse</label>
    {:else if adjustment.type === 'invert'}<div class="layer-adjustment-note">No parameters — every RGB value is replaced by its inverse.</div>
    {:else}<div class="layer-adjustment-channel-controls">{#each fields as field (field.key)}<AdjustmentRange {field} {host} />{/each}</div>{/if}
    <button type="button" class="layers-btn layer-filter-remove" aria-label="Remove filter" title="Remove this filter (can be undone)" onclick={()=>{host.expandedAdjustments.delete(layer.id!);host.manager.removeLayer(layer.id!);host.refresh();host.onChange();}}>×</button>
  </div>
</details>
