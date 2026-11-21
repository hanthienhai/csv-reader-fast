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
// Whether the case has a header is known only once its input object is read, often after its text, so the first
// record is written where it would stand either way and the bytes around it are filled in at the end: the room
// before it takes `{"columns":` or `{"columns":null,"rows":[`, the room after it `,"rows":[` or nothing, each padded
// with spaces, which JSON reads past. The errors are kept with the index of the record they belong to and written at
// the end, when that index can be told as a row.
//
// transduce returns null for anything it does not read itself (an escape \u, a key or a value an input does not
// carry, a document that is not an array of {id, input}, a string that never ends): the caller then answers every
// case with run. The output is the same JSON value either way.
//
// The work is split into small functions, each called once a field or once a record, so V8 optimizes each whole
// after a few calls; one function with the loops nested in it is optimized only loop by loop (on-stack replacement)
// and drops back to the interpreter every time an inner loop exits. The reader's state is module-level, copied into
// locals inside each function's loop.

const BS = 0x5c; // backslash
const DQ = 0x22; // double quote: an escape's second byte, or the end of the string
const COMMA = 0x2c;
const N = 0x6e; // n
const R = 0x72; // r
const U = 0x75; // u

const CODE_STRAY_CR = 0;
const CODE_QUOTE_JUNK = 1;
const CODE_UNTERMINATED = 2;
const CODE_SHORT = 3;
const CODE_LONG = 4;
const CODE_BYTES = ['stray_cr', 'quote_junk', 'unterminated_quote', 'short_row', 'long_row'].map((s) =>
  Buffer.from(`{"code":"${s}","line":`),
);

const PREFIX_ROOM = 24; // {"columns":null,"rows":[
const GAP_ROOM = 9; // ,"rows":[
const MARGIN = 4096;
const COLUMNS_HEAD = Buffer.from('{"columns":');
const COLUMNS_NULL = Buffer.from('{"columns":null,"rows":[');
const COLUMNS_EMPTY = Buffer.from('{"columns":[],"rows":[');
const ROWS_HEAD = Buffer.from(',"rows":[');
const ERRORS_HEAD = Buffer.from('],"errors":[');
const ROW_NULL = Buffer.from(',"row":null');
const ROW_KEY = Buffer.from(',"row":');
const FIELDS_KEY = Buffer.from(',"fields":');
const EXTRA_KEY = Buffer.from(',"extra":[');

// What a field or record reader says happened.
const AT_COMMA = 0;
const AT_BREAK = 1; // a LF or a CRLF, read past
const AT_END = 2; // the closing quote of the text, not read past
const AT_STRAY_CR = 3; // a CR not followed by LF outside quotes, read past
const DECLINE = 4; // an escape the byte path does not read
const CLOSED = 5; // a quoted field's closing quote, read past
const UNTERMINATED = 6; // a quoted field ran into the end of the text

// The reader's state.
let b = Buffer.alloc(0); // the input
let len = 0;
let out = Buffer.alloc(0); // the output
let p = 0; // the next input byte
let o = 0; // the next output byte
let line = 1; // the line the next input byte is on
let records = 0; // the current case's records read so far (its header record among them)
let width = -1; // the first record's field count
let gapAt = -1; // where the room after the current case's first record starts
// The current case's errors: code, line, record index, and a number (short_row's field count) or a range of xb
// (long_row's cut fields, as JSON).
const eCode = [];
const eLine = [];
const eRec = [];
const eA = [];
const eB = [];
let xb = Buffer.alloc(0);
let xo = 0;

/** `buf` with room for `need` more bytes after `used`: itself, or a larger copy. */
function grow(buf, used, need) {
  if (used + need <= buf.length) return buf;
  const bigger = Buffer.allocUnsafeSlow(Math.max(buf.length * 2, used + need + 65536));
  buf.copy(bigger, 0, 0, used);
  return bigger;
}

/** Writes v (an integer >= 0) at o; the new end. */
function writeInt(buf, at, v) {
  if (v === 0) {
    buf[at++] = 0x30;
    return at;
  }
  const s = at;
  while (v > 0) {
    buf[at++] = 0x30 + (v % 10);
    v = Math.floor(v / 10);
  }
  for (let i = s, j = at - 1; i < j; i++, j--) {
    const t = buf[i];
    buf[i] = buf[j];
    buf[j] = t;
  }
  return at;
}

function pushError(code, recLine, a, z) {
  eCode.push(code);
  eLine.push(recLine);
  eRec.push(records);
  eA.push(a);
  eB.push(z);
}

/**
 * Copies unquoted bytes from p to o up to the next comma, line break or the end of the text. A CR not followed by LF
 * stops it too (AT_STRAY_CR, read past): the caller records it and calls again for the rest of the field.
 */
function copyUnquoted() {
  const src = b;
  const dst = out;
  let i = p;
  let j = o;
  for (;;) {
    const c = src[i];
    if (c === COMMA) {
      p = i + 1;
      o = j;
      return AT_COMMA;
    }
    if (c === BS) {
      const d = src[i + 1];
      if (d === N) {
        p = i + 2;
        o = j;
        line++;
        return AT_BREAK;
      }
      if (d === R) {
        o = j;
        if (src[i + 2] === BS && src[i + 3] === N) {
          p = i + 4;
          line++;
          return AT_BREAK;
        }
        p = i + 2;
        return AT_STRAY_CR;
      }
      if (d === U) return DECLINE;
      dst[j] = BS;
      dst[j + 1] = d;
      j += 2;
      i += 2;
      continue;
    }
    if (c === DQ) {
      p = i;
      o = j;
      return AT_END;
    }
    dst[j++] = c;
    i++;
  }
}

/**
 * Copies a quoted field's bytes from p (just past its opening quote) to o, "" as one quote and a CRLF or lone CR as
 * LF, up to its closing quote (CLOSED, read past). UNTERMINATED when the text ends first (the caller starts over).
 */
function copyQuoted() {
  const src = b;
  const dst = out;
  let i = p;
  let j = o;
  let lines = 0;
  for (;;) {
    const c = src[i];
    if (c === BS) {
      const d = src[i + 1];
      if (d === DQ) {
        if (src[i + 2] === BS && src[i + 3] === DQ) {
          dst[j] = BS;
          dst[j + 1] = DQ;
          j += 2;
          i += 4;
          continue;
        }
        p = i + 2;
        o = j;
        line += lines;
        return CLOSED;
      }
      if (d === R) {
        dst[j] = BS;
        dst[j + 1] = N;
        j += 2;
        lines++;
        i += src[i + 2] === BS && src[i + 3] === N ? 4 : 2;
        continue;
      }
      if (d === N) lines++;
      else if (d === U) return DECLINE;
      dst[j] = BS;
      dst[j + 1] = d;
      j += 2;
      i += 2;
      continue;
    }
    if (c === DQ) return UNTERMINATED;
    dst[j++] = c;
    i++;
  }
}

/** Reads the record at p (its line skipped past empty lines already) onto o. AT_BREAK, AT_END or DECLINE. */
function readRecord() {
  const recLine = line;
  const rowStart = o;
  if (records > 0) out[o++] = COMMA;
  out[o++] = 0x5b;
  let count = 0;
  let extraAt = -1;
  let quoted = false;
  let fieldStart = 0;
  let ended = AT_COMMA;
  do {
    if (count > 0) {
      if (count === width) extraAt = o;
      out[o++] = COMMA;
    }
    out[o++] = DQ;
    fieldStart = o;
    let junk = false;
    quoted = b[p] === BS && b[p + 1] === DQ;
    let unquoted = true;
    if (quoted) {
      const open = p;
      const openLine = line;
      p += 2;
      const r = copyQuoted();
      if (r === DECLINE) return DECLINE;
      if (r === UNTERMINATED) {
        // A literal quote, and the text after it read again as unquoted.
        p = open + 2;
        line = openLine;
        o = fieldStart;
        out[o++] = BS;
        out[o++] = DQ;
        pushError(CODE_UNTERMINATED, recLine, 0, 0);
      } else {
        const c = b[p];
        if (c === COMMA) {
          p++;
          unquoted = false;
          ended = AT_COMMA;
        } else if (c === DQ) {
          unquoted = false;
          ended = AT_END;
        } else if (c === BS && b[p + 1] === N) {
          p += 2;
          line++;
          unquoted = false;
          ended = AT_BREAK;
        } else if (c === BS && b[p + 1] === R && b[p + 2] === BS && b[p + 3] === N) {
          p += 4;
          line++;
          unquoted = false;
          ended = AT_BREAK;
        } else junk = true; // what follows the closing quote is appended as it stands
      }
    }
    if (unquoted) {
      const keptFrom = o;
      for (;;) {
        ended = copyUnquoted();
        if (ended !== AT_STRAY_CR) break;
        pushError(CODE_STRAY_CR, recLine, 0, 0);
      }
      if (ended === DECLINE) return DECLINE;
      if (junk && o > keptFrom) pushError(CODE_QUOTE_JUNK, recLine, 0, 0);
    }
    out[o++] = DQ;
    count++;
  } while (ended === AT_COMMA);

  // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
  if (count === 1 && !quoted && o === fieldStart + 1) {
    o = rowStart;
    return ended;
  }
  if (width < 0) width = count;
  else if (count < width) {
    out = grow(out, o, 3 * (width - count) + 3 * (len - p) + MARGIN);
    for (let k = count; k < width; k++) {
      out[o] = COMMA;
      out[o + 1] = DQ;
      out[o + 2] = DQ;
      o += 3;
    }
    pushError(CODE_SHORT, recLine, count, 0);
  } else if (count > width) {
    // The cut fields leave the row for the error's extra.
    const from = extraAt + 1;
    const n = o - from;
    xb = grow(xb, xo, n);
    out.copy(xb, xo, from, o);
    pushError(CODE_LONG, recLine, xo, xo + n);
    xo += n;
    o = extraAt;
  }
  out[o++] = 0x5d;
  if (records === 0) {
    gapAt = o;
    o += GAP_ROOM;
  }
  records++;
  return ended;
}

/** Reads a case's text from p (its opening quote) to past its closing quote. False: declined. */
function readText() {
  p++;
  if (b[p] === 0xef && b[p + 1] === 0xbb && b[p + 2] === 0xbf) p += 3; // U+FEFF at the very start
  line = 1;
  width = -1;
  for (;;) {
    // Lines with no characters are no records.
    for (;;) {
      if (b[p] !== BS) break;
      const d = b[p + 1];
      if (d === N) {
        p += 2;
        line++;
      } else if (d === R && b[p + 2] === BS && b[p + 3] === N) {
        p += 4;
        line++;
      } else break;
    }
    if (b[p] === DQ) break; // the end of the text
    const r = readRecord();
    if (r === DECLINE) return false;
    if (r === AT_END) break;
  }
  p++; // the closing quote
  return true;
}

function ws() {
  while (p < len) {
    const c = b[p];
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) p++;
    else break;
  }
}

/** The key at p, a string with no escape, with p past its colon and the whitespace after; null: no such key. */
function key() {
  ws();
  if (b[p] !== DQ) return null;
  const s = p + 1;
  let e = s;
  while (e < len && b[e] !== DQ && b[e] !== BS) e++;
  if (b[e] !== DQ) return null;
  const k = b.latin1Slice(s, e);
  p = e + 1;
  ws();
  if (b[p] !== 0x3a) return null;
  p++;
  ws();
  return k;
}

/** Skips the JSON string at p; false when there is none. */
function skipString() {
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
}

/** The input object at p ({text, header}, either order), its answer written at o. False: declined. */
function readInput() {
  if (b[p] !== 0x7b) return false;
  p++;
  let header = -1; // -1: not seen; 0: false; 1: true
  let sawText = false;
  out = grow(out, o, PREFIX_ROOM + GAP_ROOM + 3 * (len - p) + MARGIN);
  const caseStart = o;
  records = 0;
  gapAt = -1;
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
      o = caseStart + PREFIX_ROOM;
      if (!readText()) return false;
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
    const head = header === 1 ? COLUMNS_EMPTY : COLUMNS_NULL;
    head.copy(out, o);
    o += head.length;
  } else {
    const head = header === 1 ? COLUMNS_HEAD : COLUMNS_NULL;
    out.fill(0x20, caseStart, caseStart + PREFIX_ROOM - head.length);
    head.copy(out, caseStart + PREFIX_ROOM - head.length);
    if (header === 1) {
      ROWS_HEAD.copy(out, gapAt);
      if (records > 1) out[gapAt + GAP_ROOM] = 0x20; // the second record's comma: it is the first row
    } else out.fill(0x20, gapAt, gapAt + GAP_ROOM);
  }
  // The errors, each with its record's row.
  const ne = eCode.length;
  out = grow(out, o, ERRORS_HEAD.length + 96 * ne + xo + 3 * (len - p) + MARGIN);
  ERRORS_HEAD.copy(out, o);
  o += ERRORS_HEAD.length;
  for (let i = 0; i < ne; i++) {
    if (i > 0) out[o++] = COMMA;
    const code = eCode[i];
    const cb = CODE_BYTES[code];
    cb.copy(out, o);
    o += cb.length;
    o = writeInt(out, o, eLine[i]);
    const rec = eRec[i];
    if (header === 1 && rec === 0) {
      ROW_NULL.copy(out, o);
      o += ROW_NULL.length;
    } else {
      ROW_KEY.copy(out, o);
      o += ROW_KEY.length;
      o = writeInt(out, o, header === 1 ? rec - 1 : rec);
    }
    if (code === CODE_SHORT) {
      FIELDS_KEY.copy(out, o);
      o += FIELDS_KEY.length;
      o = writeInt(out, o, eA[i]);
    } else if (code === CODE_LONG) {
      EXTRA_KEY.copy(out, o);
      o += EXTRA_KEY.length;
      xb.copy(out, o, eA[i], eB[i]);
      o += eB[i] - eA[i];
      out[o++] = 0x5d;
    }
    out[o++] = 0x7d;
  }
  out[o++] = 0x5d;
  out[o++] = 0x7d;
  eCode.length = eLine.length = eRec.length = eA.length = eB.length = 0;
  xo = 0;
  return true;
}

/** The document: [{id, input}, ...]. False: declined. */
function readDocument() {
  ws();
  if (b[p] !== 0x5b) return false;
  p++;
  out[o++] = 0x5b;
  ws();
  if (b[p] === 0x5d) p++;
  else
    for (let first = true; ; first = false) {
      ws();
      if (b[p] !== 0x7b) return false;
      p++;
      if (!first) out[o++] = COMMA;
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
  out = grow(out, o, 1);
  out[o++] = 0x5d;
  return true;
}

/**
 * A small document that takes every path of the byte path (header or not, either key order, a BOM, LF and CRLF,
 * quoted fields with "" and line breaks inside, text after a closing quote, stray CRs, a line of them alone, an
 * unterminated quote, short and long rows, escapes copied as they stand, UTF-8), `records` records a case. Reading it
 * first lets V8 optimize each function with every path's type feedback, before the real document; otherwise each path
 * first met mid-way throws its optimized code away.
 */
export function primer(records) {
  const pieces = ['alpha', 'b', '', '12.5', 'café 數', 'x\ty', 'a\\b', 'q/r'];
  const cases = [];
  let s = 7;
  const rnd = (k) => ((s = (s * 1103515245 + 12345) >>> 0) >>> 8) % k;
  for (let c = 0; c < 4; c++) {
    const eol = c % 2 === 0 ? '\r\n' : '\n';
    let text = c === 1 ? '﻿' : '';
    for (let r = 0; r < records; r++) {
      const width = 4 + (rnd(5) === 0 ? rnd(3) - 1 : 0);
      const fields = [];
      for (let f = 0; f < width; f++) {
        const v = pieces[rnd(pieces.length)];
        const k = rnd(12);
        if (k < 6) fields.push(v);
        else if (k < 9) fields.push(`"${v},${v}"`);
        else if (k === 9) fields.push(`"${v}""${v}${eol}${v}\r${v}"`);
        else if (k === 10) fields.push(`"${v}"junk`);
        else fields.push(`${v}\r${v}`);
      }
      text += fields.join(',') + eol;
      if (rnd(20) === 0) text += eol + '\r' + eol;
    }
    if (c === 3) text += 'tail,"never closes' + eol + 'a,b';
    const header = c % 3 !== 2;
    cases.push({ id: `p-${c}`, input: c === 2 ? { header, text } : { text, header } });
  }
  return Buffer.from(JSON.stringify(cases) + '"'.repeat(SENTINEL));
}

/** How many quote bytes must follow the document: every read stops at one, whatever the document holds. */
export const SENTINEL = 8;

/**
 * cases.json's bytes to answers.json's bytes, or null when the byte path does not read them. The document is the
 * first `size` bytes of `bytes`; when SENTINEL quote bytes do not follow them there, they are read from a copy that
 * has them. Past the document's end a read meets only those quotes, so a string that never closes ends there and the
 * document is declined.
 */
export function transduce(bytes, size = bytes.length) {
  let padded = bytes.length >= size + SENTINEL;
  for (let i = 0; padded && i < SENTINEL; i++) padded = bytes[size + i] === DQ;
  if (!padded) {
    const copy = Buffer.allocUnsafeSlow(size + SENTINEL);
    bytes.copy(copy, 0, 0, size);
    copy.fill(DQ, size);
    bytes = copy;
  }
  b = bytes;
  len = size;
  // Room for every answer: a field's bytes come out at most three for one (a comma becomes `","`), and the rarer
  // writes (padding, errors, the bytes around a case) make room for themselves with grow.
  out = Buffer.allocUnsafeSlow(3 * len + 65536);
  xb = Buffer.allocUnsafeSlow(65536);
  p = 0;
  o = 0;
  xo = 0;
  eCode.length = eLine.length = eRec.length = eA.length = eB.length = 0;
  const ok = readDocument();
  const result = ok ? out.subarray(0, o) : null;
  b = out = xb = Buffer.alloc(0);
  return result;
}
