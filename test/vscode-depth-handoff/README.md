# Selected depth handoff integration test

After `npm run compile:quick`, launch `runner.cjs` through
`@vscode/test-electron.runTests` with this repository as the development extension
and an isolated user-data/extension directory. The runner replaces the PLY
conversion command with a receiver that reads and verifies the produced NPY;
it tests the real extension command and webview binary transport, not the PLY
viewer's camera dialog or 3D rendering.

Set `DEPTH_CASES` to a JSON array of `{ "file": "/absolute/image", "values": [...] }`
fixtures with shape `(5, 6)`, and `DEPTH_LOGS` to the isolated user-data directory.
Use at least a float NPY and a 16-bit PGM to verify the format-independent path.
The test checks the temporary file, dimensions and all original sample values.
The selected NPZ array/slice and multichannel rejection are covered by
`test/web/numpy-navigation.spec.ts`. Run the encoder checks with
`node test/depth-plane-test.mjs` after compiling.
