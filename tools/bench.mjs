// A local stand-in for the contest's timing heat (the kit's harness, grader/code-heat.ts, needs Docker's cgroup clock):
//   node tools/bench.mjs <cases.json dir> <bot dir> [<bot dir>...] [--rounds 9] [--warmup 1] [--trim 2]
// Each round runs every bot once, `node <bot>/main.ts`, in a fresh process, plus the null entry (tools/null) as the
// control, in an order shuffled per round. A run's CPU time is user + system of the whole process (every thread),
// read at exit; each bot's figure is the trimmed mean of its timed runs net of the control's median, as the heat
// nets its runs. Every run's answers.json must match the bot's first run byte for byte.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const v = Number(args[i + 1]);
  args.splice(i, 2);
  return v;
};
const rounds = opt('--rounds', 9);
const warmup = opt('--warmup', 1);
const trim = opt('--trim', 2);
const [inputDir, ...bots] = args.map((a) => resolve(a));
if (!inputDir || bots.length === 0) throw new Error('usage: node tools/bench.mjs <input dir> <bot dir>...');
const CONTROL = join(here, 'null');
const hook = pathToFileURL(join(here, 'cpu-hook.mjs')).href;

function runOnce(bot) {
  const out = mkdtempSync(join(tmpdir(), 'bench-'));
  const r = spawnSync(process.execPath, ['--import', hook, join(bot, 'main.ts')], {
    env: { ...process.env, MAKEFUN_INPUT_DIR: inputDir, MAKEFUN_OUTPUT_DIR: out },
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  const m = /CPU_US=(\d+)/.exec(r.stderr ?? '');
  if (r.status !== 0 || !m) throw new Error(`${bot} failed (${r.status}): ${r.stderr}`);
  const hash = createHash('sha256').update(readFileSync(join(out, 'answers.json'))).digest('hex');
  return { us: Number(m[1]), hash };
}

const entries = [CONTROL, ...bots];
const runs = new Map(entries.map((e) => [e, []]));
const hashes = new Map();
let s = 12345;
const rnd = (k) => ((s = (s * 1103515245 + 12345) >>> 0) % k);
for (let r = 0; r < warmup + rounds; r++) {
  const order = entries.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const e of order) {
    const { us, hash } = runOnce(e);
    if (!hashes.has(e)) hashes.set(e, hash);
    else if (hashes.get(e) !== hash) throw new Error(`${e}: run ${r} wrote a different answers.json`);
    if (r >= warmup) runs.get(e).push(us);
  }
  process.stderr.write(`round ${r + 1}/${warmup + rounds}\r`);
}
process.stderr.write('\n');

const median = (xs) => {
  const a = xs.slice().sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};
const trimmedMean = (xs) => {
  const a = xs.slice().sort((x, y) => x - y).slice(trim, xs.length - trim);
  return a.reduce((x, y) => x + y, 0) / a.length;
};
const control = median(runs.get(CONTROL));
console.log(`control (null entry): median ${(control / 1000).toFixed(1)} ms gross`);
for (const b of bots) {
  const xs = runs.get(b);
  const net = trimmedMean(xs) - control;
  console.log(
    `${b}: net ${(net / 1000).toFixed(1)} ms (trimmed mean ${(trimmedMean(xs) / 1000).toFixed(1)} ms gross; runs ${xs
      .map((x) => (x / 1000).toFixed(0))
      .join(' ')}) answers ${hashes.get(b).slice(0, 12)}`,
  );
}
