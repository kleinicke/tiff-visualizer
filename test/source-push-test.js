'use strict';
/**
 * The host pushes local image bytes to the webview as `sourceChunk` messages
 * (src/imagePreview/source-push.ts), from the offset the webview bootstrap
 * requests. The bootstrap assembles them by offset and falls back to fetching
 * the resource on an `error` chunk, so the host side has to guarantee: chunks
 * in file order from the requested offset that reassemble to the exact file,
 * an error chunk (never silence) when the read fails, and nothing at all once
 * the request it serves has been replaced.
 *
 * Run with: node test/source-push-test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

function loadSourcePush() {
	const file = path.join(__dirname, '..', 'src/imagePreview/source-push.ts');
	const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	}).outputText;
	const loaded = { exports: {} };
	const requireShim = request => (request === 'vscode' ? {} : require(request));
	new Function('exports', 'require', 'module', '__filename', '__dirname', output)(
		loaded.exports, requireShim, loaded, file, path.dirname(file),
	);
	return loaded.exports;
}

function recordingWebview() {
	const messages = [];
	return { messages, postMessage: message => { messages.push(message); return Promise.resolve(true); } };
}

async function main() {
	const { canPushSource, pushSource, PUSHED_SOURCE_MIN_BYTES } = loadSourcePush();
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'source-push-'));
	try {
		// Two full 8 MB chunks and a partial one.
		const bytes = new Uint8Array(17 * 1024 * 1024 + 12345);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 2654435761) >>> 24;
		const file = path.join(directory, 'image.npy');
		fs.writeFileSync(file, bytes);
		const resource = { scheme: 'file', fsPath: file };

		assert.ok(canPushSource(resource), 'a local file can be pushed from Node');
		assert.ok(!canPushSource({ scheme: 'vscode-remote', fsPath: file }), 'other schemes keep fetching');
		assert.ok(PUSHED_SOURCE_MIN_BYTES > 0);

		{
			const webview = recordingWebview();
			await pushSource(webview, resource, 'token-a', bytes.length, 0, () => true);
			assert.equal(webview.messages.length, 3, 'three chunks');
			const assembled = new Uint8Array(bytes.length);
			let expected = 0;
			for (const message of webview.messages) {
				assert.equal(message.type, 'sourceChunk');
				assert.equal(message.token, 'token-a');
				assert.equal(message.error, undefined);
				assert.equal(message.offset, expected, 'chunks arrive in file order');
				assembled.set(message.bytes, message.offset);
				expected += message.bytes.byteLength;
			}
			assert.equal(expected, bytes.length);
			assert.ok(Buffer.from(assembled).equals(Buffer.from(bytes)), 'chunks reassemble to the file');
		}

		{
			// The file is shorter than announced: the third chunk cannot be filled.
			const webview = recordingWebview();
			await pushSource(webview, resource, 'token-b', bytes.length + 1, 0, () => true);
			const last = webview.messages.at(-1);
			assert.equal(webview.messages.length, 3);
			assert.equal(last.offset, 16 * 1024 * 1024, 'error reports where the read stopped');
			assert.match(last.error, /shrank/);
			assert.equal(last.bytes, undefined);
		}

		{
			const webview = recordingWebview();
			await pushSource(webview, { scheme: 'file', fsPath: path.join(directory, 'missing.npy') }, 'token-c', 10, 0, () => true);
			assert.equal(webview.messages.length, 1);
			assert.equal(webview.messages[0].offset, 0);
			assert.ok(webview.messages[0].error, 'an unreadable file posts an error chunk');
		}

		{
			// A re-render (or disposal) after the first chunk stops the push silently.
			const webview = recordingWebview();
			await pushSource(webview, resource, 'token-d', bytes.length, 0, () => webview.messages.length < 1);
			assert.equal(webview.messages.length, 1, 'no chunks or errors for a page that is gone');
			assert.equal(webview.messages[0].error, undefined);
		}

		{
			// A repeated request resumes from the first byte the page is missing.
			const webview = recordingWebview();
			const start = 9 * 1024 * 1024 + 5;
			await pushSource(webview, resource, 'token-e', bytes.length, start, () => true);
			assert.equal(webview.messages[0].offset, start);
			const tail = Buffer.concat(webview.messages.map(message => Buffer.from(message.bytes)));
			assert.ok(tail.equals(Buffer.from(bytes.subarray(start))), 'a resumed push carries exactly the rest of the file');
		}
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
	console.log('Source push: chunks reassemble to the file in order; resumes from an offset; short and missing files post an error; stale pages get nothing more');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
