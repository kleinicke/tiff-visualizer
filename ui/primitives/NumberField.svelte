<script lang="ts">
  let { label, value, min, max, onchange }: {
    label: string; value: number; min?: number; max?: number; onchange: (value: number) => void;
  } = $props();
  function commit(event: Event) {
    const field = event.currentTarget as HTMLInputElement;
    if (field.value !== '' && field.checkValidity() && Number.isFinite(field.valueAsNumber)) {
      onchange(field.valueAsNumber);
    } else {
      field.reportValidity();
      field.value = String(value);
    }
  }
</script>

<label>
  <span>{label}</span>
  <input type="number" {value} {min} {max} step="any" required onchange={commit} />
</label>

<style>
  label { display: grid; grid-template-columns: 1fr 110px; align-items: center; gap: 12px; }
  span { color: var(--viewer-muted); }
  input { min-width: 0; width: 100%; box-sizing: border-box; font: inherit; font-variant-numeric: tabular-nums; color: var(--viewer-text); background: var(--viewer-input); border: 1px solid var(--viewer-border); border-radius: 4px; padding: 6px 8px; }
  input:focus-visible { outline: 2px solid var(--viewer-accent); outline-offset: 1px; }
</style>
