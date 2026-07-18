"use strict";

import type { SettingsManager } from './settings-manager.js';
import type { TagEntry } from './tiff-tag-utils.js';

export interface VsCodeApi {
	postMessage: (msg: any) => any;
}

export interface MetadataInfo {
	formatLabel: string;
	fileFields: Record<string, string>;
	tags: TagEntry[];
	stats: { min: number; max: number; mean: number; std: number; validCount: number; nonFiniteCount: number; totalCount: number } | null;
}

/**
 * Metadata Panel Module
 *
 * Shows file/format info, image statistics, and — for TIFF/GeoTIFF — every
 * tag found in the file (main IFD plus Exif/GPS sub-IFDs), generically: no
 * curated subset, whatever the decoder found is listed here.
 */
export class MetadataPanel {
	settingsManager: SettingsManager;
	vscode: VsCodeApi;
	overlay: HTMLDivElement | null;
	body: HTMLDivElement | null;
	copyButton: HTMLButtonElement | null;
	isVisible: boolean;
	lastInfo: MetadataInfo | null;

	constructor(settingsManager: SettingsManager, vscode: VsCodeApi) {
		this.settingsManager = settingsManager;
		this.vscode = vscode;

		this.overlay = null;
		this.body = null;
		this.copyButton = null;
		this.isVisible = false;
		this.lastInfo = null;

		this.createOverlay();
	}

	createOverlay(): void {
		this.overlay = document.createElement('div');
		this.overlay.className = 'metadata-panel';
		this.overlay.style.display = 'none';

		const header = document.createElement('div');
		header.className = 'metadata-panel-header';

		const title = document.createElement('div');
		title.className = 'metadata-panel-title';
		title.textContent = 'Metadata';

		this.copyButton = document.createElement('button');
		this.copyButton.className = 'metadata-panel-button';
		this.copyButton.textContent = 'Copy as JSON';
		this.copyButton.title = 'Copy all metadata and statistics as JSON';
		this.copyButton.onclick = () => this.copyAsJson();

		const closeBtn = document.createElement('button');
		closeBtn.className = 'metadata-panel-close';
		closeBtn.textContent = '×';
		closeBtn.title = 'Close metadata panel';
		closeBtn.onclick = () => this.hide();

		header.appendChild(title);
		header.appendChild(this.copyButton);
		header.appendChild(closeBtn);

		this.body = document.createElement('div');
		this.body.className = 'metadata-panel-body';

		this.overlay.appendChild(header);
		this.overlay.appendChild(this.body);

		document.body.appendChild(this.overlay);
	}

	show(skipNotification = false): void {
		this.isVisible = true;
		if (this.overlay) this.overlay.style.display = 'flex';
		if (!skipNotification) {
			this.vscode.postMessage({ type: 'metadataVisibilityChanged', isVisible: true });
		}
	}

	hide(skipNotification = false): void {
		this.isVisible = false;
		if (this.overlay) this.overlay.style.display = 'none';
		if (!skipNotification) {
			this.vscode.postMessage({ type: 'metadataVisibilityChanged', isVisible: false });
		}
	}

	toggle(): void {
		if (this.isVisible) {
			this.hide();
		} else {
			this.show();
		}
	}

	getVisibility(): boolean {
		return this.isVisible;
	}

	formatNumber(value: number): string {
		if (!Number.isFinite(value)) { return String(value); }
		if (Math.abs(value) !== 0 && (Math.abs(value) < 0.001 || Math.abs(value) >= 100000)) {
			return value.toExponential(3);
		}
		return value.toPrecision(6).replace(/\.?0+$/, '') || '0';
	}

	createSection(title: string, open: boolean): { details: HTMLDetailsElement; content: HTMLDivElement } {
		const details = document.createElement('details');
		details.className = 'metadata-panel-section';
		details.open = open;

		const summary = document.createElement('summary');
		summary.textContent = title;
		details.appendChild(summary);

		const content = document.createElement('div');
		content.className = 'metadata-panel-section-content';
		details.appendChild(content);

		return { details, content };
	}

	appendRow(parent: HTMLElement, name: string, value: string): void {
		const row = document.createElement('div');
		row.className = 'metadata-panel-row';

		const nameSpan = document.createElement('span');
		nameSpan.className = 'metadata-panel-row-name';
		nameSpan.textContent = name;

		const valueSpan = document.createElement('span');
		valueSpan.className = 'metadata-panel-row-value';
		valueSpan.textContent = value;
		valueSpan.title = value;

		row.appendChild(nameSpan);
		row.appendChild(valueSpan);
		parent.appendChild(row);
	}

	render(info: MetadataInfo | null): void {
		this.lastInfo = info;
		if (!this.body) { return; }
		this.body.textContent = '';

		if (!info) {
			const empty = document.createElement('div');
			empty.className = 'metadata-panel-empty';
			empty.textContent = 'No metadata available for this image.';
			this.body.appendChild(empty);
			return;
		}

		// File section
		const fileSection = this.createSection(`File (${info.formatLabel})`, true);
		for (const [name, value] of Object.entries(info.fileFields)) {
			this.appendRow(fileSection.content, name, value);
		}
		this.body.appendChild(fileSection.details);

		// Statistics section
		if (info.stats) {
			const statsSection = this.createSection('Statistics', true);
			const s = info.stats;
			this.appendRow(statsSection.content, 'Min', this.formatNumber(s.min));
			this.appendRow(statsSection.content, 'Max', this.formatNumber(s.max));
			this.appendRow(statsSection.content, 'Mean', this.formatNumber(s.mean));
			this.appendRow(statsSection.content, 'Std Dev', this.formatNumber(s.std));
			this.appendRow(statsSection.content, 'Valid Samples', `${s.validCount.toLocaleString()} / ${s.totalCount.toLocaleString()}`);
			if (s.nonFiniteCount > 0) {
				this.appendRow(statsSection.content, 'NaN/Infinite', s.nonFiniteCount.toLocaleString());
			}
			this.body.appendChild(statsSection.details);
		}

		// Tag sections, grouped, in a stable order with the main tag table first.
		if (info.tags && info.tags.length > 0) {
			const groups = new Map<string, TagEntry[]>();
			for (const entry of info.tags) {
				const group = entry.group || 'Tags';
				if (!groups.has(group)) { groups.set(group, []); }
				(groups.get(group) as TagEntry[]).push(entry);
			}
			const groupOrder = ['TIFF', 'GeoKeys', 'Exif', 'GPS'];
			const orderedGroups = [
				...groupOrder.filter(g => groups.has(g)),
				...Array.from(groups.keys()).filter(g => !groupOrder.includes(g))
			];
			for (const group of orderedGroups) {
				const entries = groups.get(group) || [];
				const section = this.createSection(`${group} Tags (${entries.length})`, group === 'TIFF');
				for (const entry of entries) {
					this.appendRow(section.content, entry.name, entry.value);
				}
				this.body.appendChild(section.details);
			}
		}
	}

	async copyAsJson(): Promise<void> {
		if (!this.lastInfo || !this.copyButton) { return; }
		const text = JSON.stringify(this.lastInfo, null, 2);
		const originalLabel = this.copyButton.textContent;
		try {
			await navigator.clipboard.writeText(text);
			this.copyButton.textContent = 'Copied!';
		} catch {
			this.copyButton.textContent = 'Copy failed';
		}
		setTimeout(() => {
			if (this.copyButton) { this.copyButton.textContent = originalLabel; }
		}, 1500);
	}
}
