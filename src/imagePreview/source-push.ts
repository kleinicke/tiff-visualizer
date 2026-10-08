import * as vscode from 'vscode';

/**
 * Local image bytes reach the webview faster when the extension host reads
 * them and posts them in chunks than when the webview fetches its resource
 * URI (~1 GB/s against ~520 MB/s; 100 MB NPY, PFM and FITS open 100-150 ms
 * sooner). The webview bootstrap requests the source by its page token once
 * it listens (chunks posted earlier can be lost), assembles the chunks into
 * one buffer of the announced size, asks again from the first missing byte
 * if they stop arriving, and falls back to fetching the resource URI after
 * an error chunk or repeated stalls.
 */
export const PUSHED_SOURCE_MIN_BYTES = 1024 * 1024;
const PUSHED_SOURCE_CHUNK_BYTES = 8 * 1024 * 1024;

type NodeFs = typeof import('fs');

function nodeFs(): NodeFs | undefined {
	// The browser build of the extension has no filesystem; it keeps fetching.
	if (typeof process === 'undefined' || !process.versions?.node) {
		return undefined;
	}
	try {
		return require('fs') as NodeFs;
	} catch {
		return undefined;
	}
}

export function canPushSource(resource: vscode.Uri): boolean {
	return resource.scheme === 'file' && !!nodeFs();
}

/**
 * Posts bytes `start..size` of `resource` as `sourceChunk` messages tagged
 * with `token`, in file order. Stops quietly once `isCurrent` turns false (a
 * newer request or render, or disposal); any failure is posted as a chunk
 * with an `error`, so the webview falls back instead of waiting.
 */
export async function pushSource(
	webview: vscode.Webview,
	resource: vscode.Uri,
	token: string,
	size: number,
	start: number,
	isCurrent: () => boolean,
): Promise<void> {
	const fs = nodeFs();
	let offset = start;
	try {
		if (!fs) {
			throw new Error('no filesystem access');
		}
		const handle = await fs.promises.open(resource.fsPath, 'r');
		try {
			while (offset < size && isCurrent()) {
				const bytes = new Uint8Array(Math.min(PUSHED_SOURCE_CHUNK_BYTES, size - offset));
				let filled = 0;
				while (filled < bytes.length) {
					const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, offset + filled);
					if (bytesRead === 0) {
						throw new Error('the file shrank while it was read');
					}
					filled += bytesRead;
				}
				void webview.postMessage({ type: 'sourceChunk', token, offset, bytes });
				offset += bytes.length;
			}
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (isCurrent()) {
			void webview.postMessage({ type: 'sourceChunk', token, offset, error: error instanceof Error ? error.message : String(error) });
		}
	}
}
