  <footer class="web-status-bar" id="web-status-bar" aria-label="Image status and display controls">
    <span class="web-status-readout" id="web-status-size">—</span>
    <button type="button" id="web-status-options" data-status-action="options" title="Show all image actions">Options</button>
    <span class="web-status-separator" aria-hidden="true"></span>
    <button type="button" id="web-status-layers" data-status-action="layers" title="Add images as layers">Layers</button>
    <span class="web-status-separator" aria-hidden="true"></span>
    <button type="button" id="web-status-exposure" data-status-action="exposure">Exposure: +0.0 EV</button>
    <button type="button" id="web-status-gamma" data-status-action="gamma">γ: 2.2→2.2</button>
    <button type="button" id="web-status-normalization" data-status-action="normalization">Auto-Norm</button>
    <button type="button" id="web-status-zoom" data-status-action="zoom">Whole Image</button>
    <span class="web-status-readout web-status-bytes" id="web-status-bytes">—</span>
  </footer>
  <div class="web-control-popover" id="web-control-popover" role="dialog" aria-modal="false" aria-labelledby="web-control-title" hidden>
    <div class="web-control-heading">
      <strong id="web-control-title">Display settings</strong>
    </div>
    <div id="web-control-content"></div>
  </div>
  <div class="loading-indicator" aria-label="Loading image"></div>
  <div class="image-load-error"><p>The image could not be displayed.</p></div>
  <input id="web-file-input" class="web-file-input" type="file" multiple>
  <input id="web-import-input" class="web-file-input" type="file">

