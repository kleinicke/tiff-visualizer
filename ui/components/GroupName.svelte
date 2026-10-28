<script lang="ts">
  // A group's name. Double-click to rename; Enter or leaving the field saves, Escape cancels.
  let { name, rename, title = name }: { name: string; rename: (name: string) => string | null; title?: string } = $props();
  let editing = $state(false);
  let draft = $state('');
  let error = $state<string | null>(null);
  function begin() { draft = name; error = null; editing = true; }
  function commit() {
    if (!editing) return;
    error = rename(draft);
    if (!error) editing = false;
  }
  function cancel() { editing = false; error = null; }
  function focus(node: HTMLInputElement) { node.focus(); node.select(); }
</script>
{#if editing}
  <input class="measure-input group-rename" class:invalid={!!error} type="text" aria-label="Group name" title={error ?? 'Enter to save, Escape to cancel'} bind:value={draft} use:focus
    onclick={e => e.stopPropagation()} onkeydown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { e.preventDefault(); cancel(); } e.stopPropagation(); }} onblur={() => { if (error) cancel(); else commit(); }}>
{:else}
  <span class="channel-name" title="{title} (double-click to rename)" ondblclick={begin} role="textbox" tabindex="-1">{name}</span>
{/if}
