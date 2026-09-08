<script lang="ts">
  import type { NavigationControl } from '../navigation-model';
  let { spec, hint, held, hold }: { spec: NavigationControl; hint: string; held: () => boolean; hold: () => void } = $props();
  let control = $state<HTMLInputElement | HTMLSelectElement>();
  let displayed = $state(0);
  $effect(() => {
    const current = Math.min(Math.max(0, spec.value), Math.max(0, spec.size - 1));
    // A decode may finish while the user is still dragging or choosing a value.
    if (control && document.activeElement !== control && !held()) control.value = String(current);
    displayed = Number(control?.value ?? current);
  });
  function change() { if (control) { displayed = Number(control.value); spec.go(displayed); } }
</script>
<label class={spec.labels ? 'dataset-series-row' : 'dataset-axis'} data-nav-key={spec.key} data-axis={spec.label}>
  <span class="dataset-axis-label">{spec.label}</span>
  {#if spec.labels}
    <select class="dataset-series" tabindex="-1" bind:this={control} onchange={change}>
      {#each spec.labels as text, index}<option value={index}>{text || `${spec.label} ${index + 1}`}</option>{/each}
    </select>
  {:else}
    <input type="range" tabindex="-1" min="0" max={Math.max(0, spec.size - 1)} step="1" data-default-value="0" title={`${spec.label} · Double-click to reset`} bind:this={control} oninput={change} onpointerdown={hold}>
    <span class="dataset-axis-value" style:min-width={`${String(spec.size).length * 2 + 3}ch`}>{displayed + 1} / {spec.size}</span>
  {/if}
  <span class="dataset-axis-hint" title={hint ? `Step ${spec.label} with ${hint}` : ''}>{hint}</span>
</label>
