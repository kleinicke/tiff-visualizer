import * as vscode from 'vscode';
import type { IImagePreview } from './types';

/** Keep the handoff file alive while the other editor reads/reloads it. */
export async function openSelectedDepth(context: vscode.ExtensionContext, preview: IImagePreview): Promise<void> {
  const command = 'plyViewer.convertNpyToPointCloud';
  if (!(await vscode.commands.getCommands(true)).includes(command)) {
    const extension = vscode.extensions.getExtension('kleinicke.ply-visualizer');
    if (!extension) throw new Error('Install "3D Point Cloud and Mesh Visualizer" (kleinicke.ply-visualizer) to open depth as a point cloud.');
    await extension.activate();
  }
  const bytes = await preview.requestDepthPlane();
  const folder = vscode.Uri.joinPath(context.globalStorageUri, 'depth-handoffs');
  await vscode.workspace.fs.createDirectory(folder);
  const name = preview.getCurrentImage().path.split('/').pop()?.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_.-]/g, '_') || 'depth';
  const target = vscode.Uri.joinPath(folder, `${name}-selected-${Date.now()}-${Math.random().toString(36).slice(2)}.npy`);
  await vscode.workspace.fs.writeFile(target, bytes);
  // The PLY command opens its editor before its decoder finishes. Deleting in
  // a finally block here would race that asynchronous read and break reloads.
  const closed = vscode.window.tabGroups.onDidChangeTabs(event => {
    if (!event.closed.some(tab => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === target.toString())) return;
    const stillOpen = vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === target.toString()));
    if (stillOpen) return;
    closed.dispose();
    void vscode.workspace.fs.delete(target).then(undefined, () => {});
  });
  context.subscriptions.push(closed);
  try {
    await vscode.commands.executeCommand(command, target);
  } catch (error) {
    closed.dispose();
    await vscode.workspace.fs.delete(target).then(undefined, () => {});
    throw error;
  }
}
