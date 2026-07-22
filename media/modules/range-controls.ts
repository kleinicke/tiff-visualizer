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

export function installRangeDoubleClickReset(root: Document): void {
	root.addEventListener('dblclick', event => {
		const input = event.target instanceof HTMLInputElement && event.target.type === 'range' ? event.target : null;
		if (!input) { return; }
		event.preventDefault();
		event.stopPropagation();
		resetRangeToDefault(input);
	});
}
