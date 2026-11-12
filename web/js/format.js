// Đọc file .aoeweb (mapcap/webexport.py) và giữ trạng thái phát lại: unit, tầm nhìn, vật thể tĩnh.
// Phần nén zlib mở bằng DecompressionStream("deflate") có sẵn trong trình duyệt.

export const F_DOP = 1, F_BLD = 2, F_FOGVIS = 4, F_HIDE = 8, F_DOPOK = 16;
const MAGIC = "AOEWEB01";

export async function inflate(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// Đọc tuần tự một Uint8Array (mọi số little-endian, căn chỉnh tuỳ ý nên chép ra mảng mới khi cần)
class Reader {
  constructor(u8) { this.u8 = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.p = 0; }
  u8_() { return this.u8[this.p++]; }
  u32() { const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  i32() { const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  arr(Type, n) {
    const bytes = n * Type.BYTES_PER_ELEMENT;
    const off = this.u8.byteOffset + this.p;
    let a;
    if (off % Type.BYTES_PER_ELEMENT === 0) a = new Type(this.u8.buffer, off, n);
    else a = new Type(this.u8.slice(this.p, this.p + bytes).buffer);
    this.p += bytes;
    return a;
  }
  rows() {
    const n = this.u32();
    return { n, uid: this.arr(Int32Array, n), key: this.arr(Uint32Array, n), x: this.arr(Float32Array, n),
             y: this.arr(Float32Array, n), z: this.arr(Float32Array, n), owner: this.arr(Uint8Array, n),
             flags: this.arr(Uint8Array, n) };
  }
}

export class Match {
  static async open(buf) {
    const u8 = new Uint8Array(buf);
    const magic = new TextDecoder().decode(u8.subarray(0, 8));
    if (magic !== MAGIC) throw new Error("không phải file .aoeweb");
    const n = new DataView(buf).getUint32(8, true);
    const meta = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + n)));
    if (meta.version > 2) throw new Error("file của bản mới hơn, hãy cập nhật app");   // 2: có dữ liệu HUD (hud.js)
    const m = new Match(u8, 12 + n, meta);
    await m._init();
    return m;
  }

  constructor(u8, base, meta) {
    this.u8 = u8; this.base = base; this.meta = meta;
    this.chunkCache = new Map();          // chỉ số khối -> Promise<khối đã giải mã>
  }

  section(name) {
    const [o, l] = this.meta.sections[name];
    return this.u8.subarray(this.base + o, this.base + o + l);
  }

  async _init() {
    const M = this.meta;
    const n = M.frames;
    const tb = await inflate(this.section("times"));
    const r = new Reader(tb);
    this.t = r.arr(Int32Array, n);
    this.r = r.arr(Float32Array, n);
    // bảng khoá hình -> mảnh sprite
    const kr = new Reader(await inflate(this.section("keys")));
    const nk = kr.u32(), np = kr.u32();
    this.kStart = kr.arr(Uint32Array, nk);
    this.kCount = kr.arr(Uint16Array, nk);
    this.pSlp = kr.arr(Int32Array, np);
    this.pFrame = kr.arr(Uint16Array, np);
    this.pColor = kr.arr(Uint8Array, np);
    this.pMirror = kr.arr(Uint8Array, np);
    this.pDx = kr.arr(Int16Array, np);
    this.pDy = kr.arr(Int16Array, np);
    // công trình mỗi đội đã thấy: uid -> mẫu đầu tiên thấy
    const sr = new Reader(await inflate(this.section("seen")));
    this.seen = M.teams.map(() => {
      const c = sr.u32();
      const uid = sr.arr(Int32Array, c), fr = sr.arr(Int32Array, c);
      const m = new Map();
      for (let i = 0; i < c; i++) m.set(uid[i], fr[i]);
      return m;
    });
    // vật thể tĩnh: bản đầu toàn bộ, sau đó phần đổi
    const st = new Reader(await inflate(this.section("statics")));
    const ns = st.u32();
    this.srecs = [];
    for (let i = 0; i < ns; i++) {
      const first = st.i32(); const full = st.u8_();
      const rows = st.rows();
      const nr = st.u32();
      this.srecs.push({ first, full, rows, removed: st.arr(Int32Array, nr) });
    }
    const ir = await inflate(this.section("index"));
    this.index = new Uint16Array(ir.buffer, ir.byteOffset, ir.byteLength / 2);
  }

  get frames() { return this.meta.frames; }
  get duration() { return this.r[this.frames - 1]; }

  frameAtR(rr) {        // mẫu cuối cùng có r <= rr
    let lo = 0, hi = this.frames - 1;
    if (rr <= this.r[0]) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.r[mid] <= rr) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  chunk(ci) {
    let p = this.chunkCache.get(ci);
    if (!p) {
      p = inflate(this.section("c" + ci)).then(b => this._parseChunk(b));
      this.chunkCache.set(ci, p);
      if (this.chunkCache.size > 4) {          // giữ 4 khối gần nhất
        const k = this.chunkCache.keys().next().value;
        if (k !== ci) this.chunkCache.delete(k);
      }
    }
    return p;
  }

  _parseChunk(b) {
    const r = new Reader(b);
    const nf = r.u32();
    const frames = [];
    for (let k = 0; k < nf; k++) {
      const full = r.u8_();
      const rows = r.rows();
      const nr = r.u32();
      const removed = r.arr(Int32Array, nr);
      const nv = r.u32();
      let vis = null, visIdx = null, visVal = null;
      if (full) vis = r.arr(Uint32Array, nv);
      else { visIdx = r.arr(Uint32Array, nv); visVal = r.arr(Uint32Array, nv); }
      frames.push({ full, rows, removed, vis, visIdx, visVal });
    }
    return frames;
  }
}

// Trạng thái tại một mẫu. Unit giữ trong mảng cột có chỗ trống + Map uid -> hàng.
export class State {
  constructor(match) {
    this.m = match;
    this.frame = -1;
    this.vis = new Uint32Array(match.meta.map_w * match.meta.map_h);
    this._alloc(4096);
    this.version = 0;
    this.sIdx = -1;               // bản ghi tĩnh đã áp tới
    this.statics = new Map();     // uid -> [key, x, y, z, owner, flags]
    this.sVersion = 0;
  }

  _alloc(cap) {
    const old = this.cap ? this : null;
    this.cap = cap;
    const mk = (T, a) => { const n = new T(cap); if (a) n.set(a); return n; };
    this.uid = mk(Int32Array, old && this.uid); this.key = mk(Uint32Array, old && this.key);
    this.x = mk(Float32Array, old && this.x); this.y = mk(Float32Array, old && this.y);
    this.z = mk(Float32Array, old && this.z); this.owner = mk(Uint8Array, old && this.owner);
    this.flags = mk(Uint8Array, old && this.flags); this.valid = mk(Uint8Array, old && this.valid);
    if (!old) { this.pos = new Map(); this.free = []; for (let i = cap - 1; i >= 0; i--) this.free.push(i); }
  }

  _grow() {
    const cap = this.cap;
    this._alloc(cap * 2);
    for (let i = cap * 2 - 1; i >= cap; i--) this.free.push(i);
  }

  _reset() {
    this.valid.fill(0);
    this.pos.clear();
    this.free = [];
    for (let i = this.cap - 1; i >= 0; i--) this.free.push(i);
  }

  _applyRows(R) {
    for (let k = 0; k < R.n; k++) {
      const u = R.uid[k];
      let i = this.pos.get(u);
      if (i === undefined) {
        if (!this.free.length) this._grow();
        i = this.free.pop();
        this.pos.set(u, i);
        this.valid[i] = 1;
        this.uid[i] = u;
      }
      this.key[i] = R.key[k]; this.x[i] = R.x[k]; this.y[i] = R.y[k]; this.z[i] = R.z[k];
      this.owner[i] = R.owner[k]; this.flags[i] = R.flags[k];
    }
  }

  _applyFrame(f) {
    if (f.full) this._reset();
    for (let k = 0; k < f.removed.length; k++) {
      const i = this.pos.get(f.removed[k]);
      if (i !== undefined) { this.pos.delete(f.removed[k]); this.valid[i] = 0; this.free.push(i); }
    }
    this._applyRows(f.rows);
    if (f.vis) this.vis.set(f.vis);
    else for (let k = 0; k < f.visIdx.length; k++) this.vis[f.visIdx[k]] = f.visVal[k];
  }

  // Tua tới mẫu fi (cần khối đã giải mã). Trả về true nếu trạng thái đổi.
  async seek(fi) {
    const m = this.m;
    fi = Math.max(0, Math.min(m.frames - 1, fi | 0));
    if (fi === this.frame) return false;
    const C = m.meta.chunk;
    const ci = Math.floor(fi / C);
    const chunk = await m.chunk(ci);
    if (fi + 1 < m.frames && (fi % C) > C * 0.6) m.chunk(ci + 1);     // đọc trước khối sau
    let start;
    if (this.frame >= ci * C && this.frame < fi) start = this.frame + 1;
    else start = ci * C;
    for (let f = start; f <= fi; f++) this._applyFrame(chunk[f - ci * C]);
    this.frame = fi;
    this._statics(fi);
    this.version++;
    return true;
  }

  _statics(fi) {
    const recs = this.m.srecs;
    let j = this.sIdx;
    while (j + 1 < recs.length && recs[j + 1].first <= fi) j++;
    while (j >= 0 && recs[j].first > fi) j--;
    if (j === this.sIdx) return;
    let from = this.sIdx + 1;
    if (j < this.sIdx) { this.statics.clear(); from = 0; }
    for (let k = from; k <= j; k++) {
      const s = recs[k];
      if (s.full) this.statics.clear();
      for (let q = 0; q < s.removed.length; q++) this.statics.delete(s.removed[q]);
      const R = s.rows;
      for (let q = 0; q < R.n; q++) this.statics.set(R.uid[q], [R.key[q], R.x[q], R.y[q], R.z[q], R.owner[q], R.flags[q]]);
    }
    this.sIdx = j;
    this.sVersion++;
  }
}
