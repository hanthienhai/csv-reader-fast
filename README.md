# csv-reader-fast

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/hanthienhai/csv-reader-fast/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/hanthienhai/csv-reader-fast/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for csv-reader 1.0.0 that gives the same answer on every input. `solve.js` exports `run(input)`, a plain JavaScript reader with csv-reader's exact broken-row policy. `main.ts` writes `answers.json` straight from the bytes of `cases.json`: WebAssembly SIMD reads each case's text 16 bytes at a time, with no `JSON.parse` and no row arrays in between. Any document that path does not read is answered with `run`.

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

## How it works

- `fast.js` reads the JSON document (the array, each case's `id` and `input`) and calls `readText` once per case. It fills in the bytes around each answer once the case's `header` is known, and hands each answer to `main.ts`, which writes it out and reuses the memory for the next case.
- `reader-src.js` holds `readText`, `writeErrors` and `writeInt` in a small subset of the WebAssembly text format. `wasm.js` assembles them into `reader.wasm` (`node tools/build-wasm.mjs`), so no toolchain is needed.
- A field of the CSV text is a run of bytes in the JSON string, so it is copied as it stands. The bytes that steer the reader are a comma, the escapes `\"`, `\n` and `\r`, and the string's closing quote.

## Checks

```sh
node tools/check.mjs <kit>         # run() against csv-reader 1.0.0: the practice set and random texts
node tools/check-bytes.mjs <kit>   # the byte path against csv-reader 1.0.0, and reader.wasm against its source
node tools/check-fallback.mjs <kit>
node tools/draw.mjs <kit> <sets> 20 && node tools/verify.mjs <sets>   # sets drawn by the contest's generator
node tools/bench.mjs <kit>/practice/input <kit>/baselines/csv-reader .  # CPU time, net of a null entry
```

`<kit>` is the unpacked contest kit. Its `baselines/csv-reader/vendor` holds the reference reader these checks compare against.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ssrma36r&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
