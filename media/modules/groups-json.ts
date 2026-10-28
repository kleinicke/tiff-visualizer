/** The settings.json lines that define groups, for the panels' Copy as JSON buttons. */

const list = (items: readonly (string | number)[]): string => `[${items.map(item => JSON.stringify(item)).join(', ')}]`;

/** `"tiffVisualizer.channels.groups": { … }` with one entry per group; members are channel names or 1-based numbers. */
export function channelGroupsJson(groups: readonly { name: string; members: readonly (string | number)[] }[]): string {
	const entries = groups.map(group => `\t${JSON.stringify(group.name)}: ${list(group.members)}`);
	return `"tiffVisualizer.channels.groups": {\n${entries.join(',\n')}\n}`;
}

/** `"tiffVisualizer.transcripts.groups": { … }` with one entry per group. */
export function transcriptGroupsJson(groups: readonly { name: string; genes: readonly string[]; color: string }[]): string {
	const entries = groups.map(group => `\t${JSON.stringify(group.name)}: { "genes": ${list(group.genes)}, "color": ${JSON.stringify(group.color)} }`);
	return `"tiffVisualizer.transcripts.groups": {\n${entries.join(',\n')}\n}`;
}
