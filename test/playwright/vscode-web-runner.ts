import * as path from 'path';
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('TIFF Visualizer extension is now active in VS Code Web!');
    
    // Register a simple test command
    let disposable = vscode.commands.registerCommand('tiffVisualizer.test', () => {
        vscode.window.showInformationMessage('TIFF Visualizer test command executed!');
    });
    
    context.subscriptions.push(disposable);
}

export function deactivate() {} 