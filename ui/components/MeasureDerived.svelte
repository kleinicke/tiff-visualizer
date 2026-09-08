<script lang="ts">
  import { untrack } from 'svelte';
  import type { MeasurePanel } from '../../media/modules/measure-panel';
  import { compileExpression, ExpressionError } from '../../media/modules/measure/expression';
  let { panel, index }: { panel: MeasurePanel; index: number } = $props();
  const column = $derived(panel.derivedColumns[index]);
  let expression = $state(untrack(() => column.expression));
  const error = $derived.by(() => {try {compileExpression(expression);return '';}catch(error){return error instanceof ExpressionError?`${error.message} at position ${error.position+1}`:(error as Error).message;}});
</script>
<div><div class="measure-derived-row">
  <input class="measure-input measure-derived-name" aria-label="Column name" value={column.name} onkeydown={e=>e.stopPropagation()} onchange={e=>{column.name=e.currentTarget.value.trim()||column.name;panel.render();}}>
  <input class="measure-input measure-derived-expression" class:invalid={!!error} aria-label="Column expression" bind:value={expression} onkeydown={e=>e.stopPropagation()} onchange={()=>{column.expression=expression;panel.render();}}>
  <button class="measure-roi-remove" title="Remove derived column" onclick={()=>{panel.derivedColumns.splice(index,1);panel.render();}}>×</button>
</div><div class="measure-error">{error}</div></div>
