<script lang="ts">
  import type { Writable } from 'svelte/store';
  import type { CellsPanelView } from '../../../media/modules/cells/cells-panel';
  import { panelGestures } from '../../panel-gestures';
  import CellsSection from './CellsSection.svelte';
  let { model }: { model: Writable<CellsPanelView> } = $props();
</script>
<div class="channels-panel cells-panel" style:display={$model.visible ? 'flex' : 'none'} use:panelGestures={'channels-header'}>
  <div class="channels-header" style:cursor="move">
    <div class="channels-title">Cells</div><div class="channels-spacer"></div>
    <button class="measure-close" title="Close the cells panel" onclick={$model.close}>×</button>
  </div>
  <div class="channels-body"><CellsSection cells={$model.cells} headless /></div>
</div>
