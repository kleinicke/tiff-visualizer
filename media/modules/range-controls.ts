/** Shared behavior for range controls created throughout the preview webview. */

export function resetRangeToDefault(input: HTMLInputElement): boolean {
	const configured = input.dataset.defaultValue;
	const attributeValue = input.getAttribute('value');
	let value = configured ?? attributeValue ?? (input.min || '0');
	const numeric = Number(value);
	const minimum = Number(input.min);
	const maximum = Number(input.max);
	if (Number.isFinite(numeric)) {
		let clamped = numeric;
		if (input.min !== '' && Number.isFinite(minimum)) { clamped = Math.max(minimum, clamped); }
		if (input.max !== '' && Number.isFinite(maximum)) { clamped = Math.min(maximum, clamped); }
		value = String(clamped);
	}
	if (input.value === value) { return false; }
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	input.dispatchEvent(new Event('change', { bubbles: true }));
	return true;
}

/**
 * Identity of a set of dataset axes, for deciding whether their sliders have to
 * be rebuilt.
 *
 * Rebuilding unconditionally is what made a DICOM slice slider undraggable:
 * moving it fires `input`, which requests a navigation, which re-renders the
 * overlay — and replacing the `<input>` mid-drag ends the drag, so the slider
 * could only ever advance one slice per press. Sliders must therefore survive
 * navigations, and only a genuine change in the axes (a different series, a
 * resized axis) may replace them.
 *
 * Size is part of the signature because a slider's `max` comes from it; label
 * is, because it is displayed. The *current position* deliberately is not —
 * that changes on every navigation and is written into the existing elements.
 */
export function datasetAxisSignature(
	axes: readonly { key: string; size: number; label: string }[]
): string {
	return axes.map(axis => `${axis.key}:${axis.size}:${axis.label}`).join('|');
}

export function installRangeDoubleClickReset(root: Document): void {
	root.addEventListener('dblclick', event => {
		const input = event.target instanceof HTMLInputElement && event.target.type === 'range' ? event.target : null;
		if (!input) { return; }
		event.preventDefault();
		event.stopPropagation();
		resetRangeToDefault(input);
	});
}
