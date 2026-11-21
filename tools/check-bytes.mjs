// Differential check of the byte path (fast.js) against csv-reader 1.0.0 (the kit's vendored reader):
//   node tools/check-bytes.mjs <unpacked kit dir> [batches] [seed]
// 1. the practice cases.json must transduce to the kit's reference answers;
// 2. random texts (commas, quotes, CR, LF, BOM, tabs, backslashes, non-ASCII), many cases a document and both header
//    values, keys in either order, must transduce to the JSON csv-reader's answers stringify to.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { transduce } from '../fast.js';
import { readerBytes } from '../reader-src.js';

const kit = process.argv[2];
if (!kit) throw new Error('usage: node tools/check-bytes.mjs <kit dir> [batches] [seed]');
const batches = Number(process.argv[3] ?? 300);
const { readCsv } = await import(pathToFileURL(join(kit, 'baselines/csv-reader/vendor/csv-reader/index.js')).href);

// reader.wasm must be reader-src.js assembled (node tools/build-wasm.mjs).
const built = readFileSync(new URL('../reader.wasm', import.meta.url));
const fresh = Buffer.from(readerBytes());
console.log(`reader.wasm: ${built.equals(fresh) ? 'built from reader-src.js' : 'STALE: run node tools/build-wasm.mjs'}`);
const wasmOk = built.equals(fresh);

const bytes = readFileSync(join(kit, 'practice/input/cases.json'));
const expected = JSON.parse(readFileSync(join(kit, 'practice/reference/expected.json'), 'utf8')).cases.map((c) => c.output);
const got = transduce(bytes);
if (got === null) throw new Error('practice: the byte path declined the practice set');
const ok = isDeepStrictEqual(JSON.parse(got.toString('utf8')), expected);
console.log(`practice: ${ok ? 'identical' : 'DIFFERS'}`);

let seed = 0x2545f491 ^ Number(process.argv[4] ?? 7);
function rand(k) {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) % k;
}
const alphabets = [
  ['a', 'b', ',', '"', '\n', '\r', '\r\n'],
  ['a', ',', '"', '""', '\n', '\r\n', 'é', '數'],
  ['x', 'yz', ',', ',', '"', '\n', '\r', '\r\n', '﻿', ' ', '\t', '\\', '/'],
  ['a', ',', '\n'],
  ['"', ',', '\r', '\n'],
  ['ab', 'c', ',', '"', '""', '\n', '\r\n'],
];
let bad = 0;
let total = 0;
for (let bt = 0; bt < batches; bt++) {
  const cases = [];
  const count = 1 + rand(60);
  for (let i = 0; i < count; i++) {
    const alpha = alphabets[rand(alphabets.length)];
    const len = rand(i % 7 === 0 ? 200 : 30);
    let text = rand(6) === 0 ? '﻿' : '';
    for (let k = 0; k < len; k++) text += alpha[rand(alpha.length)];
    const header = rand(2) === 0;
    cases.push({ id: `f-${i}`, input: rand(3) === 0 ? { header, text } : { text, header } });
  }
  const want = cases.map((c) => JSON.parse(JSON.stringify(readCsv(c.input))));
  const out = transduce(Buffer.from(JSON.stringify(cases)));
  total += count;
  if (out === null) {
    bad += count;
    console.log('declined:', JSON.stringify(cases).slice(0, 200));
    continue;
  }
  const answers = JSON.parse(out.toString('utf8'));
  for (let i = 0; i < count; i++) {
    if (!isDeepStrictEqual(answers[i], want[i])) {
      bad += 1;
      if (bad <= 5) {
        console.log('differs:', JSON.stringify(cases[i].input));
        console.log('  want', JSON.stringify(want[i]));
        console.log('  got ', JSON.stringify(answers[i]));
      }
    }
  }
}
console.log(`fuzz: ${total - bad} of ${total} identical`);
// Documents the byte path must decline (and the driver then answers with run).
for (const doc of ['[{"id":"a","input":{"text":"\\u0041,b","header":false}}]', '[{"id":"a","input":{"text":"a","header":1}}]', '{}', '[{"id":"a","input":{"text":"a"}}]']) {
  if (transduce(Buffer.from(doc)) !== null) {
    bad += 1;
    console.log('should decline:', doc);
  }
}
const empty = transduce(Buffer.from('[]'));
if (empty === null || empty.toString() !== '[]') {
  bad += 1;
  console.log('[] did not transduce to []');
}
process.exit(ok && wasmOk && bad === 0 ? 0 : 1);
