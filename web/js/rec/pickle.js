// Đọc pickle (giao thức 2-5) của file ghi trận, như mapcap/safeload.py: chỉ dựng dữ liệu, không bao giờ chạy mã;
// "lớp" duy nhất được nhận là mảng numpy (numpy.core.multiarray._reconstruct / ndarray / dtype / scalar), gặp tên khác
// thì báo lỗi, không mở file.
// Kết quả: dict -> Map (giữ thứ tự khoá và khoá số như Python), list / tuple -> Array, bytes -> Uint8Array,
// set / frozenset -> Set, int lớn -> Number (trong file ghi không có số vượt 2^53), mảng numpy -> NdArray.

const ALLOWED = new Set(["numpy.core.multiarray _reconstruct", "numpy._core.multiarray _reconstruct",
  "numpy.core.multiarray scalar", "numpy._core.multiarray scalar", "numpy ndarray", "numpy dtype",
  "builtins set", "builtins frozenset", "collections OrderedDict"]);

export class DType {
  constructor(str) { this.str = str; this.order = "|"; this.names = null; this.fields = null; this.itemsize = 0; }
  // state: (ver, order, subarray, names, fields, elsize, alignment, flags)
  setState(st) {
    this.order = st[1];
    if (st[3]) {
      this.names = st[3];
      this.fields = new Map();
      for (const [k, v] of st[4]) this.fields.set(k, [v[0], v[1]]);
    }
    if (typeof st[5] === "number" && st[5] > 0) this.itemsize = st[5];
    if (!this.itemsize) this.itemsize = itemsizeOf(this.str);
  }
  get kind() { return this.str[0]; }
}

function itemsizeOf(s) {
  const m = /^[a-zA-Z?](\d+)$/.exec(s);
  if (m) return +m[1];
  if (s === "?" || s === "b1") return 1;
  throw new Error("pickle: kiểu numpy lạ " + s);
}

export class NdArray {
  constructor() { this.shape = [0]; this.dtype = null; this.raw = null; }
  get size() { return this.shape.reduce((a, b) => a * b, 1); }
}

const TYPED = { i1: Int8Array, u1: Uint8Array, b1: Uint8Array, i2: Int16Array, u2: Uint16Array, i4: Int32Array,
  u4: Uint32Array, f4: Float32Array, f8: Float64Array, i8: BigInt64Array, u8: BigUint64Array };

// mảng numpy kiểu đơn -> mảng JS (Int32Array...; int64 -> Float64Array giá trị số)
export function typedOf(a) {
  const dt = a.dtype;
  if (dt.names) throw new Error("pickle: mảng có cấu trúc");
  if (dt.order === ">") throw new Error("pickle: mảng big-endian");
  const key = dt.str === "?" ? "b1" : dt.str;
  const T = TYPED[key];
  if (!T) throw new Error("pickle: kiểu numpy lạ " + dt.str);
  const n = a.size;
  const r = a.raw;
  let out;
  if (r.byteOffset % T.BYTES_PER_ELEMENT === 0) out = new T(r.buffer, r.byteOffset, n);
  else out = new T(r.slice(0, n * T.BYTES_PER_ELEMENT).buffer);
  if (T === BigInt64Array || T === BigUint64Array) out = Float64Array.from(out, Number);
  return out;
}

function scalarOf(dt, bytes) {
  const b = bytes.slice(0, dt.itemsize);
  const T = TYPED[dt.str === "?" ? "b1" : dt.str];
  if (!T) throw new Error("pickle: kiểu numpy lạ " + dt.str);
  const v = new T(b.buffer)[0];
  return typeof v === "bigint" ? Number(v) : v;
}

const MARK = Symbol("mark");
const td = new TextDecoder();

export function loads(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 0;
  const stack = [];
  const memo = [];
  let marks = [];
  const popMark = () => {
    const k = marks.pop();
    if (k === undefined) throw new Error("pickle: thiếu MARK");
    return stack.splice(k);
  };
  const str = n => { const s = td.decode(u8.subarray(p, p + n)); p += n; return s; };
  const bytes = n => { const b = u8.slice(p, p + n); p += n; return b; };
  const setItems = (d, items) => {
    for (let i = 0; i < items.length; i += 2) d.set(items[i], items[i + 1]);
  };
  for (;;) {
    if (p >= u8.length) throw new Error("pickle: hết dữ liệu");
    const op = u8[p++];
    switch (op) {
      case 0x80: p++; break;                                         // PROTO
      case 0x95: p += 8; break;                                      // FRAME
      case 0x2e: return stack.pop();                                 // STOP
      case 0x28: marks.push(stack.length); break;                    // MARK
      case 0x30: stack.pop(); break;                                 // POP
      case 0x31: popMark(); break;                                   // POP_MARK
      case 0x32: stack.push(stack[stack.length - 1]); break;         // DUP
      case 0x4e: stack.push(null); break;                            // NONE
      case 0x88: stack.push(true); break;                            // NEWTRUE
      case 0x89: stack.push(false); break;                           // NEWFALSE
      case 0x4a: stack.push(dv.getInt32(p, true)); p += 4; break;    // BININT
      case 0x4b: stack.push(u8[p++]); break;                         // BININT1
      case 0x4d: stack.push(dv.getUint16(p, true)); p += 2; break;   // BININT2
      case 0x8a: case 0x8b: {                                        // LONG1 / LONG4
        const n = op === 0x8a ? u8[p++] : dv.getInt32((p += 4) - 4, true);
        let v = 0n;
        for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(u8[p + i]);
        if (n && (u8[p + n - 1] & 0x80)) v -= 1n << BigInt(8 * n);
        p += n;
        stack.push(Number(v));
        break;
      }
      case 0x47: stack.push(dv.getFloat64(p, false)); p += 8; break; // BINFLOAT (big-endian)
      case 0x8c: { const n = u8[p++]; stack.push(str(n)); break; }   // SHORT_BINUNICODE
      case 0x58: { const n = dv.getUint32(p, true); p += 4; stack.push(str(n)); break; }   // BINUNICODE
      case 0x8d: { const n = Number(dv.getBigUint64(p, true)); p += 8; stack.push(str(n)); break; }
      case 0x43: { const n = u8[p++]; stack.push(bytes(n)); break; } // SHORT_BINBYTES
      case 0x42: { const n = dv.getUint32(p, true); p += 4; stack.push(bytes(n)); break; }  // BINBYTES
      case 0x8e: { const n = Number(dv.getBigUint64(p, true)); p += 8; stack.push(bytes(n)); break; }
      case 0x55: { const n = u8[p++]; stack.push(str(n)); break; }   // SHORT_BINSTRING (str2)
      case 0x5d: stack.push([]); break;                              // EMPTY_LIST
      case 0x7d: stack.push(new Map()); break;                       // EMPTY_DICT
      case 0x29: stack.push([]); break;                              // EMPTY_TUPLE
      case 0x8f: stack.push(new Set()); break;                       // EMPTY_SET
      case 0x61: { const v = stack.pop(); stack[stack.length - 1].push(v); break; }        // APPEND
      case 0x65: { const items = popMark(); stack[stack.length - 1].push(...items); break; } // APPENDS
      case 0x73: { const v = stack.pop(), k = stack.pop(); stack[stack.length - 1].set(k, v); break; }  // SETITEM
      case 0x75: { const items = popMark(); setItems(stack[stack.length - 1], items); break; }          // SETITEMS
      case 0x90: { const items = popMark(); const s = stack[stack.length - 1]; for (const x of items) s.add(x); break; }
      case 0x91: stack.push(new Set(popMark())); break;              // FROZENSET
      case 0x74: stack.push(popMark()); break;                       // TUPLE
      case 0x85: stack.push([stack.pop()]); break;                   // TUPLE1
      case 0x86: { const b = stack.pop(), a = stack.pop(); stack.push([a, b]); break; }
      case 0x87: { const c = stack.pop(), b = stack.pop(), a = stack.pop(); stack.push([a, b, c]); break; }
      case 0x6c: stack.push(popMark()); break;                       // LIST
      case 0x64: { const items = popMark(); const d = new Map(); setItems(d, items); stack.push(d); break; }  // DICT
      case 0x94: memo.push(stack[stack.length - 1]); break;          // MEMOIZE
      case 0x71: memo[u8[p++]] = stack[stack.length - 1]; break;     // BINPUT
      case 0x72: memo[dv.getUint32(p, true)] = stack[stack.length - 1]; p += 4; break;      // LONG_BINPUT
      case 0x68: stack.push(memo[u8[p++]]); break;                   // BINGET
      case 0x6a: stack.push(memo[dv.getUint32(p, true)]); p += 4; break;                    // LONG_BINGET
      case 0x93: {                                                   // STACK_GLOBAL
        const name = stack.pop(), mod = stack.pop();
        const full = mod + " " + name;
        if (!ALLOWED.has(full)) throw new Error(`file ghi trận chứa kiểu dữ liệu không cho phép (${mod}.${name}): không mở`);
        stack.push({ global: full });
        break;
      }
      case 0x63: {                                                   // GLOBAL "mod\nname\n"
        let e = u8.indexOf(10, p); const mod = td.decode(u8.subarray(p, e)); p = e + 1;
        e = u8.indexOf(10, p); const name = td.decode(u8.subarray(p, e)); p = e + 1;
        const full = mod + " " + name;
        if (!ALLOWED.has(full)) throw new Error(`file ghi trận chứa kiểu dữ liệu không cho phép (${mod}.${name}): không mở`);
        stack.push({ global: full });
        break;
      }
      case 0x52: {                                                   // REDUCE
        const args = stack.pop(), f = stack.pop();
        stack.push(reduce(f, args));
        break;
      }
      case 0x81: {                                                   // NEWOBJ
        const args = stack.pop(), cls = stack.pop();
        stack.push(reduce(cls, args));
        break;
      }
      case 0x62: {                                                   // BUILD
        const st = stack.pop();
        const obj = stack[stack.length - 1];
        build(obj, st);
        break;
      }
      default:
        throw new Error("pickle: lệnh không hỗ trợ 0x" + op.toString(16));
    }
  }
}

function reduce(f, args) {
  const g = f && f.global;
  if (!g) throw new Error("pickle: REDUCE lạ");
  if (g.endsWith("_reconstruct")) return new NdArray();
  if (g === "numpy dtype") return new DType(args[0]);
  if (g.endsWith("scalar")) return scalarOf(args[0], args[1]);
  if (g === "builtins set" || g === "builtins frozenset") return new Set(args[0] || []);
  if (g === "collections OrderedDict") { const m = new Map(); for (const [k, v] of args[0] || []) m.set(k, v); return m; }
  throw new Error("pickle: hàm lạ " + g);
}

function build(obj, st) {
  if (obj instanceof DType) { obj.setState(st); return; }
  if (obj instanceof NdArray) {                                     // (ver, shape, dtype, fortran, raw)
    obj.shape = st[1];
    obj.dtype = st[2];
    if (st[3]) throw new Error("pickle: mảng Fortran");
    if (!(st[4] instanceof Uint8Array)) throw new Error("pickle: mảng object không hỗ trợ");
    obj.raw = st[4];
    if (obj.raw.length < obj.size * obj.dtype.itemsize) throw new Error("pickle: mảng thiếu dữ liệu");
    return;
  }
  throw new Error("pickle: BUILD lạ");
}
