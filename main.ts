// The program the harness runs: `node /bot/main.ts` (node22). It reads every case from /input/cases.json (a JSON array
// of {id, input}) and writes /output/answers.json: a JSON array of the answers, one per case and in the cases' order,
// each the answer run (solve.js, a faster drop-in for csv-reader 1.0.0) returns for the case's input.
//
// The answers are written by the byte path (fast.js): cases.json's bytes are read once, into WebAssembly memory, and
// each answer's JSON is written straight from them. When the byte path does not read a document (fast.js says which),
// every case is answered with run and written with JSON.stringify, as the house driver does. Outside a container
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { closeSync, fstatSync, ftruncateSync, openSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, as the house driver runs (the rules let an entry tune V8's flags the same way).
setFlagsFromString('--no-incremental-marking');

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const { transduce, inputBuffer } = (await import(new URL('./fast.js', import.meta.url).href)) as {
  transduce: (bytes: Buffer, size: number, emit: (chunk: Buffer) => void) => boolean;
  inputBuffer: (size: number) => Buffer;
};

// cases.json, read straight into the byte path's memory.
const fd = openSync(join(INPUT_DIR, 'cases.json'), 'r');
const size = fstatSync(fd).size;
const bytes = inputBuffer(size);
let read = 0;
while (read < size) {
  const n = readSync(fd, bytes, read, size - read, read);
  if (n === 0) break;
  read += n;
}
closeSync(fd);

// answers.json, written a case at a time as the byte path finishes each.
const out = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
let written = 0;
const emit = (chunk: Buffer): void => {
  let at = 0;
  while (at < chunk.length) at += writeSync(out, chunk, at, chunk.length - at, written + at);
  written += chunk.length;
};
if (!transduce(bytes, read, emit)) {
  // The byte path declined the document: every case answered with run, the file written again from its start.
  const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };
  const cases = JSON.parse(bytes.toString('utf8', 0, read)) as { id: string; input: unknown }[];
  const answers: unknown[] = [];
  for (const c of cases) answers.push(run(c.input));
  const all = Buffer.from(JSON.stringify(answers));
  written = 0;
  emit(all);
  ftruncateSync(out, written);
}
closeSync(out);
