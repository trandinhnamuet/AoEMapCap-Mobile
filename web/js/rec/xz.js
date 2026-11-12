// Giải nén .xz (LZMA2) cho khối 'B' của file ghi trận (Python lzma.compress(preset=1): một luồng xz, kiểm tra CRC64).
// Trình duyệt không có sẵn LZMA. Viết theo đặc tả LZMA (LzmaSpec.cpp của 7-Zip) và định dạng xz / LZMA2
// (xz-file-format.txt); không kiểm CRC (dữ liệu còn qua pickle + kiểm cấu trúc ở build.js). Cỡ ra tối đa MAX_OUT.

const MAX_OUT = 512 << 20;                 // như mapcap/safeload.MAX_RAW: chặn "bom giải nén"

class Out {
  constructor(hint) { this.b = new Uint8Array(Math.max(1 << 16, hint || 0)); this.n = 0; }
  need(k) {
    if (this.n + k <= this.b.length) return;
    let cap = this.b.length * 2;
    while (cap < this.n + k) cap *= 2;
    if (cap > MAX_OUT && this.n + k > MAX_OUT) throw new Error("xz: dữ liệu giải nén quá lớn");
    const nb = new Uint8Array(Math.min(cap, Math.max(MAX_OUT, this.n + k)));
    nb.set(this.b.subarray(0, this.n));
    this.b = nb;
  }
}

class LzmaDec {
  constructor() { this.dictStart = 0; this.lc = this.lp = this.pb = -1; }

  setProps(p) {
    if (p > 224) throw new Error("xz: thuộc tính LZMA sai");
    this.lc = p % 9; p = (p / 9) | 0;
    this.lp = p % 5; this.pb = (p / 5) | 0;
    if (this.lc + this.lp > 4) throw new Error("xz: lc + lp > 4");
    this.lit = new Uint16Array(0x300 << (this.lc + this.lp));
  }

  resetState() {
    const P = 1024;
    this.lit.fill(P);
    this.isMatch = new Uint16Array(192).fill(P); this.isRep = new Uint16Array(12).fill(P);
    this.isRepG0 = new Uint16Array(12).fill(P); this.isRepG1 = new Uint16Array(12).fill(P);
    this.isRepG2 = new Uint16Array(12).fill(P); this.isRep0Long = new Uint16Array(192).fill(P);
    this.posSlot = new Uint16Array(4 << 6).fill(P); this.posDec = new Uint16Array(115).fill(P);
    this.align = new Uint16Array(16).fill(P);
    this.len = new Uint16Array(2 + 16 * 8 + 16 * 8 + 256).fill(P);
    this.repLen = new Uint16Array(2 + 16 * 8 + 16 * 8 + 256).fill(P);
    this.state = 0; this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
  }

  // ---- bộ giải mã khoảng (range coder) trên in[p..end) ----
  rcInit(inb, p, end) {
    if (inb[p] !== 0) throw new Error("xz: dữ liệu LZMA hỏng");
    this.in = inb; this.ip = p + 5; this.iend = end;
    this.range = 0xFFFFFFFF;
    this.code = ((inb[p + 1] << 24) | (inb[p + 2] << 16) | (inb[p + 3] << 8) | inb[p + 4]) >>> 0;
  }
  bit(probs, i) {
    const pr = probs[i];
    const bound = (this.range >>> 11) * pr;
    let b;
    if (this.code < bound) { this.range = bound; probs[i] = pr + ((2048 - pr) >>> 5); b = 0; }
    else { this.range -= bound; this.code -= bound; probs[i] = pr - (pr >>> 5); b = 1; }
    if (this.range < 0x1000000) {
      this.range = (this.range * 256) >>> 0;
      this.code = ((this.code * 256) + this.in[this.ip++]) >>> 0;
    }
    return b;
  }
  direct(n) {
    let res = 0;
    for (; n > 0; n--) {
      this.range >>>= 1;
      let b = 0;
      if (this.code >= this.range) { this.code -= this.range; b = 1; }
      res = ((res << 1) | b) >>> 0;
      if (this.range < 0x1000000) {
        this.range = (this.range * 256) >>> 0;
        this.code = ((this.code * 256) + this.in[this.ip++]) >>> 0;
      }
    }
    return res;
  }
  tree(probs, off, nbits) {
    let m = 1;
    for (let i = 0; i < nbits; i++) m = (m << 1) + this.bit(probs, off + m);
    return m - (1 << nbits);
  }
  rtree(probs, off, nbits) {
    let m = 1, sym = 0;
    for (let i = 0; i < nbits; i++) { const b = this.bit(probs, off + m); m = (m << 1) + b; sym |= b << i; }
    return sym;
  }
  lenDec(P, posState) {
    if (!this.bit(P, 0)) return this.tree(P, 2 + posState * 8, 3);
    if (!this.bit(P, 1)) return 8 + this.tree(P, 2 + 128 + posState * 8, 3);
    return 16 + this.tree(P, 2 + 256, 8);
  }

  // giải mã đúng `size` byte vào out (từ điển = phần ra từ dictStart)
  decode(out, size) {
    out.need(size);
    const b = out.b, end = out.n + size, pbMask = (1 << this.pb) - 1, lpMask = (1 << this.lp) - 1, lc = this.lc;
    let pos = out.n, state = this.state, rep0 = this.rep0, rep1 = this.rep1, rep2 = this.rep2, rep3 = this.rep3;
    const ds = this.dictStart;
    while (pos < end) {
      const posState = (pos - ds) & pbMask;
      const s2 = (state << 4) + posState;
      if (!this.bit(this.isMatch, s2)) {
        const prev = pos > ds ? b[pos - 1] : 0;
        const off = 0x300 * ((((pos - ds) & lpMask) << lc) + (prev >> (8 - lc)));
        let sym = 1;
        if (state >= 7) {
          if (pos - rep0 - 1 < ds) throw new Error("xz: khoảng cách sai");
          let mb = b[pos - rep0 - 1];
          do {
            const mbit = (mb >> 7) & 1;
            mb <<= 1;
            const bit = this.bit(this.lit, off + ((1 + mbit) << 8) + sym);
            sym = (sym << 1) | bit;
            if (mbit !== bit) break;
          } while (sym < 0x100);
        }
        while (sym < 0x100) sym = (sym << 1) | this.bit(this.lit, off + sym);
        b[pos++] = sym - 0x100;
        state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }
      let len;
      if (this.bit(this.isRep, state)) {
        if (pos === ds) throw new Error("xz: dữ liệu LZMA hỏng");
        if (!this.bit(this.isRepG0, state)) {
          if (!this.bit(this.isRep0Long, s2)) {
            state = state < 7 ? 9 : 11;
            b[pos] = b[pos - rep0 - 1]; pos++;
            continue;
          }
        } else {
          let dist;
          if (!this.bit(this.isRepG1, state)) dist = rep1;
          else {
            if (!this.bit(this.isRepG2, state)) dist = rep2;
            else { dist = rep3; rep3 = rep2; }
            rep2 = rep1;
          }
          rep1 = rep0; rep0 = dist;
        }
        len = this.lenDec(this.repLen, posState);
        state = state < 7 ? 8 : 11;
      } else {
        rep3 = rep2; rep2 = rep1; rep1 = rep0;
        len = this.lenDec(this.len, posState);
        state = state < 7 ? 7 : 10;
        const ls = len < 3 ? len : 3;
        const slot = this.tree(this.posSlot, ls << 6, 6);
        if (slot < 4) rep0 = slot;
        else {
          const nd = (slot >> 1) - 1;
          let dist = ((2 | (slot & 1)) << nd) >>> 0;
          if (slot < 14) dist += this.rtree(this.posDec, dist - slot, nd);
          else dist = (dist + ((this.direct(nd - 4) << 4) >>> 0) + this.rtree(this.align, 0, 4)) >>> 0;
          rep0 = dist;
        }
        if (rep0 === 0xFFFFFFFF) throw new Error("xz: gặp dấu kết thúc giữa khúc LZMA2");
      }
      len += 2;
      if (pos - rep0 - 1 < ds) throw new Error("xz: khoảng cách sai");
      if (pos + len > end) throw new Error("xz: khúc LZMA2 dài quá");
      let src = pos - rep0 - 1;
      for (let k = 0; k < len; k++) b[pos++] = b[src++];
    }
    out.n = pos;
    this.state = state; this.rep0 = rep0; this.rep1 = rep1; this.rep2 = rep2; this.rep3 = rep3;
  }
}

function varint(u8, p) {
  let v = 0, mul = 1;
  for (let i = 0; i < 9; i++) {
    const c = u8[p.i++];
    v += (c & 0x7F) * mul;
    if (!(c & 0x80)) return v;
    mul *= 128;
  }
  throw new Error("xz: số sai");
}

// LZMA2 trong in[p..end) -> ghi vào out; trả về vị trí sau byte kết thúc (0x00)
function lzma2(inb, p, end, out, dec) {
  let needDict = true, needProps = true;
  for (;;) {
    if (p >= end) throw new Error("xz: thiếu dữ liệu LZMA2");
    const c = inb[p++];
    if (c === 0) return p;
    if (c === 1 || c === 2) {                                   // khúc không nén
      if (c === 1) { dec.dictStart = out.n; needDict = false; } else if (needDict) throw new Error("xz: LZMA2 sai");
      const n = ((inb[p] << 8) | inb[p + 1]) + 1; p += 2;
      if (p + n > end) throw new Error("xz: thiếu dữ liệu LZMA2");
      out.need(n); out.b.set(inb.subarray(p, p + n), out.n); out.n += n; p += n;
      continue;
    }
    if (c < 0x80) throw new Error("xz: điều khiển LZMA2 sai");
    const usize = ((c & 0x1F) << 16) + (inb[p] << 8) + inb[p + 1] + 1;
    const psize = (inb[p + 2] << 8) + inb[p + 3] + 1;
    p += 4;
    const reset = (c >> 5) & 3;
    if (reset === 3) { dec.dictStart = out.n; needDict = false; } else if (needDict) throw new Error("xz: LZMA2 sai");
    if (reset >= 2) { dec.setProps(inb[p++]); needProps = false; } else if (needProps) throw new Error("xz: LZMA2 sai");
    if (reset >= 1) dec.resetState();
    if (p + psize > end) throw new Error("xz: thiếu dữ liệu LZMA2");
    dec.rcInit(inb, p, p + psize);
    dec.decode(out, usize);
    p += psize;
  }
}

// Uint8Array .xz -> Uint8Array dữ liệu gốc
export function unxz(u8) {
  const M = [0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00];
  for (let i = 0; i < 6; i++) if (u8[i] !== M[i]) throw new Error("xz: không phải dữ liệu xz");
  const CS = { 0: 0, 1: 4, 4: 8, 10: 32 }[u8[7] & 0x0F];   // cỡ trường kiểm tra: không, CRC32, CRC64, SHA-256
  if (CS === undefined) throw new Error("xz: kiểu kiểm tra lạ");
  const out = new Out(u8.length * 4);
  const dec = new LzmaDec();
  let p = 12;
  for (;;) {
    const hs = u8[p];
    if (hs === 0) break;                                       // chỉ mục: hết khối
    const hsize = (hs + 1) * 4;
    const q = { i: p + 1 };
    const flags = u8[q.i++];
    if ((flags & 3) !== 0) throw new Error("xz: chỉ hỗ trợ một bộ lọc (LZMA2)");
    if (flags & 0x40) varint(u8, q);                           // cỡ nén
    if (flags & 0x80) varint(u8, q);                           // cỡ gốc
    if (varint(u8, q) !== 0x21) throw new Error("xz: chỉ hỗ trợ LZMA2");
    if (varint(u8, q) !== 1) throw new Error("xz: thuộc tính LZMA2 sai");
    q.i++;                                                     // cỡ từ điển: giải nén cả khối vào bộ nhớ, không cần
    const start = p + hsize;
    let e = lzma2(u8, start, u8.length, out, dec);
    while ((e - start) % 4) e++;                               // đệm khối
    p = e + CS;
    if (p > u8.length) throw new Error("xz: thiếu dữ liệu");
  }
  return out.b.subarray(0, out.n);
}
