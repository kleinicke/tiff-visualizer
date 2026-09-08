<script lang="ts">
  import { onDestroy } from 'svelte';
  import { evaluateCurvePoints } from '../../media/modules/layer-compositor';
  type Point = { input: number; output: number };
  let { points, channel, commit, begin, end }: { points: Point[]; channel: string; commit: (points: Point[], interactive: boolean) => void; begin: () => void; end: () => void } = $props();
  let graph: SVGSVGElement;
  let invalid = $state(false);
  let cleanup = () => {};
  onDestroy(() => cleanup());
  const curve = $derived.by(() => {
    let path = '';
    for (let x = 0; x <= 255; x = Math.min(255, x + 2)) {
      path += `${x ? ' L' : 'M'} ${x} ${255 - evaluateCurvePoints(points, x)}`;
      if (x === 255) break;
    }
    return path;
  });
  function at(event: MouseEvent): Point {
    const bounds = graph.getBoundingClientRect();
    return { input: Math.max(0,Math.min(255,Math.round((event.clientX-bounds.left)/Math.max(1,bounds.width)*255))), output: Math.max(0,Math.min(255,Math.round(255-(event.clientY-bounds.top)/Math.max(1,bounds.height)*255))) };
  }
  function drag(event: PointerEvent, index: number) {
    event.preventDefault(); event.stopPropagation(); cleanup(); begin();
    const move = (event: PointerEvent) => {
      const next = at(event), latest = points.map(point => ({...point}));
      const low = index === 0 ? 0 : latest[index-1].input+1, high = index === latest.length-1 ? 255 : latest[index+1].input-1;
      latest[index] = { input: Math.max(low,Math.min(high,next.input)), output: next.output };
      commit(latest, true);
    };
    cleanup = () => { window.removeEventListener('pointermove',move); window.removeEventListener('pointerup',cleanup); window.removeEventListener('pointercancel',cleanup); window.removeEventListener('blur',cleanup); end(); cleanup = () => {}; };
    window.addEventListener('pointermove',move); window.addEventListener('pointerup',cleanup); window.addEventListener('pointercancel',cleanup); window.addEventListener('blur',cleanup);
  }
  function add(event: MouseEvent) { if ((event.target as Element).classList.contains('layer-curve-point')) return; const next = at(event); if (!points.some(point => point.input === next.input)) commit([...points,next].sort((a,b)=>a.input-b.input), false); }
  function parse(value: string) {
    const result = value.split(',').map(pair=>pair.trim().split(':').map(Number)).filter(pair=>pair.length===2 && pair.every(Number.isFinite)).map(([input,output])=>({input:Math.max(0,Math.min(255,input)),output:Math.max(0,Math.min(255,output))})).sort((a,b)=>a.input-b.input);
    invalid = result.length < 2; if (!invalid) commit(result,false);
  }
</script>
<!-- svelte-ignore a11y_no_noninteractive_element_interactions (The editable SVG points and text field provide the same curve operation.) -->
<svg class="layer-curve-graph" viewBox="0 0 255 255" role="img" aria-label="Editable tone curve" bind:this={graph} ondblclick={add}>
  <title>Drag points · Double-click empty space to add · Double-click a point to remove</title>
  <rect width="255" height="255" class="layer-curve-background" />
  {#each [63.75,127.5,191.25] as position}<line class="layer-curve-grid" x1={position} x2={position} y1="0" y2="255" /><line class="layer-curve-grid" x1="0" x2="255" y1={position} y2={position} />{/each}
  <line class="layer-curve-identity" x1="0" y1="255" x2="255" y2="0" />
  <path class={`layer-curve-path layer-curve-${channel}`} d={curve} />
  {#each points as point,index}
    <circle class={`layer-curve-point layer-curve-${channel}`} cx={point.input} cy={255-point.output} r="5" tabindex="0" role="button" aria-label={`Input ${point.input}, output ${point.output}`} onpointerdown={event=>drag(event,index)} ondblclick={event=>{event.preventDefault();event.stopPropagation();if(points.length>2)commit(points.filter((_,i)=>i!==index),false);}} onkeydown={event=>{ const delta = event.key==='ArrowUp'?1:event.key==='ArrowDown'?-1:0; if(delta){event.preventDefault();commit(points.map((p,i)=>i===index?{...p,output:Math.max(0,Math.min(255,p.output+delta))}:p),false);} }} />
  {/each}
</svg>
<label class="layer-adjustment-field layer-adjustment-points"><span>Points</span><input type="text" class="layer-adjustment-points-input" class:invalid title="Comma-separated input:output control points, for example 0:0, 128:160, 255:255" value={points.map(p=>`${p.input}:${p.output}`).join(', ')} onchange={e=>parse(e.currentTarget.value)}></label>
