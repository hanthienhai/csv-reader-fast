// Runs the entry (node main.ts) on every set tools/draw.mjs wrote and compares its answers.json with csv-reader's, as
// JSON values (the scorer's comparison), and with a second run byte for byte (the harness runs every entry twice):
//   node tools/verify.mjs <sets dir> [bot dir]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const [setsDir, botArg] = process.argv.slice(2);
if (!setsDir) throw new Error('usage: node tools/verify.mjs <sets dir> [bot dir]');
const bot = resolve(botArg ?? '.');
let bad = 0;
const sets = readdirSync(setsDir).sort((a, b) => Number(a) - Number(b));
for (const s of sets) {
  const runOnce = () => {
    const out = mkdtempSync(join(tmpdir(), 'verify-'));
    execFileSync(process.execPath, [join(bot, 'main.ts')], {
      env: { ...process.env, MAKEFUN_INPUT_DIR: join(setsDir, s, 'input'), MAKEFUN_OUTPUT_DIR: out },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    return readFileSync(join(out, 'answers.json'));
  };
  const a = runOnce();
  const b = runOnce();
  const want = JSON.parse(readFileSync(join(setsDir, s, 'reference', 'answers.json'), 'utf8'));
  const got = JSON.parse(a.toString('utf8'));
  const same = isDeepStrictEqual(got, want);
  const stable = a.equals(b);
  if (!same || !stable) bad += 1;
  console.log(`set ${s}: ${same ? 'identical' : 'DIFFERS'}${stable ? '' : ', runs differ'}`);
}
console.log(`${sets.length - bad} of ${sets.length} sets identical`);
process.exit(bad ? 1 : 0);
