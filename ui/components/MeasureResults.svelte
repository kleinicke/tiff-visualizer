<script lang="ts">
  import type { MeasurePanel } from '../../media/modules/measure-panel';
  import { areaUnit, describeCalibration, formatNumber } from '../../media/modules/measure/calibration';
  import { COLUMN_GROUPS, LENGTH_COLUMNS, type MeasurementRow } from '../../media/modules/measure/types';
  import { compileExpression } from '../../media/modules/measure/expression';
  import { matchFilenamePattern, summarizeByGroup, summarizeRows } from '../../media/modules/measure/roi-io';
  import Field from './MeasureField.svelte';
  import Section from './MeasureSection.svelte';
  import Derived from './MeasureDerived.svelte';
  let { panel }: { panel: MeasurePanel } = $props();
  const source = $derived(panel.host.getSource());
  const calibration = $derived(panel.host.getCalibration());
  const columns = $derived(panel.resultColumns());
  const compiled = $derived(panel.derivedColumns.map(column=>{try{return compileExpression(column.expression);}catch{return null;}}));
  const groups = $derived(panel.groupPattern&&source?.fileName?matchFilenamePattern(source.fileName,panel.groupPattern):null);
  const summaryRows = $derived(panel.exportRows());
  const unitFor = (key:string) => key==='area'?` ${areaUnit(calibration)}`:(LENGTH_COLUMNS as readonly string[]).includes(key)?` ${calibration.unit}`:'';
  function derivedValues(row:MeasurementRow) {
    const scope: Record<string,number> = {};
    for(const [key,value] of Object.entries(row)) if(typeof value==='number')scope[key]=value;
    return compiled.map(evaluate=>{try{return evaluate?formatNumber(evaluate(scope),5):'';}catch{return '';}});
  }
</script>
<Section title="Table">{#if source && (source.channels||1)>1}<Field type="checkbox" label="Measure every channel" value={panel.channelMode==='all'} title="One row per ROI per channel. Off measures only the first channel." change={checked=>{panel.channelMode=checked?'all':'first';panel.refresh();}} />{/if}<div class="measure-note">{describeCalibration(calibration)}</div></Section>
<Section title="Columns"><div class="measure-note">What the table shows. Exports always contain every measured column — a results file that quietly omits a number because of a display setting is a trap.</div>
  <div class="measure-column-grid">{#each COLUMN_GROUPS as group}<Field type="checkbox" label={group.label} value={panel.visibleColumns.includes(group.id)} change={checked=>{const index=panel.visibleColumns.indexOf(group.id);if(checked&&index<0)panel.visibleColumns.push(group.id);if(!checked&&index>=0)panel.visibleColumns.splice(index,1);panel.render();}} />{/each}</div>
</Section>
<Section title={`Measurements (${panel.rows.length} rows)`}>
  {#if !panel.rows.length}<div class="measure-note">Draw or import an ROI to populate the table.</div>
  {:else}<div class="measure-table-wrapper measure-results-wrapper"><table class="measure-table"><thead><tr>{#each columns as column}<th>{column.label}</th>{/each}{#each panel.derivedColumns as column}<th>{column.name}</th>{/each}</tr></thead><tbody>
    {#each panel.rows as row}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events (Rows link measurements to image selection; ROI list provides keyboard editing.) -->
      <tr data-roi-id={row.roiId} class:selected={panel.host.manager.isSelected(row.roiId)} onmouseenter={()=>panel.host.overlay.setHoveredRoi(row.roiId)} onmouseleave={()=>panel.host.overlay.setHoveredRoi(null)} onclick={e=>panel.selectRoi(row.roiId,e)}>
        {#each columns as column}{@const value=row[column.key]}<td>{typeof value==='number'?formatNumber(value,column.digits??4):value??''}</td>{/each}
        {#each derivedValues(row) as value}<td>{value}</td>{/each}
      </tr>
    {/each}
  </tbody></table></div>{/if}
</Section>
<Section title="Derived columns"><div class="measure-note">Expressions over the columns above, e.g. rawIntegratedDensity / area. Saved with the ROIs and included in exports.</div>
  {#each panel.derivedColumns as _,index}<Derived {panel} {index} />{/each}<button class="measure-button" onclick={()=>{panel.derivedColumns.push({name:`derived${panel.derivedColumns.length+1}`,expression:'mean'});panel.render();}}>Add column</button>
</Section>
<Section title="Grouping"><Field type="text" label="Filename pattern" value={panel.groupPattern} placeholder={"e.g. {condition}_{replicate}_{index}.tif — braces become columns."} change={value=>{panel.groupPattern=value;panel.render();}} />
  {#if panel.groupPattern}<div class="measure-note">{groups?`Matched: ${Object.entries(groups).map(([key,value])=>`${key}=${value}`).join(', ')}`:'The pattern does not match this filename.'}</div>{/if}
  {#if groups&&panel.rows.length}{#each summarizeByGroup(panel.rows,'area',()=>Object.values(groups!).join(' / ')) as summary}<div class="measure-note">{summary.key}: n={summary.n}, mean area {formatNumber(summary.mean)} ± {formatNumber(summary.sem)} (SEM)</div>{/each}{/if}
</Section>
<Section title="Across images"><Field type="checkbox" label="Collect results from every image I measure" value={panel.collecting} title="Keeps each image's rows as you step through a collection, so one export covers the whole folder. Each row keeps the scale and threshold it was measured with." change={checked=>{panel.collecting=checked;if(!checked)panel.collected.clear();panel.refresh();}} />
  {#if panel.collecting}<div class="measure-note">{panel.collected.size?`${summaryRows.length} row(s) from ${panel.collected.size} image(s). The table below still shows this image, so clicking a row still finds its object.`:'Nothing collected yet. Step to the next image and its rows are added.'}</div>
    {#if panel.collected.size}<button class="measure-button" onclick={()=>{panel.collected.clear();panel.refresh();}}>Forget collected rows</button>{/if}
  {/if}
</Section>
{#if summaryRows.length>1}<Section title="Summary"><div class="measure-note">{panel.collecting&&panel.collected.size>1?`${summaryRows.length} row(s) across ${panel.collected.size} images. This is the line you actually write down.`:`${summaryRows.length} measured row(s). This is the line you actually write down.`}</div>
  <div class="measure-table-wrapper"><table class="measure-table"><thead><tr>{#each ['Column','n','Mean','SD','SEM','Min','Max'] as title}<th>{title}</th>{/each}</tr></thead><tbody>{#each summarizeRows(summaryRows) as entry}<tr><td>{entry.column}{unitFor(entry.column)}</td><td>{entry.summary.n}</td>{#each [entry.summary.mean,entry.summary.stdDev,entry.summary.sem,entry.summary.min,entry.summary.max] as value}<td>{formatNumber(value,5)}</td>{/each}</tr>{/each}</tbody></table></div>
</Section>{/if}
<Section title="Export"><div class="measure-button-row">
  {#each [['csv','CSV'],['csv-de','CSV (de)'],['xlsx','Excel .xlsx']] as [format,label]}<button class="measure-button" disabled={!summaryRows.length} onclick={()=>panel.exportTable(format as 'csv'|'csv-de'|'xlsx')}>{label}</button>{/each}
  <button class="measure-button" disabled={!summaryRows.length} onclick={()=>panel.exportPandasScript()}>pandas script</button>
</div><div class="measure-note">Long/tidy form: one row per ROI per channel with provenance on every row, so several exports concatenate without manual bookkeeping. "CSV (de)" uses a semicolon separator and a comma decimal mark for German-locale Excel. The pandas script is written from this session — the columns that exist, the scale in force, the threshold used, and your derived columns as real expressions.</div></Section>
