/**
 * vsce pulls in a recent undici, which expects the global `File`/`Blob` that
 * Node 20 added. Preload this to package the extension on Node 18.
 * Delete once the toolchain moves to Node 20+.
 */
const buffer = require('buffer');

if (typeof globalThis.File === 'undefined') {
	globalThis.File = buffer.File;
}
if (typeof globalThis.Blob === 'undefined') {
	globalThis.Blob = buffer.Blob;
}
