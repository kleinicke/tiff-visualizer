<script lang="ts">
  let { label, value, change, type = 'number', min, max, step = 'any', title, placeholder }: { label: string; value: string | number | boolean; change: (value: any) => void; type?: 'number' | 'text' | 'checkbox'; min?: number; max?: number; step?: string; title?: string; placeholder?: string } = $props();
</script>
{#if type === 'checkbox'}
  <label class="measure-checkbox" {title}><input type="checkbox" checked={Boolean(value)} onchange={e => change(e.currentTarget.checked)}>{label}</label>
{:else}
  <label class="measure-row" {title}><span class="measure-label">{label}</span><input class="measure-input" {type} value={value as string | number} {min} {max} {step} {placeholder} onkeydown={e => e.stopPropagation()} onchange={e => { const v = type === 'number' ? parseFloat(e.currentTarget.value) : e.currentTarget.value; if (type !== 'number' || Number.isFinite(v)) change(v); }}></label>
{/if}
