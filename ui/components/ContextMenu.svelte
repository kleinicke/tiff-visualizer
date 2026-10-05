<script lang="ts">
  import type { Writable } from 'svelte/store';
  import type { MenuModel } from '../context-menu';
  let { model }: { model: Writable<MenuModel> } = $props();
</script>
<div class={`custom-context-menu ${$model.className || ''}`} role="menu" bind:this={$model.element}>
  {#each $model.items as item}
    {#if item.separator}<div class="context-menu-separator" role="separator"></div>
    {:else if item.heading}<div class="context-menu-heading" role="presentation">{item.label}</div>
    {:else}<button type="button" class="context-menu-item" role="menuitem" onclick={event => { event.stopPropagation(); $model.close(); item.action?.(); }}>{item.label}</button>{/if}
  {/each}
</div>

<style>
  .context-menu-heading { padding: 7px 10px 3px; font-size: 10px; font-weight: 600; opacity: .65; }
  .context-menu-heading:not(:first-child) { border-top: 1px solid var(--vscode-widget-border, #80808040); margin-top: 4px; }
</style>
