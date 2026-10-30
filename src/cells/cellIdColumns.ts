import * as vscode from 'vscode';

/** `tiffVisualizer.cells.cellIdCol`: other names for the cell id column of cell tables, as a clean list. */
export function getCellIdColumns(): string[] {
	const value = vscode.workspace.getConfiguration('tiffVisualizer.cells').get<unknown>('cellIdCol', []);
	const names = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
	return names.filter((name): name is string => typeof name === 'string' && name.trim() !== '').map(name => name.trim());
}
