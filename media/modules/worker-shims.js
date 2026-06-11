// @ts-check
"use strict";

// Minimal browser-global shim so window-attaching vendored libraries
// (parse-exr.js) can run inside a Web Worker, where `window` does not exist.
// Imported first in decode-worker.js — ES module import order guarantees it
// runs before the libraries that need it.
if (typeof globalThis.window === 'undefined') {
	// @ts-ignore
	globalThis.window = globalThis;
}
