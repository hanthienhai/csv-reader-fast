// The program the harness runs: `node /bot/main.ts` (node22). It reads every case from /input/cases.json (a JSON array
// of {id, input}) and writes /output/answers.json: a JSON array of the answers, one per case and in the cases' order,
// each the answer run (solve.js, a faster drop-in for csv-reader 1.0.0) returns for the case's input.
//
// The answers are written by the byte path (fast.js), which streams cases.json through a small window of WebAssembly
// memory and writes each answer's JSON straight from its bytes. When the byte path declines a document (fast.js says
// which), every case is answered with run and written with JSON.stringify, as the house driver does. Outside a
// container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { closeSync, fstatSync, ftruncateSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, as the house driver runs (the rules let an entry tune V8's flags the same way), and
// the WebAssembly left as its first compiler builds it: optimizing it again on a background thread costs more CPU
// than it saves on one document.
setFlagsFromString('--no-incremental-marking');
setFlagsFromString('--no-wasm-tier-up');

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const { transduceStream } = (await import(new URL('./fast.js', import.meta.url).href)) as {
  transduceStream: (
    read: (buf: Buffer, at: number, len: number, from: number) => number,
    size: number,
    write: (buf: Buffer, start: number, end: number, pos: number) => void,
  ) => boolean;
};

const inPath = join(INPUT_DIR, 'cases.json');
const input = openSync(inPath, 'r');
const size = fstatSync(input).size;
const output = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
const write = (buf: Buffer, start: number, end: number, pos: number): void => {
  while (start < end) {
    const n = writeSync(output, buf, start, end - start, pos);
    start += n;
    pos += n;
  }
};
const ok = transduceStream((buf, at, len, from) => readSync(input, buf, at, len, from), size, write);
closeSync(input);
if (!ok) {
  // The byte path declined the document: every case answered with run, the file written again from its start.
  const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };
  const cases = JSON.parse(readFileSync(inPath, 'utf8')) as { id: string; input: unknown }[];
  const answers: unknown[] = [];
  for (const c of cases) answers.push(run(c.input));
  const all = Buffer.from(JSON.stringify(answers));
  write(all, 0, all.length, 0);
  ftruncateSync(output, all.length);
}
closeSync(output);
