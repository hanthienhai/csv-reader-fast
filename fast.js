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
// The text itself is read by readText, WebAssembly (reader.wasm, assembled from reader-src.js): 16 bytes at a time it
// copies a field's bytes to the answer and finds the first byte that steers (i8x16.eq, i8x16.bitmask, i32.ctz), and
// it writes each record as it ends. JavaScript reads the rest of the document (the array, each case's id and input
// object) and writes the bytes around each text.
//
// Whether a case has a header is known only once its input object is read, often after its text, so the first
// record is written where it would stand either way and the bytes around it are filled in at the end: the room
// before it takes `{"columns":` or `{"columns":null,"rows":[`, the room after it `,"rows":[` or nothing, each padded
// with spaces, which JSON reads past. readText keeps the errors as records (code, line, record index, a, b), and
// writeErrors writes them at the end, when a record index can be told as a row.
//
// transduce declines anything it does not read itself (an escape \u, a key or a value an input does not carry, a
// document that is not an array of {id, input}, a string that never ends, an answer past the room set aside): the
// caller then answers every case with run. The output is the same JSON value either way.

import { readFileSync } from 'node:fs';

const BS = 0x5c; // backslash
const DQ = 0x22; // double quote
const COMMA = 0x2c;

// readText's answers.
const OK = 0;
const DECLINE = 4;

const PREFIX_ROOM = 24; // {"columns":null,"rows":[
const GAP_ROOM = 9; // ,"rows":[
const MARGIN = 65536; // room kept past every bound, for 16-byte stores and the bytes around a case
const COLUMNS_HEAD = Buffer.from('{"columns":');
const COLUMNS_NULL = Buffer.from('{"columns":null,"rows":[');
const COLUMNS_EMPTY = Buffer.from('{"columns":[],"rows":[');
const ROWS_HEAD = Buffer.from(',"rows":[');
const ERRORS_HEAD = Buffer.from('],"errors":[');

/** How many quote bytes follow the document in memory: every read stops at one, whatever the document holds. */
export const SENTINEL = 64;

// ---- readText, in WebAssembly: reader.wasm, built from reader-src.js ----

let readerModule = null;
function reader() {
  if (readerModule === null) readerModule = new WebAssembly.Module(readFileSync(new URL('./reader.wasm', import.meta.url)));
  return readerModule;
}

// ---- the document, in JavaScript ----

/**
 * The memory for a document of `size` bytes: [0, size) the document and SENTINEL quotes after it, then the answers
 * (three bytes for each of the document's, and MARGIN), the long rows' cut fields and the error records. The
 * answers are bounded by the text (a field's bytes come out at most three for one: a comma becomes `","`); a short
 * row's padding, the cut fields and the errors are not, and readText declines when their room is gone.
 */
function layout(size) {
  const outBase = (size + SENTINEL + 15) & ~15;
  const outEnd = outBase + 3 * size + MARGIN;
  const xBase = outEnd + MARGIN;
  const xEnd = xBase + size + MARGIN;
  const errBase = (xEnd + MARGIN + 3) & ~3; // read as an Int32Array
  const errEnd = errBase + 2 * size + MARGIN;
  const total = errEnd + MARGIN;
  return { outBase, outEnd, xBase, xEnd, errBase, errEnd, pages: Math.ceil(total / 65536) };
}

let prepared = null; // { memory, buf, size, ...layout }

/** A Buffer to read a document of `size` bytes into (in the reader's memory, so it is never copied). */
export function inputBuffer(size) {
  const lay = layout(size);
  const memory = new WebAssembly.Memory({ initial: lay.pages });
  const buf = Buffer.from(memory.buffer);
  prepared = { memory, buf, size, ...lay };
  return buf.subarray(0, size);
}

/**
 * cases.json's bytes (the first `size` of `bytes`) to answers.json's. With `emit`, each case's answer is handed to it
 * as it is written (the bytes are reused after it returns) and the answer is true, or false when the byte path does
 * not read the document (some answers may have been emitted by then); without, the whole of answers.json, or null.
 */
export function transduce(bytes, size = bytes.length, emit = null) {
  if (prepared === null || prepared.buf.buffer !== bytes.buffer || prepared.size !== size || bytes.byteOffset !== 0) {
    const into = inputBuffer(size);
    bytes.copy(into, 0, 0, size);
  }
  const st = prepared;
  prepared = null;
  st.buf.fill(DQ, size, size + SENTINEL);
  let instance;
  try {
    instance = new WebAssembly.Instance(reader(), { env: { mem: st.memory } });
  } catch {
    return emit ? false : null;
  }
  const ex = instance.exports;
  ex.len.value = size;
  ex.outEnd.value = st.outEnd;
  ex.errEnd.value = st.errEnd;
  ex.xEnd.value = st.xEnd;
  if (emit) return readDocument(st, ex, emit);
  const chunks = [];
  const ok = readDocument(st, ex, (c) => chunks.push(Buffer.from(c)));
  return ok ? Buffer.concat(chunks) : null;
}

function readDocument(st, ex, emit) {
  const b = st.buf;
  const len = st.size;
  let p = 0;
  let o = st.outBase;

  const ws = () => {
    while (p < len) {
      const c = b[p];
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) p++;
      else break;
    }
  };
  // The key at p, a string with no escape, with p past its colon and the whitespace after; false: no such key.
  const key = () => {
    ws();
    if (b[p] !== DQ) return false;
    const s = p + 1;
    let e = s;
    while (e < len && b[e] !== DQ && b[e] !== BS) e++;
    if (b[e] !== DQ) return false;
    const k = b.toString('latin1', s, e);
    p = e + 1;
    ws();
    if (b[p] !== 0x3a) return false;
    p++;
    ws();
    return k;
  };
  const skipString = () => {
    if (b[p] !== DQ) return false;
    p++;
    while (p < len) {
      const c = b[p];
      if (c === BS) p += 2;
      else if (c === DQ) {
        p++;
        return true;
      } else p++;
    }
    return false;
  };
  const put = (src) => {
    src.copy(b, o);
    o += src.length;
  };

  // The input object at p ({text, header}, either order), its answer written at o.
  const readInput = () => {
    if (b[p] !== 0x7b) return false;
    p++;
    let header = -1; // -1: not seen; 0: false; 1: true
    let sawText = false;
    const caseStart = o;
    let records = 0;
    let gapAt = -1;
    let errEnd = st.errBase;
    for (;;) {
      const k = key();
      if (k === 'header' && header < 0) {
        if (b[p] === 0x74 && b[p + 1] === 0x72 && b[p + 2] === 0x75 && b[p + 3] === 0x65) {
          header = 1;
          p += 4;
        } else if (b[p] === 0x66 && b[p + 1] === 0x61 && b[p + 2] === 0x6c && b[p + 3] === 0x73 && b[p + 4] === 0x65) {
          header = 0;
          p += 5;
        } else return false;
      } else if (k === 'text' && !sawText) {
        sawText = true;
        if (b[p] !== DQ) return false;
        // Room for this text's answer: three bytes for each byte left, and the bytes around it.
        if (caseStart + PREFIX_ROOM + GAP_ROOM + 3 * (len - p) + 1024 > st.outEnd) return false;
        if (ex.readText(p, caseStart + PREFIX_ROOM, st.errBase, st.xBase) !== OK) return false;
        p = ex.rP.value;
        // A text that never ends meets the sentinel quotes past the document.
        if (p > len) return false;
        o = ex.rO.value;
        errEnd = ex.rE.value;
        records = ex.rRecords.value;
        gapAt = ex.rGap.value;
      } else return false;
      ws();
      if (b[p] === COMMA) {
        p++;
        continue;
      }
      if (b[p] === 0x7d) {
        p++;
        break;
      }
      return false;
    }
    if (!sawText || header < 0) return false;

    // The bytes around the first record, now that the header is known.
    if (records === 0) {
      o = caseStart;
      put(header === 1 ? COLUMNS_EMPTY : COLUMNS_NULL);
    } else {
      const head = header === 1 ? COLUMNS_HEAD : COLUMNS_NULL;
      b.fill(0x20, caseStart, caseStart + PREFIX_ROOM - head.length);
      head.copy(b, caseStart + PREFIX_ROOM - head.length);
      if (header === 1) {
        ROWS_HEAD.copy(b, gapAt);
        if (records > 1) b[gapAt + GAP_ROOM] = 0x20; // the second record's comma: it is the first row
      } else b.fill(0x20, gapAt, gapAt + GAP_ROOM);
    }
    // The errors, each with its record's row: room for each, its cut fields, and the rest of the document.
    const ne = (errEnd - st.errBase) / 20;
    const cut = ex.rX.value - st.xBase;
    if (o + ERRORS_HEAD.length + 100 * ne + cut + 3 * (len - p) + 1024 > st.outEnd) return false;
    put(ERRORS_HEAD);
    o = ex.writeErrors(o, st.errBase, errEnd, header);
    b[o++] = 0x5d;
    b[o++] = 0x7d;
    return true;
  };

  // The document: [{id, input}, ...].
  ws();
  if (b[p] !== 0x5b) return false;
  p++;
  b[o++] = 0x5b;
  ws();
  if (b[p] === 0x5d) p++;
  else
    for (let first = true; ; first = false) {
      ws();
      if (b[p] !== 0x7b) return false;
      p++;
      if (!first) b[o++] = COMMA;
      let sawInput = false;
      let sawId = false;
      for (;;) {
        const k = key();
        if (k === 'id' && !sawId) {
          sawId = true;
          if (!skipString()) return false;
        } else if (k === 'input' && !sawInput) {
          sawInput = true;
          if (!readInput()) return false;
        } else return false;
        ws();
        if (b[p] === COMMA) {
          p++;
          continue;
        }
        if (b[p] === 0x7d) {
          p++;
          break;
        }
        return false;
      }
      if (!sawInput || !sawId) return false;
      // The case's answer is whole: out it goes, and its room is used again for the next.
      emit(b.subarray(st.outBase, o));
      o = st.outBase;
      ws();
      if (b[p] === COMMA) {
        p++;
        continue;
      }
      if (b[p] === 0x5d) {
        p++;
        break;
      }
      return false;
    }
  ws();
  if (p !== len) return false;
  b[o++] = 0x5d;
  emit(b.subarray(st.outBase, o));
  return true;
}
