// readText, the WebAssembly that reads a case's text for the byte path (fast.js), as source: the build
// (node tools/build-wasm.mjs) assembles it with wasm.js into reader.wasm, which fast.js loads; tools/check-bytes.mjs
// checks that reader.wasm is this source assembled.
//
// readText(p, o, e, x) reads a case's text, a JSON string, from p as CSV and writes its records at o, as fast.js
// says, the error records (code, line, record index, a, b: five i32s each) at e and the long rows' cut fields at x.
// The input is read a window at a time: the globals sStart (1: p is the string's opening quote), sLine, sWidth,
// sRecords and sGap carry the reading from one call to the next, and winEnd is where the input read so far ends,
// past which the memory holds quotes. A bare quote before winEnd ends the text: readText answers OK with the ends in
// rP, rO, rE, rX. A record that reaches winEnd is given up whole and readText answers NEED_INPUT, the ends and the
// state as they stood before it; a short row with no room for its padding below outEnd, NEED_ROOM, the same way.
// DECLINE: an escape \u, or no room left for errors (errEnd) or cut fields (xEnd).

import { assemble } from './wasm.js';

export const OK = 0;
export const DECLINE = 4;
export const NEED_INPUT = 5;
export const NEED_ROOM = 6;
const CODE_SHORT = 3;
const CODE_LONG = 4;

const inc = (v, k) => `local.get ${v}\ni32.const ${k}\ni32.add\nlocal.set ${v}`;
const addLocal = (v, w) => `local.get ${v}\nlocal.get ${w}\ni32.add\nlocal.set ${v}`;
// Records an error (code, the record's line, the record's index, a, b) at $e; declines when the room is gone.
const pushError = (code, a, b) => `
local.get $e
i32.const 20
i32.add
global.get $errEnd
i32.gt_u
if
i32.const ${DECLINE}
return
end
local.get $e
i32.const ${code}
i32.store
local.get $e
local.get $recLine
i32.store offset=4
local.get $e
local.get $records
i32.store offset=8
local.get $e
${a}
i32.store offset=12
local.get $e
${b}
i32.store offset=16
${inc('$e', 20)}`;
// Saves where the reading stands (the ends and the state) in the globals.
const SAVE = `
local.get $p
global.set $rP
local.get $o
global.set $rO
local.get $e
global.set $rE
local.get $x
global.set $rX
i32.const 0
global.set $sStart
local.get $line
global.set $sLine
local.get $width
global.set $sWidth
local.get $records
global.set $sRecords
local.get $gap
global.set $sGap`;
// Gives up the record being read (its bytes, errors and cut fields), saves the state as it stood before it and
// answers code: the caller brings more input (NEED_INPUT) or room (NEED_ROOM) and calls again.
const abort = (code) => `
local.get $recP
local.set $p
local.get $recLine
local.set $line
local.get $rowStart
local.set $o
local.get $recE
local.set $e
local.get $recX
local.set $x
${SAVE}
i32.const ${code}
return`;
// A bare quote at $p is the end of the text, or, at or past $winEnd, the end of the input read so far.
const pastWindow = `
local.get $p
global.get $winEnd
i32.ge_u
if
${abort(NEED_INPUT)}
end`;

// The 16 bytes at $p, stored at $o, and the mask of the bytes among them equal to any of the splats named.
const scan = (...splats) => `
local.get $p
v128.load
local.set $v
local.get $o
local.get $v
v128.store
${splats.map((s, i) => `local.get $v\nlocal.get ${s}\ni8x16.eq${i > 0 ? '\nv128.or' : ''}`).join('\n')}
i8x16.bitmask
local.tee $m`;

const READ_TEXT = `
i32.const 92
i8x16.splat
local.set $sBS
i32.const 34
i8x16.splat
local.set $sDQ
i32.const 44
i8x16.splat
local.set $sCM
;; the first call of a text: past its opening quote, and past a U+FEFF at its very start
global.get $sStart
if
${inc('$p', 1)}
local.get $p
i32.load16_u
i32.const 0xBBEF
i32.eq
if
local.get $p
i32.load8_u offset=2
i32.const 191
i32.eq
if
${inc('$p', 3)}
end
end
end
global.get $sLine
local.set $line
global.get $sWidth
local.set $width
global.get $sRecords
local.set $records
global.get $sGap
local.set $gap
block $done
loop $record
;; lines with no characters are no records: \\n (5C 6E) and \\r\\n (5C 72 5C 6E)
loop $skip
local.get $p
i32.load16_u
i32.const 0x6E5C
i32.eq
if
${inc('$p', 2)}
${inc('$line', 1)}
br $skip
end
local.get $p
i32.load
i32.const 0x6E5C725C
i32.eq
if
${inc('$p', 4)}
${inc('$line', 1)}
br $skip
end
end
local.get $p
local.set $recP
local.get $line
local.set $recLine
local.get $o
local.set $rowStart
local.get $e
local.set $recE
local.get $x
local.set $recX
;; the end of the text
local.get $p
i32.load8_u
i32.const 34
i32.eq
if
${pastWindow}
br $done
end
local.get $records
if
local.get $o
i32.const 44
i32.store8
${inc('$o', 1)}
end
local.get $o
i32.const 91
i32.store8
${inc('$o', 1)}
i32.const 0
local.set $count
i32.const -1
local.set $extraAt
loop $field
local.get $count
if
local.get $count
local.get $width
i32.eq
if
local.get $o
local.set $extraAt
end
local.get $o
i32.const 44
i32.store8
${inc('$o', 1)}
end
local.get $o
i32.const 34
i32.store8
${inc('$o', 1)}
local.get $o
local.set $fieldStart
i32.const 0
local.set $junk
;; a field that opens with \\" (5C 22) is quoted
local.get $p
i32.load16_u
i32.const 0x225C
i32.eq
local.set $quoted
block $fielddone
block $unquoted
local.get $quoted
if
local.get $p
local.set $open
local.get $line
local.set $openLine
${inc('$p', 2)}
block $closed
block $unterm
loop $q
${scan('$sBS', '$sDQ')}
i32.eqz
if
${inc('$p', 16)}
${inc('$o', 16)}
br $q
end
local.get $m
i32.ctz
local.set $n
${addLocal('$p', '$n')}
${addLocal('$o', '$n')}
;; a bare quote is the end of the text: the field's quote never closes
local.get $p
i32.load8_u
i32.const 34
i32.eq
if
${pastWindow}
br $unterm
end
local.get $p
i32.load8_u offset=1
local.set $d
local.get $d
i32.const 34
i32.eq
if
;; \\"\\" is one quote; \\" alone closes the field
local.get $p
i32.load
i32.const 0x225C225C
i32.eq
if
local.get $o
i32.const 0x225C
i32.store16
${inc('$o', 2)}
${inc('$p', 4)}
br $q
end
${inc('$p', 2)}
br $closed
end
local.get $d
i32.const 114
i32.eq
if
;; CRLF and a lone CR inside quotes are each one LF
local.get $o
i32.const 0x6E5C
i32.store16
${inc('$o', 2)}
${inc('$line', 1)}
local.get $p
i32.load16_u offset=2
i32.const 0x6E5C
i32.eq
if
${inc('$p', 4)}
else
${inc('$p', 2)}
end
br $q
end
local.get $d
i32.const 110
i32.eq
if
${inc('$line', 1)}
end
local.get $d
i32.const 117
i32.eq
if
i32.const ${DECLINE}
return
end
local.get $o
local.get $d
i32.const 8
i32.shl
i32.const 92
i32.or
i32.store16
${inc('$o', 2)}
${inc('$p', 2)}
br $q
end
end
;; the quote never closes: it is a literal quote, and the text after it is read again as unquoted
local.get $open
i32.const 2
i32.add
local.set $p
local.get $openLine
local.set $line
local.get $fieldStart
local.set $o
local.get $o
i32.const 0x225C
i32.store16
${inc('$o', 2)}
${pushError(2, 'i32.const 0', 'i32.const 0')}
br $unquoted
end
;; after the closing quote: a comma, a line break, the end of the text, or text appended as it stands
local.get $p
i32.load8_u
local.tee $c
i32.const 44
i32.eq
if
${inc('$p', 1)}
i32.const 0
local.set $ended
br $fielddone
end
local.get $c
i32.const 34
i32.eq
if
${pastWindow}
i32.const 2
local.set $ended
br $fielddone
end
local.get $p
i32.load16_u
i32.const 0x6E5C
i32.eq
if
${inc('$p', 2)}
${inc('$line', 1)}
i32.const 1
local.set $ended
br $fielddone
end
local.get $p
i32.load
i32.const 0x6E5C725C
i32.eq
if
${inc('$p', 4)}
${inc('$line', 1)}
i32.const 1
local.set $ended
br $fielddone
end
i32.const 1
local.set $junk
end
end
;; unquoted bytes, up to a comma, a line break or the end of the text
local.get $o
local.set $keptFrom
block $uend
loop $u
${scan('$sCM', '$sBS', '$sDQ')}
i32.eqz
if
${inc('$p', 16)}
${inc('$o', 16)}
br $u
end
local.get $m
i32.ctz
local.set $n
${addLocal('$p', '$n')}
${addLocal('$o', '$n')}
local.get $p
i32.load8_u
local.tee $c
i32.const 44
i32.eq
if
${inc('$p', 1)}
i32.const 0
local.set $ended
br $uend
end
local.get $c
i32.const 34
i32.eq
if
${pastWindow}
i32.const 2
local.set $ended
br $uend
end
local.get $p
i32.load8_u offset=1
local.set $d
local.get $d
i32.const 110
i32.eq
if
${inc('$p', 2)}
${inc('$line', 1)}
i32.const 1
local.set $ended
br $uend
end
local.get $d
i32.const 114
i32.eq
if
local.get $p
i32.load16_u offset=2
i32.const 0x6E5C
i32.eq
if
${inc('$p', 4)}
${inc('$line', 1)}
i32.const 1
local.set $ended
br $uend
end
;; a CR not followed by LF outside quotes is dropped
${pushError(0, 'i32.const 0', 'i32.const 0')}
${inc('$p', 2)}
br $u
end
local.get $d
i32.const 117
i32.eq
if
i32.const ${DECLINE}
return
end
local.get $o
local.get $d
i32.const 8
i32.shl
i32.const 92
i32.or
i32.store16
${inc('$o', 2)}
${inc('$p', 2)}
br $u
end
end
local.get $junk
local.get $o
local.get $keptFrom
i32.gt_u
i32.and
if
${pushError(1, 'i32.const 0', 'i32.const 0')}
end
end
local.get $o
i32.const 34
i32.store8
${inc('$o', 1)}
${inc('$count', 1)}
local.get $ended
i32.eqz
br_if $field
end
;; a line that held only stray CRs is left with no characters: no record (its stray_cr errors stay)
local.get $count
i32.const 1
i32.eq
local.get $quoted
i32.eqz
i32.and
local.get $o
local.get $fieldStart
i32.const 1
i32.add
i32.eq
i32.and
if
local.get $rowStart
local.set $o
local.get $ended
i32.const 2
i32.eq
br_if $done
br $record
end
local.get $width
i32.const 0
i32.lt_s
if
local.get $count
local.set $width
else
local.get $count
local.get $width
i32.lt_s
if
;; a short row, padded with empty fields: room for them and for the rest of the text
local.get $o
local.get $width
local.get $count
i32.sub
i32.const 3
i32.mul
i32.add
global.get $winEnd
local.get $p
i32.sub
i32.const 3
i32.mul
i32.add
global.get $outEnd
i32.gt_u
if
${abort(NEED_ROOM)}
end
local.get $count
local.set $n
loop $pad
local.get $o
i32.const 0x22222C
i32.store
${inc('$o', 3)}
${inc('$n', 1)}
local.get $n
local.get $width
i32.lt_s
br_if $pad
end
${pushError(CODE_SHORT, 'local.get $count', 'i32.const 0')}
else
local.get $count
local.get $width
i32.gt_s
if
;; a long row: the cut fields leave the row for the error's extra
local.get $o
local.get $extraAt
i32.sub
i32.const 1
i32.sub
local.set $n
local.get $x
local.get $n
i32.add
global.get $xEnd
i32.gt_u
if
i32.const ${DECLINE}
return
end
local.get $x
local.get $extraAt
i32.const 1
i32.add
local.get $n
memory.copy
${pushError(CODE_LONG, 'local.get $x', 'local.get $x\nlocal.get $n\ni32.add')}
${addLocal('$x', '$n')}
local.get $extraAt
local.set $o
end
end
end
local.get $o
i32.const 93
i32.store8
${inc('$o', 1)}
local.get $records
i32.eqz
if
local.get $o
local.set $gap
${inc('$o', 9)}
end
${inc('$records', 1)}
local.get $ended
i32.const 2
i32.eq
br_if $done
br $record
end
end
;; past the closing quote
${inc('$p', 1)}
${SAVE}
i32.const ${OK}
`;

// Writes the bytes of s at $o, four at a time (the last store may write up to three bytes past them, which the next
// write covers), and moves $o past them.
const storeBytes = (s) => {
  const b = Buffer.from(s, 'latin1');
  let out = '';
  for (let k = 0; k < b.length; k += 4) {
    const v = b[k] | ((b[k + 1] ?? 0) << 8) | ((b[k + 2] ?? 0) << 16) | ((b[k + 3] ?? 0) << 24);
    out += `local.get $o
i32.const ${v | 0}
i32.store offset=${k}
`;
  }
  return out + inc('$o', b.length);
};

// writeInt(o, v): v (an integer >= 0) in decimal at o; its end.
const WRITE_INT = `
local.get $v
local.set $t
loop $count
${inc('$n', 1)}
local.get $t
i32.const 10
i32.div_u
local.tee $t
br_if $count
end
local.get $o
local.get $n
i32.add
local.tee $o
local.set $i
loop $digit
${inc('$i', -1)}
local.get $i
local.get $v
i32.const 10
i32.rem_u
i32.const 48
i32.add
i32.store8
local.get $v
i32.const 10
i32.div_u
local.tee $v
br_if $digit
end
local.get $o
`;

// writeErrors(o, e, end, header): the error records [e, end) as the answer's errors, each {code, line, row} with its
// fields or extra; header 1 tells the record index 0 as the row null and every other as one less. Its end.
const WRITE_ERRORS = `
block $done
loop $error
local.get $e
local.get $end
i32.ge_u
br_if $done
local.get $first
i32.eqz
if
local.get $o
i32.const 44
i32.store8
${inc('$o', 1)}
end
i32.const 0
local.set $first
local.get $e
i32.load
local.set $code
${['stray_cr', 'quote_junk', 'unterminated_quote', 'short_row', 'long_row']
  .map((name, k) => `local.get $code\ni32.const ${k}\ni32.eq\nif\n${storeBytes(`{"code":"${name}","line":`)}\nend`)
  .join('\n')}
local.get $o
local.get $e
i32.load offset=4
call $writeInt
local.set $o
local.get $e
i32.load offset=8
local.set $rec
local.get $header
local.get $rec
i32.eqz
i32.and
if
${storeBytes(',"row":null')}
else
${storeBytes(',"row":')}
local.get $o
local.get $rec
local.get $header
i32.sub
call $writeInt
local.set $o
end
local.get $code
i32.const ${CODE_SHORT}
i32.eq
if
${storeBytes(',"fields":')}
local.get $o
local.get $e
i32.load offset=12
call $writeInt
local.set $o
end
local.get $code
i32.const ${CODE_LONG}
i32.eq
if
${storeBytes(',"extra":[')}
local.get $e
i32.load offset=16
local.get $e
i32.load offset=12
i32.sub
local.set $n
local.get $o
local.get $e
i32.load offset=12
local.get $n
memory.copy
${addLocal('$o', '$n')}
local.get $o
i32.const 93
i32.store8
${inc('$o', 1)}
end
local.get $o
i32.const 125
i32.store8
${inc('$o', 1)}
${inc('$e', 20)}
br $error
end
end
local.get $o
`;

/** The module's bytes. */
export function readerBytes() {
  const i32 = (...names) => names.map((n) => [n, 'i32']);
  return assemble({
    memory: ['env', 'mem'],
    globals: [
      '$winEnd', '$outEnd', '$errEnd', '$xEnd', '$rP', '$rO', '$rE', '$rX',
      '$sStart', '$sLine', '$sWidth', '$sRecords', '$sGap',
    ],
    funcs: [
      {
        name: '$readText',
        export: true,
        params: i32('$p', '$o', '$e', '$x'),
        results: ['i32'],
        locals: [
          ...i32(
            '$line', '$width', '$records', '$recLine', '$rowStart', '$count', '$extraAt', '$quoted', '$fieldStart',
            '$ended', '$junk', '$keptFrom', '$open', '$openLine', '$c', '$d', '$m', '$n', '$gap', '$recP', '$recE', '$recX',
          ),
          ...['$v', '$sBS', '$sDQ', '$sCM'].map((n) => [n, 'v128']),
        ],
        body: READ_TEXT,
      },
      {
        name: '$writeErrors',
        export: true,
        params: i32('$o', '$e', '$end', '$header'),
        results: ['i32'],
        locals: i32('$first', '$code', '$rec', '$n'),
        body: `i32.const 1\nlocal.set $first\n${WRITE_ERRORS}`,
      },
      {
        name: '$writeInt',
        params: i32('$o', '$v'),
        results: ['i32'],
        locals: i32('$t', '$n', '$i'),
        body: WRITE_INT,
      },
    ],
  });
}
