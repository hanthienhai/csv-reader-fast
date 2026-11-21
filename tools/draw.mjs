// Draws test sets the way the contest's generator does (the kit's program/generator: its subject's generate(rng, i)
// on streamFor(seed, 'case', i)), each with csv-reader 1.0.0's answers, from seeds of our own:
//   node tools/draw.mjs <unpacked kit dir> <out dir> [sets] [first seed]
// writes <out dir>/<n>/input/cases.json and <out dir>/<n>/reference/answers.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [kit, outDir, setsArg, firstArg] = process.argv.slice(2);
if (!kit || !outDir) throw new Error('usage: node tools/draw.mjs <kit dir> <out dir> [sets] [first seed]');
const gen = join(resolve(kit), 'program/generator');
const { streamFor } = await import(pathToFileURL(join(gen, 'rng.ts')).href);
const { generate } = await import(pathToFileURL(join(gen, 'subject/csv-cases.mjs')).href);
const { readCsv } = await import(pathToFileURL(join(resolve(kit), 'baselines/csv-reader/vendor/csv-reader/index.js')).href);

const sets = Number(setsArg ?? 10);
const first = Number(firstArg ?? 1);
for (let s = first; s < first + sets; s++) {
  const seed = createHash('sha256').update(`csv-reader-fast test set ${s}`).digest('hex');
  const cases = [];
  for (let i = 0; i < 6; i++) cases.push({ id: `g-${String(i + 1).padStart(4, '0')}`, input: generate(streamFor(seed, 'case', i), i) });
  const text = JSON.stringify(cases);
  const answers = JSON.parse(text).map((c) => readCsv(c.input));
  const dir = join(outDir, String(s));
  mkdirSync(join(dir, 'input'), { recursive: true });
  mkdirSync(join(dir, 'reference'), { recursive: true });
  writeFileSync(join(dir, 'input', 'cases.json'), text);
  writeFileSync(join(dir, 'reference', 'answers.json'), JSON.stringify(answers));
  process.stderr.write(`set ${s}: ${(text.length / 1e6).toFixed(1)} MB\n`);
}
