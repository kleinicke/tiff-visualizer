import * as path from 'path';
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('TIFF Visualizer extension is now active in VS Code Web!');
    
    // Register a command to open test files
    let openTestFileCommand = vscode.commands.registerCommand('tiffVisualizer.openTestFile', async (filePath: string) => {
        console.log('Opening test file:', filePath);
        
        try {
            const uri = vscode.Uri.file(filePath);
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document, {
                viewColumn: vscode.ViewColumn.One,
                preview: false
            });
            console.log('Test file opened successfully');
        } catch (error) {
            console.error('Error opening test file:', error);
            vscode.window.showErrorMessage(`Failed to open test file: ${error}`);
        }
    });
    
    // Register a command to get workspace information
    let getWorkspaceInfoCommand = vscode.commands.registerCommand('tiffVisualizer.getWorkspaceInfo', () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const info = {
            workspaceFolders: workspaceFolders?.map(folder => ({
                name: folder.name,
                uri: folder.uri.toString()
            })) || [],
            activeTextEditor: vscode.window.activeTextEditor?.document.fileName || null
        };
        console.log('Workspace info:', info);
        return info;
    });
    
    // Register a command to list available test images
    let listTestImagesCommand = vscode.commands.registerCommand('tiffVisualizer.listTestImages', () => {
        const testImages = [
            'img_deflate_uint8_pred2.tif',
            'depth_deflate_32_pred3.tif',
            'img_deflate_uint8.tif',
            'depth_deflate_32.tif'
        ];
        console.log('Available test images:', testImages);
        return testImages;
    });
    
    // Register a simple test command
    let testCommand = vscode.commands.registerCommand('tiffVisualizer.test', () => {
        vscode.window.showInformationMessage('TIFF Visualizer test command executed!');
        console.log('Test command executed');
    });
    
    context.subscriptions.push(
        openTestFileCommand,
        getWorkspaceInfoCommand,
        listTestImagesCommand,
        testCommand
    );
    
    // Log when the extension is ready
    console.log('TIFF Visualizer test runner is ready!');
}

export function deactivate() {
    console.log('TIFF Visualizer extension deactivated');
} 