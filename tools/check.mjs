// Differential check: solve.js's run against csv-reader 1.0.0's readCsv (the kit's baselines/csv-reader/vendor).
//   node tools/check.mjs <unpacked kit dir> [fuzz iterations]
// 1. every practice case must equal the kit's reference answer;
// 2. random texts built from the characters that matter (comma, quote, CR, LF, BOM, a few others) must give the same
//    answer from both readers, as JSON.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { run } from '../solve.js';

const kit = process.argv[2];
if (!kit) throw new Error('usage: node tools/check.mjs <kit dir> [iterations]');
const iterations = Number(process.argv[3] ?? 200000);
const { readCsv } = await import(pathToFileURL(join(kit, 'baselines/csv-reader/vendor/csv-reader/index.js')).href);

// 1. The practice cases.
const cases = JSON.parse(readFileSync(join(kit, 'practice/input/cases.json'), 'utf8'));
const expected = JSON.parse(readFileSync(join(kit, 'practice/reference/expected.json'), 'utf8')).cases;
let bad = 0;
cases.forEach((c, i) => {
  const got = JSON.parse(JSON.stringify(run(c.input)));
  if (!isDeepStrictEqual(got, expected[i].output)) {
    bad += 1;
    console.log(`practice ${c.id}: differs`);
  }
});
console.log(`practice: ${cases.length - bad} of ${cases.length} identical`);

// 2. Fuzz: a seeded xorshift so a failure can be replayed.
let seed = 0x9e3779b9 ^ Number(process.argv[4] ?? 1);
function rand(k) {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) % k;
}
const alphabets = [
  ['a', 'b', ',', '"', '\n', '\r', '\r\n'],
  ['a', ',', '"', '""', '\n', '\r\n', 'é'],
  ['x', 'yz', ',', ',', '"', '\n', '\r', '\r\n', '﻿', ' '],
  ['a', ',', '\n'],
  ['"', ',', '\r', '\n'],
];
let fuzzBad = 0;
for (let it = 0; it < iterations; it++) {
  const alpha = alphabets[rand(alphabets.length)];
  const len = rand(it % 10 === 0 ? 120 : 24);
  let text = rand(8) === 0 ? '﻿' : '';
  for (let k = 0; k < len; k++) text += alpha[rand(alpha.length)];
  const input = { text, header: rand(2) === 0 };
  const want = JSON.stringify(readCsv(input));
  const got = JSON.stringify(run(input));
  if (want !== got) {
    fuzzBad += 1;
    if (fuzzBad <= 5) console.log('fuzz differs:', JSON.stringify(input), '\n  want', want, '\n  got ', got);
  }
}
console.log(`fuzz: ${iterations - fuzzBad} of ${iterations} identical`);
process.exit(bad || fuzzBad ? 1 : 0);
