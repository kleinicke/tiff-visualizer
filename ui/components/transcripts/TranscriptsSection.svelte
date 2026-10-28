<script lang="ts">
  import type { TranscriptsPanelModel } from '../../../media/modules/transcripts/transcripts-model';
  import SearchPicker from './SearchPicker.svelte';
  let { transcripts }: { transcripts: TranscriptsPanelModel } = $props();
  let open = $state(true);
  let query = $state('');
  let unfolded = $state<string[]>([]);
  const toggleFold = (name: string) => { unfolded = unfolded.includes(name) ? unfolded.filter(entry => entry !== name) : [...unfolded, name]; };
  let creating = $state(false);
  let newName = $state('');
  let newGenes = $state('');
  let createMessage = $state<string | null>(null);
  const ready = $derived(transcripts.status === 'ready');
  const needle = $derived(query.trim().toLowerCase());
  const shown = $derived(needle ? transcripts.listed.filter(gene => gene.name.toLowerCase().includes(needle)) : transcripts.listed);
  const filtered = $derived(transcripts.filtering || !!needle);
  function create(event: Event) {
    event.preventDefault();
    createMessage = transcripts.createGroup(newName, newGenes);
    if (!createMessage) { newName = ''; newGenes = ''; creating = false; }
  }
  function fromListed() {
    const name = newName.trim() || `Group ${transcripts.groups.length + 1}`;
    createMessage = transcripts.groupFromListed(name);
    if (!createMessage) newName = '';
  }
</script>
<section class="cells-section transcripts-section">
  <div class="cells-header">
    <button class="channel-fold" aria-expanded={open} title={open ? 'Collapse the Transcripts section' : 'Expand the Transcripts section'} onclick={() => (open = !open)}>{open ? '▾' : '▸'}</button>
    <div class="cells-title">Transcripts</div><div class="channels-spacer"></div>
    {#if ready}<span class="channel-group-count" title="Transcripts in the file">{transcripts.points.toLocaleString()}</span>{/if}
  </div>
  {#if open}
    <div class="cells-body">
      {#if transcripts.status === 'idle'}
        <button class="measure-button" onclick={transcripts.load}>Load transcripts</button>
      {:else if transcripts.status === 'loading'}<div class="measure-note">{transcripts.message ?? 'Loading transcripts…'}</div>
      {:else if transcripts.status === 'error'}
        <div class="measure-note cells-source-error">{transcripts.message}</div>
        <button class="measure-button" onclick={transcripts.load}>Retry</button>
      {:else if transcripts.fetching > 0}<div class="measure-note">Reading {transcripts.fetching} {transcripts.fetching === 1 ? 'gene' : 'genes'}…{transcripts.readProgress ? ` ${transcripts.readProgress}` : ''}</div>
      {:else if transcripts.message}<div class="measure-note cells-source-error">{transcripts.message}</div>
      {/if}

      <details class="channel-groups" open>
        <summary>Groups ({transcripts.groups.length})</summary>
        {#each transcripts.groups as group (group.name)}
          {@const isFolded = !unfolded.includes(group.name)}
          <div class="transcript-group">
            <div class="channel-group-row transcript-group-row">
              <button class="channel-fold" aria-expanded={!isFolded} title={isFolded ? 'Show this group\'s options' : 'Hide this group\'s options'} onclick={() => toggleFold(group.name)}>{isFolded ? '▸' : '▾'}</button>
              <input type="checkbox" disabled={!ready || group.found === 0} checked={group.state === 'all'} indeterminate={group.state === 'some'}
                title={group.state === 'all' ? 'Hide this group\'s genes' : 'Add this group\'s genes to the list and show them'} onchange={group.toggle}>
              <input type="color" class="channel-swatch" value={group.color} title="Group colour" oninput={e => group.setColor(e.currentTarget.value)}>
              <span class="channel-name" title={group.name}>{group.name}</span>
              <span class="channel-group-count" title={ready ? `${group.on} of ${group.found} genes shown${group.missing.length ? `. Not in the file: ${group.missing.join(', ')}` : ''}` : `${group.total} genes`}>{ready ? `${group.on}/${group.found}` : group.total}</span>
              <button class="group-filter" class:active={group.filtering} disabled={!ready} aria-pressed={group.filtering}
                title={group.filtering ? 'Stop filtering the gene list to this group' : 'Show only this group in the gene list. Several groups combine (union).'} onclick={group.toggleFilter}>
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M1.5 2h13L9.5 8.5V14l-3-1.5V8.5z" fill="currentColor"/></svg>
              </button>
              <button class="cells-source-remove" title="Take this group out of the viewer. Its genes stay listed." aria-label="Remove group {group.name}" onclick={group.remove}>×</button>
            </div>
            {#if !isFolded}
              <div class="transcript-group-options">
                <button class="measure-chip" class:active={group.palette} aria-pressed={group.palette}
                  title={group.palette ? 'Each gene has its own colour, built around the group colour (compare genes within the group). Click for one tint.' : 'The whole group has one tint (compare groups). Click to give each gene its own colour.'}
                  onclick={() => group.setPalette(!group.palette)}>{group.palette ? 'Palette' : 'Tint'}</button>
                <button class="measure-chip" disabled={!ready} title="Take this group's genes out of the gene list" onclick={group.removeAll}>Remove all</button>
              </div>
            {/if}
          </div>
        {/each}
        <SearchPicker items={() => transcripts.groupChoices.map(group => group.name)} placeholder="Add a group…" label="Add a gene group"
          detail={name => `${transcripts.groupChoices.find(group => group.name === name)?.size ?? 0} genes`} onpick={transcripts.addGroup} />
        <div class="transcript-new">
          <button class="measure-button" aria-expanded={creating} onclick={() => (creating = !creating)}>{creating ? 'Cancel' : 'New group…'}</button>
          <button class="measure-button" disabled={!ready || transcripts.genes.length === 0} title="Make a group of the genes in the list" onclick={fromListed}>From listed genes</button>
        </div>
        {#if creating}
          <form class="transcript-create" onsubmit={create}>
            <input type="text" class="measure-input" placeholder="Group name" aria-label="Group name" bind:value={newName}>
            <textarea class="measure-input" rows="3" placeholder="Gene names, separated by spaces, commas or new lines" aria-label="Gene names" spellcheck="false" bind:value={newGenes}></textarea>
            <button type="submit" class="measure-button" disabled={!newName.trim() || !newGenes.trim()}>Create</button>
          </form>
        {/if}
        {#if createMessage}<div class="measure-note cells-source-error">{createMessage}</div>{/if}
      </details>

      <details class="channel-groups" open>
        <summary>Genes ({transcripts.genes.length})</summary>
        <SearchPicker items={transcripts.geneChoices} placeholder={ready ? 'Add a gene…' : 'Load transcripts to add genes'} label="Add a gene" disabled={!ready}
          detail={name => transcripts.geneCount(name).toLocaleString()} onpick={transcripts.addGene} />
        {#if transcripts.genes.length}
          <div class="channel-search">
            <input type="search" class="measure-input" placeholder="Filter the list…" aria-label="Filter the gene list" bind:value={query}>
            {#if filtered}<span class="channel-group-count">{shown.length}/{transcripts.genes.length}</span><button class="measure-chip" title="Clear the text and group filters" onclick={() => { query = ''; transcripts.clearFilter(); }}>Clear</button>{/if}
          </div>
          <details class="channels-global">
            <summary class="channels-section-title">{filtered ? `Listed genes (${shown.length}/${transcripts.genes.length})` : 'All genes'}</summary>
            <div class="channels-toolbar">
              <button class="measure-button" title={filtered ? 'Switch the listed genes on' : 'Switch every gene on'} onclick={() => transcripts.showAllListed(true)}>Show all</button>
              <button class="measure-button" title={filtered ? 'Switch the listed genes off' : 'Switch every gene off'} onclick={() => transcripts.showAllListed(false)}>Hide all</button>
              <button class="measure-button" title="Take every gene out of the list" onclick={transcripts.clearGenes}>Remove all</button>
            </div>
          </details>
          <div class="transcript-genes">
            {#each shown as gene (gene.name)}
              <div class="channel-row-top transcript-gene" class:dimmed={!gene.visible}>
                <input type="checkbox" checked={gene.visible} title="Show this gene" onchange={e => gene.setVisible(e.currentTarget.checked)}>
                {#if gene.grouped}<span class="transcript-dot" style:background={gene.color} title="Coloured by its group"></span>
                {:else}<input type="color" class="channel-swatch" value={gene.color} title="Gene colour" oninput={e => gene.setColor(e.currentTarget.value)}>{/if}
                <span class="channel-name" title={gene.name}>{gene.name}</span>
                <span class="channel-group-count" title={gene.loading ? 'Reading its positions…' : 'Transcripts in the file'}>{gene.loading ? '…' : gene.count.toLocaleString()}</span>
                <button class="cells-source-remove" title="Take this gene out of the list" aria-label="Remove {gene.name}" onclick={gene.remove}>×</button>
              </div>
            {/each}
            {#if filtered && shown.length === 0}<div class="measure-note">No listed gene matches the filters.</div>{/if}
          </div>
        {/if}
      </details>

      <label class="cells-field">
        <span>Min quality (QV)</span>
        <input type="range" min="0" max="40" class="channel-slider" value={transcripts.minQv} title="Hide transcripts below this quality value. 20 is the usual cut-off." oninput={e => transcripts.setMinQv(Number(e.currentTarget.value))}>
        <span class="channel-group-count">{transcripts.minQv}</span>
      </label>
      <label class="cells-field">
        <span>Dot size</span>
        <input type="range" min="50" max="400" class="channel-slider" value={Math.round(transcripts.size * 100)} oninput={e => transcripts.setSize(Number(e.currentTarget.value) / 100)}>
      </label>
    </div>
  {/if}
</section>
