// The program the harness runs: `node /bot/main.ts` (node22). It reads every case from /input/cases.json (a JSON array
// of {id, input}) and writes /output/answers.json: a JSON array of the answers, one per case and in the cases' order,
// each the answer run (solve.js, a faster drop-in for csv-reader 1.0.0) returns for the case's input.
//
// The answers are written by the byte path (fast.js): cases.json's bytes are read once and each answer's JSON is
// written straight from them. When the byte path does not read a document (fast.js says which), every case is
// answered with run and written with JSON.stringify, as the house driver does. Outside a container MAKEFUN_INPUT_DIR
// and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { closeSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, as the house driver runs (the rules let an entry tune V8's flags the same way).
setFlagsFromString('--no-incremental-marking');

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const { transduce, primer, SENTINEL } = (await import(new URL('./fast.js', import.meta.url).href)) as {
  transduce: (bytes: Buffer, size?: number) => Buffer | null;
  primer: (records: number) => Buffer;
  SENTINEL: number;
};

// cases.json, read into a buffer with room for the byte path's sentinel quotes after it (no second copy).
const fd = openSync(join(INPUT_DIR, 'cases.json'), 'r');
const size = fstatSync(fd).size;
const bytes = Buffer.allocUnsafeSlow(size + SENTINEL);
let read = 0;
while (read < size) {
  const n = readSync(fd, bytes, read, size - read, read);
  if (n === 0) break;
  read += n;
}
closeSync(fd);
bytes.fill(0x22, read, read + SENTINEL);

// Warm the byte path on a small document that takes all its paths, so V8 optimizes it before the real one.
const warm = primer(100);
for (let i = 0; i < 3; i++) transduce(warm, warm.length - SENTINEL);

let answers: Buffer | string | null = transduce(bytes, read);
if (answers === null) {
  const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };
  const cases = JSON.parse(bytes.toString('utf8', 0, read)) as { id: string; input: unknown }[];
  const out: unknown[] = [];
  for (const c of cases) out.push(run(c.input));
  answers = JSON.stringify(out);
}
writeFileSync(join(OUTPUT_DIR, 'answers.json'), answers);
