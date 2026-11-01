<script lang="ts">
  let { items, placeholder, label, detail, disabled = false, onpick }: {
    items: () => string[]; placeholder: string; label: string; detail?: (item: string) => string; disabled?: boolean; onpick: (item: string) => void;
  } = $props();
  const LIMIT = 100;
  let query = $state('');
  let open = $state(false);
  let active = $state(0);
  const matches = $derived.by(() => {
    if (!open) return { shown: [] as string[], total: 0 };
    const needle = query.trim().toLowerCase();
    const all = items();
    const hits = needle ? all.filter(item => item.toLowerCase().includes(needle)) : all;
    // Names that start with the text come first.
    const ordered = needle ? [...hits.filter(item => item.toLowerCase().startsWith(needle)), ...hits.filter(item => !item.toLowerCase().startsWith(needle))] : hits;
    return { shown: ordered.slice(0, LIMIT), total: ordered.length };
  });
  function pick(item: string) { onpick(item); active = Math.min(active, Math.max(0, matches.shown.length - 2)); }
  function key(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') { open = true; active = Math.min(active + 1, matches.shown.length - 1); event.preventDefault(); }
    else if (event.key === 'ArrowUp') { active = Math.max(active - 1, 0); event.preventDefault(); }
    else if (event.key === 'Enter') { const item = matches.shown[active]; if (item) pick(item); event.preventDefault(); }
    else if (event.key === 'Escape') { open = false; event.stopPropagation(); }
  }
</script>
<div class="search-picker">
  <input type="text" class="measure-input" {placeholder} aria-label={label} {disabled} spellcheck="false" autocomplete="off" bind:value={query}
    onfocus={() => { open = true; active = 0; }} onblur={() => setTimeout(() => { open = false; query = ''; }, 120)} oninput={() => { open = true; active = 0; }} onkeydown={key}>
  {#if open && !disabled}
    <ul class="search-picker-list" role="listbox" aria-label={label}>
      {#each matches.shown as item, index (item)}
        <li role="option" aria-selected={index === active} class:active={index === active}>
          <button type="button" tabindex="-1" onmousedown={event => { event.preventDefault(); pick(item); }}>
            <span class="channel-name">{item}</span>{#if detail}<span class="channel-group-count">{detail(item)}</span>{/if}
          </button>
        </li>
      {/each}
      {#if matches.total === 0}<li class="search-picker-note">No match.</li>
      {:else if matches.total > LIMIT}<li class="search-picker-note">{matches.total - LIMIT} more — keep typing to narrow the list.</li>{/if}
    </ul>
  {/if}
</div>
