<script lang="ts">
  // Copies text to the clipboard and says so for a moment.
  let { text, label = 'Copy as JSON', title, chip = true, disabled = false }: { text: () => string; label?: string; title: string; chip?: boolean; disabled?: boolean } = $props();
  let done = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function copy() {
    const value = text();
    let ok = false;
    try { await navigator.clipboard.writeText(value); ok = true; } catch { ok = false; }
    if (!ok) {
      const area = document.createElement('textarea');
      area.value = value;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      area.remove();
    }
    done = ok;
    clearTimeout(timer);
    timer = setTimeout(() => (done = false), 1500);
  }
</script>
<button class={chip ? 'measure-chip' : 'measure-button'} {disabled} title={title} onclick={copy}>{done ? 'Copied' : label}</button>
