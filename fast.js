// The byte path: cases.json's bytes in, answers.json's bytes out, every answer the one run (solve.js) returns, with
// no JSON.parse, no strings and no row arrays in between.
//
// A case's text arrives as a JSON string, and a CSV field of it is a run of that string's bytes: UTF-8 is copied as it
// stands, and so are the escapes \\ \/ \b \f \t, which mean the same inside the answer's JSON string. The bytes that
// steer the reader are a comma, the escapes \" (a quote), \n (LF) and \r (CR), and the string's closing quote (the
// end of the text). Each answer is written as it is read:
//
//   {"columns":<the header record or null>,"rows":[<record>,...],"errors":[<error>,...]}
//
// The text is read by readText, WebAssembly (reader.wasm, assembled from reader-src.js): 16 bytes at a time it copies
// a field's bytes to the answer and finds the first byte that steers (i8x16.eq, i8x16.bitmask, i32.ctz), and it
// writes each record as it ends. JavaScript reads the rest of the document (the array, each case's id and input
// object) and writes the bytes around each text.
//
// Both ends stream through small windows of the reader's memory, used again and again, so the process touches little
// memory however large the document: the input a window at a time (readText gives up a record that runs past the
// input read so far, and is called again once more is read), the answer flushed to answers.json as the window fills.
//
// Whether a case has a header is known only once its input object is read, often after its text, so the first
// record is written where it would stand either way and the bytes around it are filled in at the end: the room
// before it takes `{"columns":` or `{"columns":null,"rows":[`, the room after it `,"rows":[` or nothing, each padded
// with spaces, which JSON reads past. That head of the answer stays in the window until then, and is written to the
// file at its place last. readText keeps the errors as records (code, line, record index, a, b), and writeErrors
// writes them at the end, when a record index can be told as a row.
//
// The byte path declines anything it does not read itself (an escape \u, a key or a value an input does not carry, a
// document that is not an array of {id, input}, a string that never ends, more errors than their room): the caller
// then answers every case with run. The output is the same JSON value either way.

import { readFileSync } from 'node:fs';

const BS = 0x5c; // backslash
const DQ = 0x22; // double quote
const COMMA = 0x2c;

// readText's answers.
const OK = 0;
const DECLINE = 4;
const NEED_INPUT = 5;
const NEED_ROOM = 6;

const PREFIX_ROOM = 24; // {"columns":null,"rows":[
const GAP_ROOM = 9; // ,"rows":[
const SENTINEL = 64; // quotes after the input read so far: every read stops at one
const SLACK = 65536; // room past every bound, for 16-byte stores and the bytes around a record
const TOKEN = 4096; // the most of the document read at once between texts
const COLUMNS_HEAD = Buffer.from('{"columns":');
const COLUMNS_NULL = Buffer.from('{"columns":null,"rows":[');
const COLUMNS_EMPTY = Buffer.from('{"columns":[],"rows":[');
const ROWS_HEAD = Buffer.from(',"rows":[');
const ERRORS_HEAD = Buffer.from('],"errors":[');

let readerModule = null;
function reader() {
  if (readerModule === null) readerModule = new WebAssembly.Module(readFileSync(new URL('./reader.wasm', import.meta.url)));
  return readerModule;
}

/**
 * Streams a document of `size` bytes to its answers. read(buf, at, len, from) puts up to len bytes of the document,
 * from its byte `from`, at buf[at] and says how many; write(buf, start, end, pos) puts buf[start, end) at byte pos of
 * the answers. True when done; false when the byte path declines (some answers may have been written by then).
 * `window` is the input window's first size (tests make it small, to cross its edges often).
 */
export function transduceStream(read, size, write, window = 1 << 19) {
  let memory;
  try {
    memory = new WebAssembly.Memory({ initial: 1 });
  } catch {
    return false;
  }
  let buf = Buffer.from(memory.buffer);
  let top = 0; // the memory used so far
  const alloc = (n) => {
    const base = (top + 15) & ~15;
    top = base + n;
    if (top > buf.length) {
      memory.grow(Math.ceil((top - buf.length) / 65536));
      buf = Buffer.from(memory.buffer);
    }
    return base;
  };

  // The input window: [inBase, validEnd) read so far, SENTINEL quotes after it; p the next byte.
  let inCap = Math.max(window, 64);
  let inBase = alloc(inCap + SENTINEL + 64);
  let validEnd = inBase;
  let p = inBase;
  let fileOff = 0; // the document's bytes read into the window
  // The output window: [outBase, headEnd) the current case's head once its first record is in, then the rest.
  let outCap = 3 * inCap + 4 * SLACK;
  let outBase = alloc(outCap);
  let outEnd = outBase + outCap - SLACK;
  let o = outBase;
  let headEnd = -1; // -1: the head is not whole yet
  const xBase = alloc(1 << 20);
  const xEnd = xBase + (1 << 20);
  const errBase = alloc(2 << 20);
  const errEnd = errBase + (2 << 20);

  let instance;
  try {
    instance = new WebAssembly.Instance(reader(), { env: { mem: memory } });
  } catch {
    return false;
  }
  const ex = instance.exports;
  ex.errEnd.value = errEnd;
  ex.xEnd.value = xEnd;

  const eof = () => fileOff >= size;
  const fill = () => {
    buf.fill(DQ, validEnd, validEnd + SENTINEL);
  };
  // Moves what is left to read to the window's start and reads on after it; a full window doubles first.
  const refill = () => {
    const keep = validEnd - p;
    if (keep >= inCap) {
      const cap = inCap * 2;
      const base = alloc(cap + SENTINEL + 64);
      buf.copy(buf, base, p, validEnd);
      inBase = base;
      inCap = cap;
      if (outCap < 3 * inCap + 4 * SLACK) growOut(3 * inCap + 4 * SLACK);
    } else if (p !== inBase) buf.copy(buf, inBase, p, validEnd);
    p = inBase;
    validEnd = inBase + keep;
    while (validEnd < inBase + inCap && !eof()) {
      const n = read(buf, validEnd, Math.min(inBase + inCap - validEnd, size - fileOff), fileOff);
      if (n <= 0) {
        fileOff = size; // the document ended early
        break;
      }
      validEnd += n;
      fileOff += n;
    }
    fill();
  };
  // At least n bytes ahead of p, unless the document ends first.
  const ensure = (n) => {
    if (validEnd - p < n && !eof()) refill();
  };
  // A new output window of at least `need` bytes, the current one copied to its start.
  const growOut = (need) => {
    const cap = Math.max(outCap * 2, need + 4 * SLACK);
    const base = alloc(cap);
    buf.copy(buf, base, outBase, o);
    const delta = base - outBase;
    o += delta;
    if (headEnd >= 0) headEnd += delta;
    if (ex.sGap.value >= 0) ex.sGap.value += delta;
    outBase = base;
    outCap = cap;
    outEnd = base + cap - SLACK;
  };

  let pos = 0; // where the current case's answer starts in the file
  let streamed = 0; // bytes of it written after its head
  const flush = () => {
    if (headEnd < 0 || o === headEnd) return false;
    write(buf, headEnd, o, pos + (headEnd - outBase) + streamed);
    streamed += o - headEnd;
    o = headEnd;
    return true;
  };
  // Room for `need` more bytes of answer: flush what can go, else a larger window.
  const room = (need) => {
    if (outEnd - o >= need) return;
    flush();
    if (outEnd - o < need) growOut(o - outBase + need);
  };

  const ws = () => {
    for (;;) {
      if (p >= validEnd) {
        if (eof()) return;
        refill();
        continue;
      }
      const c = buf[p];
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) p++;
      else return;
    }
  };
  // The key at p, a string with no escape, with p past its colon and the whitespace after; false: no such key.
  const key = () => {
    ws();
    ensure(TOKEN);
    if (buf[p] !== DQ) return false;
    let e = p + 1;
    while (e < validEnd && buf[e] !== DQ && buf[e] !== BS) e++;
    if (e >= validEnd || buf[e] !== DQ) return false;
    const k = buf.toString('latin1', p + 1, e);
    p = e + 1;
    ws();
    if (buf[p] !== 0x3a || p >= validEnd) return false;
    p++;
    ws();
    return k;
  };
  const skipString = () => {
    ensure(TOKEN);
    if (p >= validEnd || buf[p] !== DQ) return false;
    p++;
    for (;;) {
      // Two bytes in hand (an escape is two), unless the document ends.
      if (p + 1 >= validEnd && !eof()) refill();
      if (p >= validEnd) return false;
      const c = buf[p];
      if (c === BS) {
        if (p + 1 >= validEnd) return false;
        p += 2;
      } else if (c === DQ) {
        p++;
        return true;
      } else p++;
    }
  };

  // The input object at p ({text, header}, either order); its answer goes to the file at pos.
  const readInput = (first) => {
    ensure(TOKEN);
    if (buf[p] !== 0x7b) return false;
    p++;
    // The answer's start, as an offset from outBase (the window may move as it grows).
    const CASE = 1;
    o = outBase;
    buf[o++] = first ? 0x5b : COMMA;
    headEnd = -1;
    streamed = 0;
    let header = -1; // -1: not seen; 0: false; 1: true
    let sawText = false;
    let records = 0;
    let gapAt = -1; // the room after the first record, as an offset from outBase
    let e = errBase;
    let x = xBase;
    for (;;) {
      const k = key();
      if (k === 'header' && header < 0) {
        ensure(16);
        if (buf[p] === 0x74 && buf[p + 1] === 0x72 && buf[p + 2] === 0x75 && buf[p + 3] === 0x65) {
          header = 1;
          p += 4;
        } else if (buf[p] === 0x66 && buf[p + 1] === 0x61 && buf[p + 2] === 0x6c && buf[p + 3] === 0x73 && buf[p + 4] === 0x65) {
          header = 0;
          p += 5;
        } else return false;
        if (p > validEnd) return false;
      } else if (k === 'text' && !sawText) {
        sawText = true;
        ensure(64);
        if (buf[p] !== DQ || p >= validEnd) return false;
        o = outBase + CASE + PREFIX_ROOM;
        ex.sStart.value = 1;
        ex.sLine.value = 1;
        ex.sWidth.value = -1;
        ex.sRecords.value = 0;
        ex.sGap.value = -1;
        for (;;) {
          // Room for three bytes of answer for each byte of input in the window.
          room(3 * (validEnd - p) + SLACK);
          ex.winEnd.value = validEnd;
          ex.outEnd.value = outEnd;
          const r = ex.readText(p, o, e, x);
          p = ex.rP.value;
          o = ex.rO.value;
          e = ex.rE.value;
          x = ex.rX.value;
          if (headEnd < 0 && ex.sRecords.value > 0) headEnd = ex.sGap.value + GAP_ROOM;
          if (r === OK) break;
          if (r === NEED_INPUT) {
            if (eof()) return false; // a string that never ends
            refill();
          } else if (r === NEED_ROOM) {
            if (!flush()) growOut(2 * outCap);
          } else return false;
        }
        records = ex.sRecords.value;
        gapAt = ex.sGap.value - outBase;
      } else return false;
      ws();
      if (p >= validEnd) return false;
      if (buf[p] === COMMA) {
        p++;
        continue;
      }
      if (buf[p] === 0x7d) {
        p++;
        break;
      }
      return false;
    }
    if (!sawText || header < 0) return false;

    // The bytes around the first record, now that the header is known.
    const caseStart = outBase + CASE;
    if (records === 0) {
      o = caseStart;
      const head = header === 1 ? COLUMNS_EMPTY : COLUMNS_NULL;
      head.copy(buf, o);
      o += head.length;
    } else {
      const head = header === 1 ? COLUMNS_HEAD : COLUMNS_NULL;
      buf.fill(0x20, caseStart, caseStart + PREFIX_ROOM - head.length);
      head.copy(buf, caseStart + PREFIX_ROOM - head.length);
      if (header === 1) {
        ROWS_HEAD.copy(buf, outBase + gapAt);
        if (records > 1) {
          // The second record's comma: it is the first row. It is the first byte after the head, still in the
          // window or already in the file.
          if (streamed === 0) buf[headEnd] = 0x20;
          else write(Buffer.from(' '), 0, 1, pos + (headEnd - outBase));
        }
      } else buf.fill(0x20, outBase + gapAt, outBase + gapAt + GAP_ROOM);
    }
    // The errors, each with its record's row.
    const ne = (e - errBase) / 20;
    room(ERRORS_HEAD.length + 100 * ne + (x - xBase) + 16);
    ERRORS_HEAD.copy(buf, o);
    o += ERRORS_HEAD.length;
    o = ex.writeErrors(o, errBase, e, header);
    buf[o++] = 0x5d;
    buf[o++] = 0x7d;
    // Out: the rest after the head, then the head at its place.
    let total;
    if (headEnd >= 0) {
      if (o > headEnd) write(buf, headEnd, o, pos + (headEnd - outBase) + streamed);
      write(buf, outBase, headEnd, pos);
      total = headEnd - outBase + streamed + (o - headEnd);
    } else {
      write(buf, outBase, o, pos);
      total = o - outBase;
    }
    pos += total;
    return true;
  };

  // The document: [{id, input}, ...].
  refill();
  ws();
  if (buf[p] !== 0x5b || p >= validEnd) return false;
  p++;
  ws();
  if (p < validEnd && buf[p] === 0x5d) {
    p++;
    write(Buffer.from('[]'), 0, 2, 0);
    pos = 2;
  } else
    for (let first = true; ; first = false) {
      ws();
      if (p >= validEnd || buf[p] !== 0x7b) return false;
      p++;
      let sawInput = false;
      let sawId = false;
      for (;;) {
        const k = key();
        if (k === 'id' && !sawId) {
          sawId = true;
          if (!skipString()) return false;
        } else if (k === 'input' && !sawInput) {
          sawInput = true;
          if (!readInput(first)) return false;
        } else return false;
        ws();
        if (p >= validEnd) return false;
        if (buf[p] === COMMA) {
          p++;
          continue;
        }
        if (buf[p] === 0x7d) {
          p++;
          break;
        }
        return false;
      }
      if (!sawInput || !sawId) return false;
      ws();
      if (p >= validEnd) return false;
      if (buf[p] === COMMA) {
        p++;
        continue;
      }
      if (buf[p] === 0x5d) {
        p++;
        write(Buffer.from(']'), 0, 1, pos);
        pos += 1;
        break;
      }
      return false;
    }
  ws();
  return p >= validEnd && eof();
}

/** cases.json's bytes (the first `size` of `bytes`) to answers.json's, or null when the byte path declines them. */
export function transduce(bytes, options = {}) {
  const size = options.size ?? bytes.length;
  let out = Buffer.alloc(0);
  let length = 0;
  const ok = transduceStream(
    (buf, at, len, from) => bytes.copy(buf, at, from, from + len),
    size,
    (buf, start, end, at) => {
      const need = at + (end - start);
      if (need > out.length) {
        const bigger = Buffer.alloc(Math.max(need, out.length * 2));
        out.copy(bigger);
        out = bigger;
      }
      buf.copy(out, at, start, end);
      length = Math.max(length, need);
    },
    options.window,
  );
  return ok ? out.subarray(0, length) : null;
}
