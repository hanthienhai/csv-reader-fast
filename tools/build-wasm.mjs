// Builds reader.wasm (the WebAssembly fast.js loads) from reader-src.js:  node tools/build-wasm.mjs
import { writeFileSync } from 'node:fs';
import { readerBytes } from '../reader-src.js';

const bytes = readerBytes();
new WebAssembly.Module(bytes); // it must validate
writeFileSync(new URL('../reader.wasm', import.meta.url), bytes);
console.log(`reader.wasm: ${bytes.length} bytes`);
