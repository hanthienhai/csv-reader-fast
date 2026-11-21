// A faster drop-in for csv-reader 1.0.0's readCsv: run(input) returns the same {columns, rows, errors} for every
// input {text, header}. Same policy, read once left to right:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a quoted field runs to the next quote that is not doubled, "" inside it one quote, each CRLF or lone CR inside
//     it read as LF; what follows its closing quote up to the next comma or line break is appended (quote_junk when
//     anything was appended); a quote that never closes is a literal character and the text after it is read again
//     as unquoted (unterminated_quote);
//   - rows are padded (short_row) or cut (long_row) to the first record's width;
//   - errors carry the line their record starts on (every LF, CRLF and lone CR inside quotes counted) and the
//     record's index in rows (null for the header), in the order met.
//
// How it is fast: nothing is read a character at a time. The next comma, quote, CR and LF at or after the read
// position are each found with indexOf and kept until the position passes them, so a field's end is the least of
// them and its value one slice. A line with no quote and no CR but its CRLF's is cut with one native split.
// Everything lives in one function, so the position and line counters stay in registers.

const COMMA = 44; // ,
const QUOTE = 34; // "
const LF = 10;
const CR = 13;

/** csv-reader 1.0.0's reading of one input {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = n > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // The next comma, quote, CR and LF at or after a point already read (n when there is none). One is stale once
  // the position passes it (< pos), and is found again then.
  let nextComma = -1;
  let nextQuote = -1;
  let nextCR = -1;
  let nextLF = -1;

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && pos + 1 < n && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;

    if (nextLF < pos) {
      nextLF = text.indexOf('\n', pos);
      if (nextLF < 0) nextLF = n;
    }
    if (nextQuote < pos) {
      nextQuote = text.indexOf('"', pos);
      if (nextQuote < 0) nextQuote = n;
    }
    if (nextCR < pos) {
      nextCR = text.indexOf('\r', pos);
      if (nextCR < 0) nextCR = n;
    }

    let fields;
    const nl = nextLF;
    if (nextCR >= nl || (nextCR === nl - 1 && nl < n)) {
      // The line holds no CR but its CRLF's: cut it at every comma, natively.
      fields = text.slice(pos, nextCR === nl - 1 ? nl - 1 : nl).split(',');
      if (nextQuote < nl) {
        // Quotes on the line: a piece that opens with a quote is a quoted field, which runs on over the next pieces
        // (its commas) to its closing quote. Only a quoted field that closes right at a piece's end is read here;
        // one that runs past the line, never closes or has text after its closing quote leaves the line to the
        // field-by-field reader (fields stays unset).
        let out = 0;
        const m = fields.length;
        for (let k = 0; k < m; k++) {
          let p = fields[k];
          if (p.charCodeAt(0) === QUOTE) {
            let j = 1;
            let doubled = false;
            for (;;) {
              const q = p.indexOf('"', j);
              if (q < 0) {
                // No closing quote in this piece: the field takes the comma and the next piece.
                k += 1;
                if (k >= m) break;
                j = p.length + 1;
                p = p + ',' + fields[k];
                continue;
              }
              if (q + 1 < p.length && p.charCodeAt(q + 1) === QUOTE) {
                doubled = true;
                j = q + 2;
                continue;
              }
              j = q;
              break;
            }
            if (k >= m || j !== p.length - 1) {
              fields = undefined;
              break;
            }
            p = p.slice(1, -1);
            if (doubled) p = p.replaceAll('""', '"');
          }
          fields[out++] = p;
        }
        if (fields !== undefined) fields.length = out;
      }
      if (fields !== undefined) {
        if (nl < n) {
          pos = nl + 1;
          line += 1;
        } else {
          pos = n;
        }
      }
    }
    if (fields === undefined) {
      // Field by field.
      fields = [];
      let quoted = false;
      for (;;) {
        let value = '';
        let ended = 0; // 0: at a comma, 1: at a line break, 2: at the end of the text
        let unquoted = true; // read (the rest of) the field as unquoted text, onto `value`
        let junk = false; // what is read so is quote_junk
        quoted = pos < n && text.charCodeAt(pos) === QUOTE;
        if (quoted) {
          const open = pos;
          const openLine = line;
          let i = pos + 1;
          let closed = false;
          for (;;) {
            if (nextQuote < i) {
              nextQuote = text.indexOf('"', i);
              if (nextQuote < 0) nextQuote = n;
            }
            const q = nextQuote;
            if (q >= n) break;
            if (q > i) {
              if (nextCR < i) {
                nextCR = text.indexOf('\r', i);
                if (nextCR < 0) nextCR = n;
              }
              if (nextLF < i) {
                nextLF = text.indexOf('\n', i);
                if (nextLF < 0) nextLF = n;
              }
              let seg = text.slice(i, q);
              if (nextCR < q) {
                // CRLF and a lone CR inside quotes are each one LF, and each a line.
                seg = seg.replace(/\r\n?/g, '\n');
                for (let k = seg.indexOf('\n'); k >= 0; k = seg.indexOf('\n', k + 1)) line += 1;
              } else {
                while (nextLF < q) {
                  line += 1;
                  nextLF = text.indexOf('\n', nextLF + 1);
                  if (nextLF < 0) nextLF = n;
                }
              }
              value = value === '' ? seg : value + seg;
            }
            if (q + 1 < n && text.charCodeAt(q + 1) === QUOTE) {
              value += '"';
              i = q + 2;
              continue;
            }
            pos = q + 1;
            closed = true;
            break;
          }
          if (!closed) {
            // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
            pos = open + 1;
            line = openLine;
            nextComma = nextQuote = nextCR = nextLF = -1;
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            value = '"';
          } else if (pos >= n) {
            ended = 2;
            unquoted = false;
          } else {
            const c = text.charCodeAt(pos);
            if (c === COMMA) {
              pos += 1;
              unquoted = false;
            } else if (c === LF) {
              pos += 1;
              line += 1;
              ended = 1;
              unquoted = false;
            } else if (c === CR && pos + 1 < n && text.charCodeAt(pos + 1) === LF) {
              pos += 2;
              line += 1;
              ended = 1;
              unquoted = false;
            } else {
              // What follows the closing quote is appended as it stands, up to the next comma or line break.
              junk = true;
            }
          }
        }
        if (unquoted) {
          let added = 0;
          for (;;) {
            if (nextComma < pos) {
              nextComma = text.indexOf(',', pos);
              if (nextComma < 0) nextComma = n;
            }
            if (nextLF < pos) {
              nextLF = text.indexOf('\n', pos);
              if (nextLF < 0) nextLF = n;
            }
            if (nextCR < pos) {
              nextCR = text.indexOf('\r', pos);
              if (nextCR < 0) nextCR = n;
            }
            let stop = nextComma < nextLF ? nextComma : nextLF;
            if (nextCR < stop) stop = nextCR;
            if (stop > pos) {
              value = value === '' ? text.slice(pos, stop) : value + text.slice(pos, stop);
              added += stop - pos;
              pos = stop;
            }
            if (stop >= n) {
              ended = 2;
              break;
            }
            const c = text.charCodeAt(stop);
            if (c === COMMA) {
              pos += 1;
              break;
            }
            if (c === LF) {
              pos += 1;
              line += 1;
              ended = 1;
              break;
            }
            if (pos + 1 < n && text.charCodeAt(pos + 1) === LF) {
              pos += 2;
              line += 1;
              ended = 1;
              break;
            }
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            pos += 1;
          }
          if (junk && added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
        fields.push(value);
        if (ended !== 0) break;
      }
      // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    }

    const count = fields.length;
    if (width < 0) width = count;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (count < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: count });
      for (let k = count; k < width; k++) fields.push('');
    } else if (count > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
