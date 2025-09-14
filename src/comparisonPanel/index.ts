import * as vscode from 'vscode';
import { ComparisonPanel } from './comparisonPanel';

export { ComparisonPanel } from './comparisonPanel';

export function registerComparisonPanelSupport(context: vscode.ExtensionContext): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];

	// Register commands
	disposables.push(
		vscode.commands.registerCommand('tiffVisualizer.openComparisonPanel', (uri?: vscode.Uri) => {
			const panel = ComparisonPanel.create(context.extensionUri);
			if (uri) {
				panel.addImage(uri);
			}
		})
	);

	disposables.push(
		vscode.commands.registerCommand('tiffVisualizer.addToComparisonPanel', (uri: vscode.Uri) => {
			const panel = ComparisonPanel.create(context.extensionUri);
			panel.addImage(uri);
		})
	);

	// Register webview serializer for persistence across VS Code restarts
	disposables.push(
		vscode.window.registerWebviewPanelSerializer(ComparisonPanel.viewType, {
			async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: any) {
				console.log('Deserializing comparison panel');
				ComparisonPanel.revive(webviewPanel, context.extensionUri);
			}
		})
	);

	return vscode.Disposable.from(...disposables);
}