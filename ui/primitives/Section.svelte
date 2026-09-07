<script lang="ts">
  import type { Snippet } from 'svelte';
  let { title, children, open = true }: { title: string; children: Snippet; open?: boolean } = $props();
</script>

<details {open} class="section">
  <summary>{title}</summary>
  <div class="content">{@render children()}</div>
</details>

<style>
  .section { border-top: 1px solid var(--viewer-border); }
  summary { padding: 13px 16px; cursor: pointer; font-weight: 600; font-size: 12px; user-select: none; }
  summary::marker { color: var(--viewer-muted); font-size: 10px; }
  .content { padding: 0 16px 16px; display: grid; gap: 12px; }
</style>
