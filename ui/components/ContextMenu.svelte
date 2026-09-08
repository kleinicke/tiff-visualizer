<script lang="ts">
  import type { Writable } from 'svelte/store';
  import type { MenuModel } from '../context-menu';
  let { model }: { model: Writable<MenuModel> } = $props();
</script>
<div class={`custom-context-menu ${$model.className || ''}`} role="menu" bind:this={$model.element}>
  {#each $model.items as item}
    {#if item.separator}<div class="context-menu-separator" role="separator"></div>
    {:else}<button type="button" class="context-menu-item" role="menuitem" onclick={event => { event.stopPropagation(); $model.close(); item.action?.(); }}>{item.label}</button>{/if}
  {/each}
</div>
