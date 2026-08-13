import * as vscode from 'vscode';

/**
 * DICOM decoding for the extension host.
 *
 * The host needs this for volume export (`volumeExport.ts` stacks every slice
 * of a series before handing it to the 3D viewer). It used to call a
 * TypeScript `parseDicom`, but that parser has been deleted: DICOM is decoded
 * by Rust/WASM only, and keeping a second implementation alive just for this
 * one caller is exactly the duplication the port removed.
 *
 * The wasm-pack bundle targets the web, so it is loaded here the same way the
 * conformance tests load it under Node — a runtime dynamic import of the
 * generated JS glue plus an explicit `module_or_path` byte buffer, which skips
 * the glue's `fetch`/`import.meta.url` path entirely. The import specifier is
 * built at runtime so the extension bundler leaves it alone instead of trying
 * to inline an ES module into the CommonJS host bundle.
 */

let modulePromise: Promise<any> | null = null;

async function loadWasm(extensionUri: vscode.Uri): Promise<any> {
	const jsUri = vscode.Uri.joinPath(extensionUri, 'media', 'wasm', 'tiff-wasm.js');
	const wasmUri = vscode.Uri.joinPath(extensionUri, 'media', 'wasm', 'tiff-wasm.wasm');
	const wasmBytes = await vscode.workspace.fs.readFile(wasmUri);
	// Assembled at runtime: a literal would be rewritten by the bundler.
	const specifier = jsUri.scheme === 'file' ? jsUri.fsPath : jsUri.toString();
	const mod = await import(/* webpackIgnore: true */ specifier);
	await mod.default({ module_or_path: wasmBytes });
	return mod;
}

function getWasm(extensionUri: vscode.Uri): Promise<any> {
	if (!modulePromise) {
		modulePromise = loadWasm(extensionUri).catch(error => {
			// Reset so a later attempt can retry rather than being stuck with
			// a rejected promise for the rest of the session.
			modulePromise = null;
			throw error;
		});
	}
	return modulePromise;
}

export interface HostDecodedDicom {
	width: number;
	height: number;
	channels: number;
	data: Float32Array;
	metadata: Record<string, any>;
	numericDomain: {
		bitsPerSample: number;
		sampleFormat: number;
		typeMin: number;
		typeMax: number;
		sourceNumericType: string;
	};
}

/**
 * Decodes one native (uncompressed) DICOM frame.
 *
 * Compressed transfer syntaxes throw with the decoder's own message — the
 * caller reports that rather than emitting a volume with a hole in it.
 */
export async function decodeDicomInHost(
	extensionUri: vscode.Uri,
	buffer: ArrayBuffer,
	frameIndex = 0,
): Promise<HostDecodedDicom> {
	const wasm = await getWasm(extensionUri);
	const result = wasm.decode_dicom_fast(new Uint8Array(buffer), frameIndex >>> 0);
	// take_data_as_f32() is destructive: call it exactly once.
	const data = result.take_data_as_f32();
	return {
		width: result.width,
		height: result.height,
		channels: result.channels,
		data,
		metadata: JSON.parse(result.metadata_json),
		numericDomain: {
			bitsPerSample: result.bits_per_sample,
			sampleFormat: result.sample_format,
			typeMin: result.type_min,
			typeMax: result.type_max,
			sourceNumericType: result.source_numeric_type,
		},
	};
}
