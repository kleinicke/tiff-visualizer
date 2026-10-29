<script lang="ts">
  import type { TranscriptsPanelModel } from '../../../media/modules/transcripts/transcripts-model';
  import SearchPicker from './SearchPicker.svelte';
  import GroupName from '../GroupName.svelte';
  import CopyJson from '../CopyJson.svelte';
  import { transcriptGroupsJson } from '../../../media/modules/groups-json';
  let { transcripts }: { transcripts: TranscriptsPanelModel } = $props();
  let open = $state(true);
  let query = $state('');
  let unfolded = $state<string[]>([]);
  const toggleFold = (name: string) => { unfolded = unfolded.includes(name) ? unfolded.filter(entry => entry !== name) : [...unfolded, name]; };
  let createMessage = $state<string | null>(null);
  const ready = $derived(transcripts.status === 'ready');
  const needle = $derived(query.trim().toLowerCase());
  const shown = $derived(needle ? transcripts.listed.filter(gene => gene.name.toLowerCase().includes(needle)) : transcripts.listed);
  const filtered = $derived(transcripts.filtering || !!needle);
  const names = () => (filtered ? shown.map(gene => gene.name) : undefined);
  function fromSelected() { createMessage = transcripts.groupFromSelected(names()); }
  function renamed(group: { name: string; rename: (name: string) => string | null }, next: string) {
    const before = group.name;
    const error = group.rename(next);
    if (!error) unfolded = unfolded.map(entry => entry === before ? next.trim() : entry);
    return error;
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
      {#if transcripts.status === 'idle' || transcripts.status === 'loading'}<div class="measure-note">{transcripts.message ?? 'Loading transcripts…'}</div>
      {:else if transcripts.status === 'error'}
        <div class="measure-note cells-source-error">{transcripts.message}</div>
        <button class="measure-button" onclick={transcripts.load}>Retry</button>
      {:else if transcripts.fetching > 0}<div class="measure-note">Reading {transcripts.fetching} {transcripts.fetching === 1 ? 'gene' : 'genes'}…{transcripts.readProgress ? ` ${transcripts.readProgress}` : ''}</div>
      {:else if transcripts.message}<div class="measure-note cells-source-error">{transcripts.message}</div>
      {/if}

      {#if ready && transcripts.genes.length}
        <details class="channels-global">
          <summary class="channels-section-title">{filtered ? `Filtered genes (${shown.length}/${transcripts.genes.length})` : `Added genes (${transcripts.genes.length})`}</summary>
          <div class="channels-toolbar">
            <button class="measure-button" title={filtered ? 'Switch the filtered genes on' : 'Switch every gene on'} onclick={() => transcripts.showAllListed(true, names())}>Select all</button>
            <button class="measure-button" title={filtered ? 'Switch the filtered genes off' : 'Switch every gene off'} onclick={() => transcripts.showAllListed(false, names())}>Deselect all</button>
            <button class="measure-button" title={filtered ? 'Take the filtered genes out of the list' : 'Take every gene out of the list'} onclick={() => transcripts.removeListed(names())}>Remove all</button>
          </div>
        </details>
      {/if}

      <details class="channel-groups">
        <summary>Groups ({transcripts.groups.length})</summary>
        {#each transcripts.groups as group (group.name)}
          {@const isFolded = !unfolded.includes(group.name)}
          <div class="transcript-group">
            <div class="channel-group-row transcript-group-row">
              <button class="channel-fold" aria-expanded={!isFolded} title={isFolded ? 'Show this group\'s options' : 'Hide this group\'s options'} onclick={() => toggleFold(group.name)}>{isFolded ? '▸' : '▾'}</button>
              <input type="checkbox" disabled={!ready || group.found === 0} checked={group.state === 'all'} indeterminate={group.state === 'some'}
                title={group.state === 'all' ? 'Hide this group\'s genes' : 'Add this group\'s genes to the list and show them'} onchange={group.toggle}>
              <input type="color" class="channel-swatch" value={group.color} title="Group colour" oninput={e => group.setColor(e.currentTarget.value)}>
              <GroupName name={group.name} rename={next => renamed(group, next)} />
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
                <button class="measure-chip" disabled={!ready} title="Take this group's genes out of the gene list" onclick={group.removeAll}>Remove genes</button>
                <CopyJson text={() => transcriptGroupsJson([group])} title="Copy the settings.json lines that define this group" />
              </div>
            {/if}
          </div>
        {/each}
        <SearchPicker items={() => transcripts.groupChoices.map(group => group.name)} placeholder="Add a group…" label="Add a gene group"
          detail={name => `${transcripts.groupChoices.find(group => group.name === name)?.size ?? 0} genes`} onpick={transcripts.addGroup} />
        <div class="transcript-new">
          <button class="measure-button" disabled={!ready || transcripts.genes.length === 0} title={filtered ? 'Make a group of the filtered genes that are switched on' : 'Make a group of the genes that are switched on'} onclick={fromSelected}>From selected genes</button>
          <CopyJson chip={false} label="Copy all as JSON" disabled={transcripts.groups.length === 0} text={() => transcriptGroupsJson(transcripts.groups)} title="Copy the settings.json lines that define every group in the viewer" />
        </div>
        {#if createMessage}<div class="measure-note cells-source-error">{createMessage}</div>{/if}
      </details>

      {#if transcripts.genes.length}
        <div class="channel-search">
          <input type="search" class="measure-input" placeholder="Filter genes…" aria-label="Filter genes by name" bind:value={query}>
          {#if filtered}<span class="channel-group-count">{shown.length}/{transcripts.genes.length}</span><button class="measure-chip" title="Clear the text and group filters" onclick={() => { query = ''; transcripts.clearFilter(); }}>Clear</button>{/if}
        </div>
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
          {#if filtered && shown.length === 0}<div class="measure-note">No gene matches the current filters.</div>{/if}
        </div>
      {/if}
      <SearchPicker items={transcripts.geneChoices} placeholder={ready ? 'Add a gene…' : 'Loading transcripts…'} label="Add a gene" disabled={!ready}
        detail={name => transcripts.geneCount(name).toLocaleString()} onpick={transcripts.addGene} />

      <label class="cells-field">
        <span>Min quality (QV)</span>
        <input type="range" min="0" max="40" class="channel-slider" value={transcripts.minQv} title="Hide transcripts below this quality value. 20 is the usual cut-off." oninput={e => transcripts.setMinQv(Number(e.currentTarget.value))}>
        <span class="channel-group-count">{transcripts.minQv}</span>
      </label>
      <label class="cells-field">
        <span>Dot size</span>
        <input type="range" min="50" max="400" class="channel-slider" value={Math.round(transcripts.size * 100)} oninput={e => transcripts.setSize(Number(e.currentTarget.value) / 100)}>
      </label>
      <label class="cells-field">
        <span>Dot opacity</span>
        <input type="range" min="5" max="100" class="channel-slider" value={Math.round(transcripts.opacity * 100)} title="How solid a dot is, matched across zoom levels. Above 90% the dots also gain extra ink, which shows when zoomed out." oninput={e => transcripts.setOpacity(Number(e.currentTarget.value) / 100)}>
        <span class="channel-group-count">{Math.round(transcripts.opacity * 100)}%</span>
      </label>
    </div>
  {/if}
</section>
