<script lang="ts">
  let { images, send }: { images: { webviewUri: string; filename: string; uri: string }[]; send: (message: { type: string; uri?: string }) => void } = $props();
</script>
<svelte:document onkeydown={e => { if (e.key === 'Escape') send({ type: 'closePanel' }); }} />
<div class="header"><h2>Image Comparison Panel</h2><div class="image-count">{images.length} images</div></div>
<div class="container"><div id="image-grid" class="image-grid">
  {#each images as image (image.uri)}
    <div class="image-item">
      <button class="preview-button" onclick={() => send({ type: 'openImageInMainEditor', uri: image.uri })} aria-label={`Open ${image.filename}`}><img class="image-preview" src={image.webviewUri} alt={image.filename} loading="lazy"></button>
      <div class="image-info">
        <div class="image-filename" title={image.filename}>{image.filename}</div>
        <div class="image-actions">
          <button class="action-button" data-action="open" data-uri={image.uri} onclick={() => send({ type: 'openImageInMainEditor', uri: image.uri })}>Open</button>
          <button class="action-button secondary" data-action="remove" data-uri={image.uri} onclick={() => send({ type: 'removeImage', uri: image.uri })}>Remove</button>
        </div>
      </div>
    </div>
  {:else}<div class="empty-state">No images to compare. Use "Select for Compare" from the context menu in an image editor.</div>{/each}
</div></div>
