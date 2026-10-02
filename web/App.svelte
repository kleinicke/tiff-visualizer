<script lang="ts">
  import ViewerChrome from "./ViewerChrome.svelte";
</script>
  <header class="web-toolbar" aria-label="Viewer toolbar">
    <a class="web-brand" href="./" aria-label="Scientific Image Visualizer home">
      <span class="web-brand-mark" aria-hidden="true">SI</span>
      <span>
        <strong>Scientific Image Visualizer</strong>
        <small>Local browser viewer</small>
      </span>
    </a>
    <div class="web-image-tabs-shell" id="web-image-tabs-shell" hidden>
      <button type="button" class="web-image-tabs-scroll" id="web-image-tabs-previous" aria-label="Scroll image tabs left">‹</button>
      <div class="web-image-tabs" id="web-image-tabs" role="tablist" aria-label="Open images"></div>
      <button type="button" class="web-image-tabs-scroll" id="web-image-tabs-next" aria-label="Scroll image tabs right">›</button>
    </div>
    <nav class="web-actions" aria-label="Image tools">
      <button type="button" data-web-action="open" data-supported-formats>Open files</button>
      <button type="button" data-web-action="open-url">Open URL</button>
      <button type="button" class="web-more-button" data-web-action="more" aria-expanded="false" aria-controls="web-more-menu">More</button>
    </nav>
    <div class="web-more-menu" id="web-more-menu" hidden>
      <button type="button" data-web-action="install">Install app…</button>
      <button type="button" data-web-command="tiffVisualizer.copyImage">Copy image</button>
      <button type="button" data-web-command="tiffVisualizer.exportLayers">Export current view</button>
      <button type="button" data-web-command="tiffVisualizer.openAsPointCloud" data-web-point-cloud hidden>Open as point cloud</button>
      <button type="button" data-web-command="tiffVisualizer.toggleNanColor">Cycle no-value colour</button>
      <button type="button" data-web-action="theme">Toggle light theme</button>
      <button type="button" data-web-action="loading-log">Loading log</button>
      <a href="https://github.com/kleinicke/tiff-visualizer" target="_blank" rel="noreferrer">Source and documentation</a>
    </div>
  </header>

  <div class="web-log-panel" id="web-log-panel" role="dialog" aria-modal="false" aria-labelledby="web-log-title" hidden>
    <div class="web-log-heading">
      <div>
        <span class="web-log-eyebrow">Diagnostics</span>
        <strong id="web-log-title">Loading log</strong>
      </div>
      <button type="button" class="web-log-close" data-web-action="close-loading-log" aria-label="Close loading log">×</button>
    </div>
    <p class="web-log-description">Timings from images opened during this page session.</p>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (The scrollable log must be keyboard accessible.) -->
    <pre class="web-log-output" id="web-log-output" role="log" tabindex="0" aria-live="polite"><span class="web-log-empty">Open an image to record its loading times.</span></pre>
    <div class="web-log-actions">
      <button type="button" data-web-action="clear-loading-log">Clear</button>
      <button type="button" data-web-action="copy-loading-log">Copy log</button>
    </div>
  </div>

  <dialog class="web-url-dialog" id="web-url-dialog" aria-labelledby="web-url-dialog-title">
    <form id="web-url-dialog-form">
      <strong id="web-url-dialog-title">Open image from URL</strong>
      <label for="web-url-dialog-input">Image URL</label>
      <input id="web-url-dialog-input" type="text" inputmode="url" spellcheck="false"
        placeholder="https://example.com/scene.tif" aria-describedby="web-url-dialog-note">
      <p id="web-url-dialog-note">Use ↑/↓ to recall previously entered URLs.</p>
      <div class="web-url-dialog-actions">
        <button type="button" data-web-action="close-url-dialog">Cancel</button>
        <button type="submit">Open</button>
      </div>
    </form>
  </dialog>

  <main class="web-empty-state" id="web-empty-state">
    <button type="button" class="web-drop-zone" data-web-action="open" data-supported-formats>
      <span class="web-drop-symbol" aria-hidden="true">↓</span>
      <strong>Drop images here</strong>
      <span>or click to choose files</span>
    </button>
    <form class="web-url-form" id="web-url-form">
      <label class="web-url-label" for="web-url-input">…or open one from a link</label>
      <div class="web-url-row">
        <!-- type="text", not type="url": the field accepts what the opener
             accepts (a full link, a bare host, a path), and the browser's
             built-in url validation would silently block those. -->
        <input id="web-url-input" class="web-url-input" type="text" inputmode="url" spellcheck="false"
          placeholder="https://example.com/scene.tif" aria-label="Image URL">
        <button type="submit" class="web-url-submit">Open</button>
      </div>
      <p class="web-url-note">Read straight from the host into this tab. TIFF detail streams when the host supports it; otherwise the file downloads. Use ↑/↓ for URL history.</p>
    </form>
    <section class="web-examples" aria-label="Example images">
      <strong>Try an example</strong>
      <div class="web-example-buttons">
        <button type="button" data-example-url="https://data.source.coop/ausantarctic/gebco/GEBCO_2026.tif">Global terrain <small>3.29 GB · streaming TIFF</small></button>
        <button type="button" data-example-url="https://gitlab.com/api/v4/projects/scikit-image%2Fdata/repository/files/cells3d.tif/raw?ref=master">Microscopy <small>60 slices × 2 channels · 11.4 MB</small></button>
        <button type="button" data-example-url="https://huggingface.co/datasets/yanmorona/UE4-Stereo/resolve/main/scene_1/sequence01/depth_npy/000000.npy">Stereo depth <small>Synthetic · metres · 1.23 MB</small></button>
      </div>
      <details class="web-example-credits">
        <summary>Sources and licenses</summary>
        <p>Terrain: <a href="https://doi.org/10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa" target="_blank" rel="noreferrer">GEBCO Bathymetric Compilation Group 2026 — GEBCO_2026 Grid</a>, hosted as a cloud-optimized TIFF by the Australian Antarctic Division. Public domain under <a href="https://www.gebco.net/data-products/gridded-bathymetry-data" target="_blank" rel="noreferrer">GEBCO’s terms</a>. Not for navigation; no endorsement implied.</p>
        <p>Microscopy: Allen Institute for Cell Science, distributed by <a href="https://gitlab.com/scikit-image/data" target="_blank" rel="noreferrer">scikit-image</a> under <a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noreferrer">CC0</a>.</p>
        <p>Depth: Morona, Pinto &amp; Regner (2026), <a href="https://huggingface.co/datasets/yanmorona/UE4-Stereo" target="_blank" rel="noreferrer">UE4-Stereo</a>, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>. Unmodified synthetic ground-truth depth accompanying stereo images; display adjustments do not change the source data.</p>
      </details>
    </section>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard focus reveals the supported-format tooltip.) -->
    <p class="web-local-note">Files stay on this device · <span class="web-format-hint" role="note" data-supported-formats tabindex="0">Supported formats</span></p>
  </main>

  <div class="web-drop-overlay" id="web-drop-overlay" aria-hidden="true">
    <strong>Drop images to open</strong>
    <span>Multiple files open as tabs</span>
  </div>
  <div class="web-toast-region" id="web-toast-region" aria-live="polite" aria-atomic="true"></div>
  <nav class="web-legal-nav" aria-label="Legal and portfolio links">
    <a href="/guide.html">Help</a>
    <a href="https://f-kleinicke.de/">About</a>
    <a href="https://f-kleinicke.de/impressum.html">Impressum</a>
    <a href="https://f-kleinicke.de/datenschutz.html">Datenschutz</a>
  </nav>

<ViewerChrome />
