<script lang="ts">
  import type { Snippet } from 'svelte';
  let { title, children }: { title: string; children: Snippet } = $props();
</script>
<div class="measure-section"><div class="measure-section-title">{title}</div>{@render children()}</div>
