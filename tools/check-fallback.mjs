// The driver's fallback, end to end: documents the byte path declines (an escape \u, keys in another shape) must still
// come out as csv-reader's answers, written by run.
//   node tools/check-fallback.mjs <unpacked kit dir>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const kit = process.argv[2];
if (!kit) throw new Error('usage: node tools/check-fallback.mjs <kit dir>');
const { readCsv } = await import(pathToFileURL(join(kit, 'baselines/csv-reader/vendor/csv-reader/index.js')).href);
const docs = [
  // A is A: the byte path declines it, after one case already went out.
  '[{"id":"b","input":{"header":false,"text":"q,r"}},{"id":"a","input":{"text":"\\u0041,b\\n1,\\"x\\"\\"\\r\\n","header":true}}]',
  // A key the byte path does not take.
  '[{"id":"c","input":{"text":"a,b\\n1","header":true,"extra":1}}]',
  // Whitespace between the tokens: still read by the byte path.
  ' [ { "id" : "d" , "input" : { "header" : true , "text" : "x,y\\r\\n1,2,3" } } ] ',
];
let bad = 0;
for (const doc of docs) {
  const dir = mkdtempSync(join(tmpdir(), 'fallback-'));
  writeFileSync(join(dir, 'cases.json'), doc);
  execFileSync(process.execPath, [new URL('../main.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], {
    env: { ...process.env, MAKEFUN_INPUT_DIR: dir, MAKEFUN_OUTPUT_DIR: dir },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const want = JSON.parse(doc).map((c) => JSON.parse(JSON.stringify(readCsv(c.input))));
  const got = JSON.parse(readFileSync(join(dir, 'answers.json'), 'utf8'));
  const same = isDeepStrictEqual(got, want);
  if (!same) bad += 1;
  console.log(`${same ? 'identical' : 'DIFFERS'}: ${doc.slice(0, 70)}`);
}
process.exit(bad ? 1 : 0);
