// readText, the WebAssembly that reads a case's text for the byte path (fast.js), as source: the build
// (node tools/build-wasm.mjs) assembles it with wasm.js into reader.wasm, which fast.js loads; tools/check-bytes.mjs
// checks that reader.wasm is this source assembled.
//
// readText(p, o, e, x) reads the JSON string at p (its opening quote) as CSV text and writes its records at o, as
// fast.js says, the error records (code, line, record index, a, b: five i32s each) at e and the long rows' cut fields
// at x. It answers OK, with the ends in the globals rP, rO, rE, rX, the record count in rRecords and the room after
// the first record in rGap; or DECLINE, for an escape \u or when the room set aside (the globals len, outEnd, errEnd,
// xEnd) runs out.

import { assemble } from './wasm.js';

export const OK = 0;
export const DECLINE = 4;
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
;; past the opening quote, and past a U+FEFF at the very start
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
i32.const 1
local.set $line
i32.const -1
local.set $width
i32.const 0
local.set $records
i32.const -1
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
;; the end of the text
local.get $p
i32.load8_u
i32.const 34
i32.eq
br_if $done
local.get $line
local.set $recLine
local.get $o
local.set $rowStart
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
br_if $unterm
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
global.get $len
local.get $p
i32.sub
i32.const 3
i32.mul
i32.add
global.get $outEnd
i32.gt_u
if
i32.const ${DECLINE}
return
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
local.get $p
global.set $rP
local.get $o
global.set $rO
local.get $e
global.set $rE
local.get $x
global.set $rX
local.get $records
global.set $rRecords
local.get $gap
global.set $rGap
i32.const ${OK}
`;

/** The module's bytes. */
export function readerBytes() {
  return assemble({
  memory: ['env', 'mem'],
  globals: ['$len', '$outEnd', '$errEnd', '$xEnd', '$rP', '$rO', '$rE', '$rX', '$rRecords', '$rGap'],
  funcs: [
    {
      name: '$readText',
      export: true,
      params: [
        ['$p', 'i32'],
        ['$o', 'i32'],
        ['$e', 'i32'],
        ['$x', 'i32'],
      ],
      results: ['i32'],
      locals: [
        ...[
          '$line', '$width', '$records', '$recLine', '$rowStart', '$count', '$extraAt', '$quoted', '$fieldStart',
          '$ended', '$junk', '$keptFrom', '$open', '$openLine', '$c', '$d', '$m', '$n', '$gap',
        ].map((n) => [n, 'i32']),
        ...['$v', '$sBS', '$sDQ', '$sCM'].map((n) => [n, 'v128']),
      ],
      body: READ_TEXT,
    },
  ],
  });
}
