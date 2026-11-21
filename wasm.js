// A small assembler for the WebAssembly the byte path runs: a flat subset of the text format (one instruction a line,
// no folded expressions), with named locals, globals, functions and block labels, to a module's bytes. It knows the
// instructions reader.js uses and nothing more; anything else is an error naming the line.
//
//   assemble({ memory: ['env', 'mem'], globals: ['$a', ...], funcs: [{ name, params, results, locals, body, export }] })
//
// params and locals are [name, type] pairs (type i32 or v128); every global is a mutable i32 starting at 0 and
// exported under its name without the $. A body line is `mnemonic immediates...`, `;;` starts a comment, and a
// block, loop or if may carry a label ($name) that br and br_if take in place of a depth.

const TYPES = { i32: 0x7f, v128: 0x7b };

// mnemonic: [opcode bytes, immediate kind]
const OPS = {
  unreachable: [[0x00]],
  nop: [[0x01]],
  block: [[0x02], 'block'],
  loop: [[0x03], 'block'],
  if: [[0x04], 'block'],
  else: [[0x05]],
  end: [[0x0b]],
  br: [[0x0c], 'label'],
  br_if: [[0x0d], 'label'],
  return: [[0x0f]],
  call: [[0x10], 'func'],
  drop: [[0x1a]],
  select: [[0x1b]],
  'local.get': [[0x20], 'local'],
  'local.set': [[0x21], 'local'],
  'local.tee': [[0x22], 'local'],
  'global.get': [[0x23], 'global'],
  'global.set': [[0x24], 'global'],
  'i32.load': [[0x28], 'mem'],
  'i32.load8_u': [[0x2d], 'mem'],
  'i32.load16_u': [[0x2f], 'mem'],
  'i32.store': [[0x36], 'mem'],
  'i32.store8': [[0x3a], 'mem'],
  'i32.store16': [[0x3b], 'mem'],
  'i32.const': [[0x41], 'i32'],
  'i32.eqz': [[0x45]],
  'i32.eq': [[0x46]],
  'i32.ne': [[0x47]],
  'i32.lt_s': [[0x48]],
  'i32.lt_u': [[0x49]],
  'i32.gt_s': [[0x4a]],
  'i32.gt_u': [[0x4b]],
  'i32.le_s': [[0x4c]],
  'i32.le_u': [[0x4d]],
  'i32.ge_s': [[0x4e]],
  'i32.ge_u': [[0x4f]],
  'i32.ctz': [[0x68]],
  'i32.add': [[0x6a]],
  'i32.sub': [[0x6b]],
  'i32.mul': [[0x6c]],
  'i32.and': [[0x71]],
  'i32.or': [[0x72]],
  'i32.shl': [[0x74]],
  'i32.shr_u': [[0x76]],
  'memory.copy': [[0xfc, 0x0a, 0x00, 0x00]],
  'v128.load': [[0xfd, 0x00], 'mem'],
  'v128.store': [[0xfd, 0x0b], 'mem'],
  'i8x16.splat': [[0xfd, 0x0f]],
  'i8x16.eq': [[0xfd, 0x23]],
  'v128.or': [[0xfd, 0x50]],
  'i8x16.bitmask': [[0xfd, 0x64]],
};

function uleb(n, out) {
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
}

function sleb(n, out) {
  for (;;) {
    const byte = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (byte & 0x40) === 0) || (n === -1 && (byte & 0x40) !== 0)) {
      out.push(byte);
      return;
    }
    out.push(byte | 0x80);
  }
}

function name(s, out) {
  const b = Buffer.from(s, 'utf8');
  uleb(b.length, out);
  out.push(...b);
}

function section(id, body, out) {
  out.push(id);
  uleb(body.length, out);
  out.push(...body);
}

function vec(items, out) {
  uleb(items.length, out);
  for (const it of items) out.push(...it);
}

function compileBody(fn, globals, funcs) {
  const locals = new Map();
  fn.params.forEach(([n], i) => locals.set(n, i));
  fn.locals.forEach(([n], i) => locals.set(n, fn.params.length + i));
  const code = [];
  const labels = []; // the open blocks' labels, innermost last
  fn.body.split('\n').forEach((raw, lineNo) => {
    const text = raw.replace(/;;.*$/, '').trim();
    if (text === '') return;
    const fail = (why) => {
      throw new Error(`${fn.name} line ${lineNo + 1} "${text}": ${why}`);
    };
    const [op, ...args] = text.split(/\s+/);
    const spec = OPS[op];
    if (!spec) fail('unknown instruction');
    code.push(...spec[0]);
    const kind = spec[1];
    if (op === 'end') {
      if (labels.length === 0) fail('end with no open block');
      labels.pop();
    }
    if (kind === undefined) return;
    if (kind === 'block') {
      labels.push(args[0] && args[0].startsWith('$') ? args[0] : null);
      code.push(0x40); // no result
    } else if (kind === 'label') {
      const i = labels.lastIndexOf(args[0]);
      if (i < 0) fail('no such label');
      uleb(labels.length - 1 - i, code);
    } else if (kind === 'local') {
      if (!locals.has(args[0])) fail('no such local');
      uleb(locals.get(args[0]), code);
    } else if (kind === 'global') {
      const i = globals.indexOf(args[0]);
      if (i < 0) fail('no such global');
      uleb(i, code);
    } else if (kind === 'func') {
      const i = funcs.findIndex((f) => f.name === args[0]);
      if (i < 0) fail('no such function');
      uleb(i, code);
    } else if (kind === 'i32') {
      const v = Number(args[0]);
      if (!Number.isInteger(v)) fail('not an integer');
      sleb(v | 0, code);
    } else if (kind === 'mem') {
      let offset = 0;
      for (const a of args) {
        const m = /^offset=(\d+)$/.exec(a);
        if (!m) fail('bad memory immediate');
        offset = Number(m[1]);
      }
      code.push(0); // alignment hint: 1 byte (any address works)
      uleb(offset, code);
    }
  });
  if (labels.length !== 0) throw new Error(`${fn.name}: a block is never closed`);
  code.push(0x0b);
  // Locals, one group per entry.
  const head = [];
  uleb(fn.locals.length, head);
  for (const [, t] of fn.locals) {
    head.push(1, TYPES[t]);
  }
  const body = [...head, ...code];
  const out = [];
  uleb(body.length, out);
  out.push(...body);
  return out;
}

/** The module's bytes. */
export function assemble({ memory, globals, funcs }) {
  const out = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  // Types: one per function.
  const types = [];
  vec(
    funcs.map((f) => {
      const t = [0x60];
      vec(f.params.map(([, ty]) => [TYPES[ty]]), t);
      vec(f.results.map((ty) => [TYPES[ty]]), t);
      return t;
    }),
    types,
  );
  section(1, types, out);
  // The one import: the memory, at least a page, no maximum.
  const imp = [];
  name(memory[0], imp);
  name(memory[1], imp);
  imp.push(0x02, 0x00, 0x01);
  const imports = [];
  vec([imp], imports);
  section(2, imports, out);
  const fsec = [];
  vec(
    funcs.map((_, i) => {
      const a = [];
      uleb(i, a);
      return a;
    }),
    fsec,
  );
  section(3, fsec, out);
  // Globals: mutable i32s starting at 0.
  const gsec = [];
  vec(globals.map(() => [TYPES.i32, 0x01, 0x41, 0x00, 0x0b]), gsec);
  section(6, gsec, out);
  const exps = [];
  funcs.forEach((f, i) => {
    if (!f.export) return;
    const e = [];
    name(f.name.replace(/^\$/, ''), e);
    e.push(0x00);
    uleb(i, e);
    exps.push(e);
  });
  globals.forEach((g, i) => {
    const e = [];
    name(g.replace(/^\$/, ''), e);
    e.push(0x03);
    uleb(i, e);
    exps.push(e);
  });
  const esec = [];
  vec(exps, esec);
  section(7, esec, out);
  const csec = [];
  vec(funcs.map((f) => compileBody(f, globals, funcs)), csec);
  section(10, csec, out);
  return Uint8Array.from(out);
}
