// Bộ chuyển file ghi trận (.aoerec) sang dữ liệu trình xem (.aoeweb) chạy trên điện thoại: bản JavaScript của
// mapcap/webexport.py WebBuilder (cùng thứ tự xử lý, cùng phép tính, cùng kết quả từng byte trừ ảnh JPEG địa hình;
// tests/test_mobile_rec.py so hai bên). Máy tính chỉ gửi file ghi + gói dữ liệu game (export_gamedata) + gói hình.
//
// Dùng: const b = new RecBuilder(sprites, gamedata, {info, encodeJpeg}); for (const rec of records(u8)) b.feed(rec);
// rồi b.finish(). Trong lúc chạy: b.chunks (khối mẫu đã xong, chưa nén), b.keys, b.srecs... để trình xem phát dần.
import { unzlibSync } from "../vendor/fflate.js";
import { unxz } from "./xz.js";
import { loads, typedOf } from "./pickle.js";
import { ELEV_H, RGB, TILE_H, TILE_W, buildIndex, buildTerrain, decodeRGBA, pyRoundInt } from "./terrain.js";

export const WEB_VERSION = 3;        // 3: cột người chơi 6 = unit đã chết (mọi nguyên nhân), 7 = unit phù được (trước: phá nhà)
export const CHUNK = 250;
const FOG_DIM = 0.43;
const TERRAIN_BUDGET = 12e6;
const TILE = 2048;
const INDEX_SCALE_DIV = 2;
const F_DOP = 1, F_BLD = 2, F_FOGVIS = 4, F_HIDE = 8, F_DOPOK = 16;
const SEEN_EVERY = 5, PAUSE_GAP = 1.0, MAX_STEP = 0.5;
const HSTEP = 25;
const ICON_SLPS = [50729, 50730, 50704, 50705, 50706, 50707, 50731];
const DEAD_TYPES = new Set([10, 20, 30, 90]);
const AGE_TECHS = [[101, 2], [102, 3], [103, 4]];
const A = { AGE: 6, FOOD: 0, WOOD: 1, STONE: 2, GOLD: 3, POP_ROOM: 4, POP: 11, KILLS: 20, RAZINGS: 43, KILL_RATIO: 44,
  GOLD_COLLECTED: 49, TRIBUTE_GIVEN: 53 };
const MAX_RAW = 512 << 20;

// ---- số học như Python / numpy ------------------------------------------------------------------------------
const F32 = new Float32Array(1), I32 = new Int32Array(F32.buffer);
const fround = Math.fround;
function f32bits(v) { F32[0] = v; return I32[0]; }
// numpy rint: nửa về số chẵn
function rint(v) {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 ? 2 * Math.round(v / 2) : r;
}
const npRound1 = v => rint(v * 10.0) / 10.0;              // np.round(x, 1)
// Python round(x, nd) đúng từng bit (làm tròn giá trị thập phân chính xác, nửa về số chẵn)
export function pyRound(x, nd) {
  if (!Number.isFinite(x) || x === 0) return x;
  const neg = x < 0;
  const s = Math.abs(x).toFixed(Math.min(100, nd + 40));
  const dot = s.indexOf(".");
  const keep = s.slice(0, dot + 1 + nd), rest = s.slice(dot + 1 + nd);
  let up;
  if (rest[0] > "5") up = true;
  else if (rest[0] < "5") up = false;
  else if (/[1-9]/.test(rest.slice(1))) up = true;
  else { const last = keep.replace(".", "").slice(-1); up = (+last) % 2 === 1; }
  let digits = keep.replace(".", "");
  if (up) {
    const arr = digits.split("").map(Number);
    let i = arr.length - 1;
    while (i >= 0) { if (arr[i] === 9) { arr[i] = 0; i--; } else { arr[i]++; break; } }
    if (i < 0) arr.unshift(1);
    digits = arr.join("");
  }
  const ip = digits.length - nd;
  const str = nd ? digits.slice(0, ip) + "." + digits.slice(ip) : digits;
  const v = parseFloat(str);
  return neg ? -v : v;
}
// webhud._num: None / NaN / Infinity -> null; số nguyên (kể cả float nguyên) -> số nguyên; còn lại round(v, 2)
function num(v) {
  if (v === null || v === undefined) return null;
  v = Number(v);
  if (!Number.isFinite(v)) return null;
  return Number.isInteger(v) ? v : pyRound(v, 2);
}
// webhud._clean: dict / list / float -> JSON được (NaN -> null)
function clean(o) {
  if (o instanceof Map) { const r = {}; for (const [k, v] of o) r[k] = clean(v); return r; }
  if (Array.isArray(o)) return o.map(clean);
  if (typeof o === "number") return Number.isInteger(o) ? o : num(o);
  return o;
}
// json.dumps(sort_keys=True) để so trùng
function canon(o) {
  if (Array.isArray(o)) return "[" + o.map(canon).join(",") + "]";
  if (o && typeof o === "object") return "{" + Object.keys(o).sort().map(k => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}";
  return JSON.stringify(o);
}
function sortKeys(o) {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === "object") { const r = {}; for (const k of Object.keys(o).sort()) r[k] = sortKeys(o[k]); return r; }
  return o;
}
const cmpArr = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };
const pyBool = v => !!v && !(v instanceof Map && v.size === 0) && !(Array.isArray(v) && v.length === 0);

// ---- zlib ---------------------------------------------------------------------------------------------------
function zraw(u8, out) {
  const r = unzlibSync(u8, out ? { out } : undefined);
  if (r.length > MAX_RAW) throw new Error("dữ liệu giải nén vượt giới hạn");
  return r;
}

// ---- bản ghi của file ---------------------------------------------------------------------------------------
const REC_MAGIC = "AOEREC01";
// sinh {tag, p (payload), pos (tỉ lệ file đã đọc)} theo thứ tự; khối 'B' mở ra tại chỗ; dừng êm ở bản ghi cụt / hỏng
export function* records(u8) {
  if (new TextDecoder().decode(u8.subarray(0, 8)) !== REC_MAGIC) throw new Error("không phải file .aoerec");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let pos = 8;
  const size = u8.length;
  while (pos + 5 <= size) {
    const tag = String.fromCharCode(u8[pos]);
    const n = dv.getUint32(pos + 1, true);
    if (pos + 5 + n > size) return;
    const raw = u8.subarray(pos + 5, pos + 5 + n);
    pos += 5 + n;
    let inner;
    try {
      if (tag === "B") inner = loads(unxz(raw)).map(([t, p]) => [String.fromCharCode(t[0]), p]);
      else if ("HDSQUF".includes(tag)) inner = [[tag, loads(zraw(raw))]];
      else continue;
    } catch (e) {
      if (/không cho phép/.test(e.message)) throw e;
      return;
    }
    for (const [t, p] of inner) yield { tag: t, p, pos: pos / size };
  }
}

// ---- mảng unit (UNIT_DT của mapcap/rawrec.py) theo cột -----------------------------------------------------
const UF = [["uid", Int32Array], ["def", Int32Array], ["owner", Int16Array], ["angle", Uint8Array], ["status", Uint8Array],
  ["flags", Uint8Array], ["kind", Uint8Array], ["x", Float32Array], ["y", Float32Array], ["z", Float32Array],
  ["hp", Float32Array], ["gid", Int16Array], ["frame", Int16Array], ["gid2", Int16Array], ["frame2", Int16Array],
  ["rtype", Int16Array], ["ramount", Float32Array]];
const MINUS1 = new Set(["gid", "frame", "gid2", "frame2", "rtype"]);
function ualloc(n) { const U = { n }; for (const [f, T] of UF) U[f] = new T(n); return U; }
function utake(U, idx) {                       // U[idx]
  const R = ualloc(idx.length);
  for (const [f] of UF) { const s = U[f], d = R[f]; for (let i = 0; i < idx.length; i++) d[i] = s[idx[i]]; }
  return R;
}
function ucopyRow(D, i, S, j) { for (const [f] of UF) D[f][i] = S[f][j]; }
const READ = { i1: "getInt8", u1: "getUint8", b1: "getUint8", i2: "getInt16", u2: "getUint16", i4: "getInt32",
  u4: "getUint32", f4: "getFloat32", f8: "getFloat64" };
// replay/data.normalize_units: mảng có cấu trúc của file (có thể là định dạng cũ) -> UNIT_DT
export function normUnits(a) {
  if (a === null || a === undefined) return ualloc(0);
  const dt = a.dtype, n = a.size;
  const U = ualloc(n);
  if (!n) return U;
  const dv = new DataView(a.raw.buffer, a.raw.byteOffset, a.raw.byteLength);
  const isz = dt.itemsize;
  for (const [f] of UF) {
    const fd = dt.fields && dt.fields.get(f);
    const col = U[f];
    if (!fd) { if (MINUS1.has(f)) col.fill(-1); continue; }
    const [fdt, off] = fd;
    const code = fdt.str === "?" ? "b1" : fdt.str;
    if (!READ[code]) throw new Error("kiểu trường lạ " + fdt.str);
    let o = off;
    switch (code) {
      case "i4": for (let i = 0; i < n; i++, o += isz) col[i] = dv.getInt32(o, true); break;
      case "u4": for (let i = 0; i < n; i++, o += isz) col[i] = dv.getUint32(o, true); break;
      case "i2": for (let i = 0; i < n; i++, o += isz) col[i] = dv.getInt16(o, true); break;
      case "u2": for (let i = 0; i < n; i++, o += isz) col[i] = dv.getUint16(o, true); break;
      case "i1": for (let i = 0; i < n; i++, o += isz) col[i] = dv.getInt8(o); break;
      case "u1": case "b1": for (let i = 0; i < n; i++, o += isz) col[i] = dv.getUint8(o); break;
      case "f4": for (let i = 0; i < n; i++, o += isz) col[i] = dv.getFloat32(o, true); break;
      case "f8": for (let i = 0; i < n; i++, o += isz) col[i] = dv.getFloat64(o, true); break;
    }
  }
  return U;
}
function ints(a) { return a === null || a === undefined ? null : typedOf(a); }

// replay/data._apply_static_delta
function applyStaticDelta(arr, ch, removed) {
  const drop = new Set(ch.uid);
  if (removed && removed.length) for (const u of removed) drop.add(u);
  const keep = [];
  for (let i = 0; i < arr.n; i++) if (!drop.size || !drop.has(arr.uid[i])) keep.push(i);
  const A1 = utake(arr, keep);
  if (!ch.n) return { arr: A1, keep };
  const R = ualloc(A1.n + ch.n);
  for (const [f] of UF) { R[f].set(A1[f], 0); R[f].set(ch[f], A1.n); }
  return { arr: R, keep };
}

// ---- trạng thái tại một mẫu (replay/data.FrameState) -------------------------------------------------------
class FrameState {
  constructor(w, h) {
    this.w = w; this.h = h;
    this._reset(ualloc(0));
    this.vis = null;
    this.pstate = new Map(); this.tech_times = new Map(); this.pstat = new Map(); this.prod = new Map();
    this.go = 0; this.prs = new Map(); this.pav = new Map(); this.ptr = new Map();
    this.frame = -1; this.t = 0; this.at = 0;
    this.delta = false;                    // mẫu vừa áp là XOR: chIdx[0..nChanged) = các ô đổi
    // đếm từ dữ liệu unit như replay/data.FrameState._count_losses: lost = unit (loại 70) của người chơi chuyển sang
    // chết (status >= 3 hoặc máu <= 0, mọi nguyên nhân); conv = unit đang sống đổi chủ sang người chơi này (phù được)
    this.lost = new Map(); this.conv = new Map();
  }
  _reset(units) {
    const n = units.n;
    let cap = 1;
    while (cap < Math.max(n, 1) * 2) cap *= 2;
    cap = Math.max(1024, cap);
    this.arr = ualloc(cap);
    for (const [f] of UF) this.arr[f].set(units[f], 0);
    this.valid = new Uint8Array(cap);
    this.valid.fill(1, 0, n);
    this.pos = new Map();
    for (let i = 0; i < n; i++) this.pos.set(units.uid[i], i);
    this.free = [];
    for (let i = cap - 1; i >= n; i--) this.free.push(i);
  }
  _grow() {
    const cap = this.arr.n;
    const A2 = ualloc(cap * 2);
    for (const [f] of UF) A2[f].set(this.arr[f], 0);
    const v = new Uint8Array(cap * 2); v.set(this.valid, 0);
    this.arr = A2; this.valid = v;
    for (let i = cap * 2 - 1; i >= cap; i--) this.free.push(i);
  }
  apply(p, frame) {
    const nv = this.h * this.w;
    if (!this.visBuf) this.visBuf = new Uint8Array(nv * 4);
    const rawU8 = zraw(p.get("vis"), this.visBuf);
    if (rawU8.length !== nv * 4) throw new Error("tầm nhìn sai cỡ");
    const raw = new Uint32Array(rawU8.buffer, rawU8.byteOffset, nv);
    if (p.get("full_vis") || this.vis === null) { this.vis = raw.slice(); this.delta = false; }
    else {                                  // áp XOR và ghi luôn các ô đổi (= ô có V khác mẫu trước)
      const V = this.vis;
      if (!this.chIdx) this.chIdx = new Uint32Array(nv);
      const ix = this.chIdx;
      let c = 0;
      for (let i = 0; i < nv; i++) { const r = raw[i]; if (r !== 0) { V[i] ^= r; ix[c++] = i; } }
      this.nChanged = c; this.delta = true;
    }
    const ch = normUnits(p.get("units"));
    if (p.get("full_units")) this._reset(ch);
    else {
      const rem = ints(p.get("removed"));
      if (rem && rem.length) for (const uid of rem) {
        const i = this.pos.get(uid);
        if (i !== undefined) { this.pos.delete(uid); this.valid[i] = 0; this.free.push(i); }
      }
      // như Python: xác định hàng của mọi unit trước, so bản CŨ (chưa ghi đè) với bản mới để đếm, rồi mới ghi
      const at = new Int32Array(ch.n), oldK = [];
      for (let k = 0; k < ch.n; k++) {
        const uid = ch.uid[k];
        let i = this.pos.get(uid);
        if (i === undefined) {
          if (!this.free.length) this._grow();
          i = this.free.pop();
          this.pos.set(uid, i);
          this.valid[i] = 1;
        } else oldK.push(k);
        at[k] = i;
      }
      const A = this.arr;
      for (const k of oldK) {
        const i = at[k];
        if (A.kind[i] !== 70 || A.owner[i] <= 0) continue;
        const deadO = A.status[i] >= 3 || A.hp[i] <= 0;
        const deadU = ch.status[k] >= 3 || ch.hp[k] <= 0;
        if (deadU && !deadO) this.lost.set(A.owner[i], (this.lost.get(A.owner[i]) || 0) + 1);
        if (ch.owner[k] !== A.owner[i] && ch.owner[k] > 0 && !deadO && !deadU)
          this.conv.set(ch.owner[k], (this.conv.get(ch.owner[k]) || 0) + 1);
      }
      for (let k = 0; k < ch.n; k++) ucopyRow(A, at[k], ch, k);
    }
    const t = p.get("t");
    const ps = p.get("pstate");
    if (ps) for (const [idx, v] of ps) {
      const [attrs, techs] = v;
      this.pstate.set(idx, [attrs, techs === null ? null : techs]);
      if (techs !== null) {
        let tt = this.tech_times.get(idx);
        if (!tt) { tt = new Map(); this.tech_times.set(idx, tt); }
        for (const tid of techs) if (!tt.has(tid)) tt.set(tid, t);
      }
    }
    if (p.has("pstat")) for (const [k, v] of p.get("pstat")) this.pstat.set(k, v);
    if (p.has("go")) this.go = p.get("go");
    if (p.has("prs")) for (const [k, v] of p.get("prs")) this.prs.set(k, v);
    const pav = p.get("pav");
    if (pav) for (const [k, v] of pav) this.pav.set(k, [...new Set(v)]);
    const ptr = p.get("ptr");
    if (ptr) for (const [k, v] of ptr) {
      const seen = new Set(), arr = [];
      for (const x of v) { const key = x.join(","); if (!seen.has(key)) { seen.add(key); arr.push(x); } }
      this.ptr.set(k, arr);
    }
    const prod = p.get("prod");
    if (prod) for (const [uid, v] of prod) {
      if (v === null) this.prod.delete(uid);
      else this.prod.set(uid, v);
    }
    this.frame = frame; this.t = t; this.at = p.get("at");
  }
  units() {
    const idx = [];
    for (let i = 0; i < this.arr.n; i++) if (this.valid[i]) idx.push(i);
    return utake(this.arr, idx);
  }
}

// ---- trận đọc tuần tự (mapcap/webexport._Stream + replay/data.ReplayData) ----------------------------------
function realPlayerRows(hdr) {
  const civs = hdr.get("civs") || [];
  const out = [];
  for (const p of hdr.get("players") || []) {
    const [idx, addr, pid, name, , , vis] = p;
    if (idx === 0 || !(addr || pid)) continue;
    out.push([idx, name, idx < civs.length ? civs[idx] : -1, vis]);
  }
  return out;
}
// replay/library.teams_from_header
export function teamsFromHeader(hdr) {
  const rows = realPlayerRows(hdr);
  const match = hdr.get("match") || new Map();
  const st = match instanceof Map ? match.get("teams") : null;
  const maxIdx = rows.reduce((m, r) => Math.max(m, r[0]), 0);
  if (st && st.length && st.length >= maxIdx) {
    const groups = new Map();
    for (const [idx] of rows) {
      const t = st[idx - 1];
      const key = t > 0 ? "t" + t : "p" + idx;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(idx);
    }
    return [...groups.values()].sort((a, b) => a[0] - b[0]);
  }
  const parent = new Map(rows.map(r => [r[0], r[0]]));
  const find = a => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  for (const a of rows) for (const b of rows) {
    if (a[0] < b[0] && (BigInt(a[3]) & BigInt(b[3]))) parent.set(find(b[0]), find(a[0]));
  }
  const groups = new Map();
  for (const r of rows) { const k = find(r[0]); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r[0]); }
  return [...groups.values()].sort((a, b) => a[0] - b[0]);
}

class Stream {
  constructor(hdr) {
    this.header = hdr;
    this.map_w = hdr.get("map_w") | 0; this.map_h = hdr.get("map_h") | 0;
    this.defs = new Map(); this._defVer = 0; this._defCache = null;
    this.f_t = []; this.f_at = []; this.f_r = [];
    this.s_first = [];
    this.stats = new Map();
    this.final_tech_times = new Map();
    const civs = hdr.get("civs") || [];
    this.players = (hdr.get("players") || []).map((p, i) => ({ index: p[0], addr: p[1], pid: p[2], name: p[3],
      mm_color: p[4], explored_mask: p[5], visible_mask: p[6], ptype: p[7], civ: i < civs.length ? civs[i] : -1 }));
    this.teams = teamsFromHeader(hdr);
    this.seen = this.teams.map(() => new Map());
    this.teamVm = this.teams.map(t => {
      let vm = 0;
      for (const i of t) if (i >= 0 && i < this.players.length) vm = (vm | this.players[i].visible_mask) >>> 0;
      return vm;
    });
  }
  get n_frames() { return this.f_t.length; }
  applyDefs(lst) {
    for (const rec of lst) {
      const [i, addr, utype, name, dat_id, cls, fogvis, mm_mode, mm_color] = rec;
      const hp_max = rec.length > 9 ? rec[9] : 0;
      this.defs.set(i, { addr, utype, name, dat_id, cls, fogvis: !!fogvis, mm_mode, mm_color, hp_max });
    }
    this._defVer++;
  }
  defArrays() {
    if (this._defCache && this._defCache.ver === this._defVer) return this._defCache;
    let n = 1;
    if (this.defs.size) { n = 0; for (const k of this.defs.keys()) n = Math.max(n, k); n += 1; }
    const D = { ver: this._defVer, n, utype: new Int16Array(n).fill(-1), fogvis: new Uint8Array(n),
      dat_id: new Int32Array(n).fill(-1), cls: new Int16Array(n).fill(-1), hp_max: new Float32Array(n) };
    for (const [i, d] of this.defs) {
      D.utype[i] = d.utype; D.fogvis[i] = d.fogvis ? 1 : 0; D.dat_id[i] = d.dat_id; D.cls[i] = d.cls;
      D.hp_max[i] = d.hp_max || 0;
    }
    this._defCache = D;
    return D;
  }
  markSeen(st, fi) {
    if (st.vis === null || !this.teamVm.some(v => v)) return;
    const D = this.defArrays(), n = D.n, A1 = st.arr, w = this.map_w, h = this.map_h;
    for (let i = 0; i < A1.n; i++) {
      if (!st.valid[i]) continue;
      const d = A1.def[i];
      const ut = d >= 0 && d < n ? D.utype[Math.min(Math.max(d, 0), n - 1)] : -1;
      if (ut !== 80 || !(A1.owner[i] > 0) || A1.kind[i] === 25) continue;
      const tx = Math.min(Math.max(Math.floor(A1.x[i]), 0), w - 1), ty = Math.min(Math.max(Math.floor(A1.y[i]), 0), h - 1);
      const bits = st.vis[ty * w + tx];
      this.teamVm.forEach((vm, k) => {
        if ((bits & vm) !== 0) { const s = this.seen[k]; if (!s.has(A1.uid[i])) s.set(A1.uid[i], fi); }
      });
    }
  }
  frameAtGameMs(t) {
    const n = this.n_frames;
    if (!n) return 0;
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.f_t[m] < t) lo = m + 1; else hi = m; }
    return Math.max(0, Math.min(n - 1, lo));
  }
  ageEvents() {
    const out = [];
    for (const [idx, tt] of this.final_tech_times) for (const [tid, age] of AGE_TECHS) {
      const t = tt.get(tid);
      if (t !== undefined && t !== null && t > 0) out.push([this.f_r[this.frameAtGameMs(t)], idx, age]);
    }
    return out.sort(cmpArr);
  }
  recorderIndex() { const v = this.header.get("cur_player_index"); return v === undefined ? -1 : v | 0; }
}

// ---- dữ liệu game (gói AOEGD001 của mapcap/webexport.export_gamedata) --------------------------------------
export class GameData {
  constructor(buf) {
    const u8 = new Uint8Array(buf);
    if (new TextDecoder().decode(u8.subarray(0, 8)) !== "AOEGD001") throw new Error("gói dữ liệu game hỏng");
    const n = new DataView(u8.buffer, u8.byteOffset).getUint32(8, true);
    const J = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + n)));
    this.version = J.version;
    this.colours = J.colours;
    this.graphics = new Map();
    for (const [k, g] of Object.entries(J.graphics)) {
      this.graphics.set(+k, { slp: g[0], fc: g[1], ac: g[2], mirror: g[3], deltas: g[4] });
    }
    this.maxGid = Math.max(0, ...this.graphics.keys());
    this.units = new Map();
    for (const [k, u] of Object.entries(J.units)) {
      this.units.set(+k, { type: u[0], standing: u[1], dying: u[2], icon: u[3], lang: u[4], name: u[5] });
    }
    this.terrains = J.terrains.map(t => ({ id: t[0], slp: t[1], toDraw: t[2], repl: t[3], dims: t[4], elev: t[5] }));
    this.borders = J.borders;
    this.research = J.research.map(r => ({ id: r[0], name: r[1], lang: r[2], time: r[3], location: r[4], icon: r[5],
      button: r[6], costs: r[7], researchable: r[4] >= 0 && r[3] > 0 && r[2] !== 0 }));
    this.strings = J.strings;
    this.civs = J.civs;
    this.icons = {};
    const base = 12 + n;
    for (const [sid, [o, l]] of Object.entries(J.icons)) this.icons[sid] = u8.slice(base + o, base + o + l);
  }
  str(sid) {
    if (!sid || !(sid > 0)) return null;
    const v = this.strings[String(Math.trunc(sid))];
    return v || null;
  }
  civName(c) {
    if (c === null || c === undefined || !(c >= 0)) return "?";
    return this.civs[String(Math.trunc(c))] || "#" + c;
  }
}

// ---- thế giới: hình học, màu quân, khoá hình (replay/world.World + SpriteResolver) -------------------------
// khoá hình: các trường đã cắt như _pack (giá trị + 1 trong [0, 2^bit - 1]); hai unit cùng khoá thì cùng hình
const clipF = (v, bits) => Math.min(Math.max(v + 1, 0), (1 << bits) - 1);

class World {
  constructor(hdr, gd, pack) {
    this.hdr = hdr; this.gd = gd; this.pack = pack;
    this.map_w = hdr.get("map_w") | 0; this.map_h = hdr.get("map_h") | 0;
    const elev = typedOf(hdr.get("elevation"));
    this.elev = elev;
    let emax = 0;
    for (let i = 0; i < elev.length; i++) if (elev[i] > emax) emax = elev[i];
    if (!elev.length) emax = 0;
    const full_w = (this.map_w + this.map_h) * (TILE_W / 2);
    const pad_top = ELEV_H * (emax + 2) + 8;
    const full_h = (this.map_w + this.map_h) * (TILE_H / 2) + pad_top + 40;
    this.full_w = Math.floor(pyRoundInt(full_w) / 2) * 2;
    this.full_h = Math.floor(pyRoundInt(full_h) / 2) * 2;
    this.pad_top = pad_top;
    this.Y0 = (this.map_w - 1) * (TILE_H / 2) + pad_top;
    const cmap = new Map();
    for (const [id, mm] of gd.colours) cmap.set(mm, id);
    const players = hdr.get("players") || [];
    this.color_lut = new Uint8Array(Math.max(players.length, 1) + 1);
    players.forEach((p, i) => {
      if (i > 0) { const cid = cmap.get(p[4]); this.color_lut[i] = cid !== undefined ? cid : (i - 1) % 8; }
    });
    const ng = gd.graphics.size ? gd.maxGid + 1 : 1;
    this.gtotal = new Int32Array(ng).fill(1);
    for (const [gid, g] of gd.graphics) this.gtotal[gid] = Math.max(g.fc, 1) * Math.max(g.ac, 1);
    // bảng 2D của header (h, w) -> mảng phẳng chỉ số y*w + x
    this.hdrArr = { terrain: typedOf(hdr.get("terrain")), shape: typedOf(hdr.get("shape")), elevation: elev,
      tile_dx: hdr.get("tile_dx") ? typedOf(hdr.get("tile_dx")) : null,
      tile_dy: hdr.get("tile_dy") ? typedOf(hdr.get("tile_dy")) : null,
      tile_border: hdr.get("tile_border") ? typedOf(hdr.get("tile_border")) : null };
    this._rgba = new Map();
    this.store = { frame: (slp, idx) => this._frame(slp, idx) };
  }
  // SpriteStore.frame(slp, idx) cho địa hình: RGBA màu 0, không lật; null nếu không có / rỗng
  _frame(slpId, idx) {
    const key = slpId * 65536 + idx;
    let r = this._rgba.get(key);
    if (r === undefined) {
      const s = this.pack.slp(slpId);
      r = null;
      if (s && idx >= 0 && idx < s.num) {
        const im = decodeRGBA(s, idx, this.pack.palette, 0);
        if (im.w * im.h > 0) r = im;
      }
      this._rgba.set(key, r);
    }
    return r;
  }
  playerRgb(owner) {
    const cid = owner > 0 && owner < this.color_lut.length ? this.color_lut[owner] : 0;
    return this.pack.palette[Math.min(16 * (cid + 1) + 4, 255)];
  }
  angleFrac(angle, g) {
    const ang = angle || 0;
    if (g.ac === 8) return ((ang + 6) % 8) / 8.0;
    const n = Math.max(g.ac, 1);
    return ang < n ? ang / n : 0.0;
  }
  _drawGraphic(cmds, g, X, Y, color, af, depth, frame, abs) {
    if (!g || depth > 3) return;
    if (g.deltas.length) {
      for (const [dg, ox, oy] of g.deltas) {
        if (dg === -1) this._drawMain(cmds, g, X + ox, Y + oy, color, af, frame, abs);
        else this._drawGraphic(cmds, this.gd.graphics.get(dg), X + ox, Y + oy, color, af, depth + 1, frame, abs);
      }
    } else this._drawMain(cmds, g, X, Y, color, af, frame, abs);
  }
  _drawMain(cmds, g, X, Y, color, af, frame, abs) {
    if (g.slp < 0) return;
    const s = this.pack.slp(g.slp);
    if (!s) return;
    const frames = Math.max(g.fc, 1), angles = Math.max(g.ac, 1);
    let mirror = false, fidx;
    if (abs >= 0) fidx = abs;
    else {
      let a = angles > 1 ? (Math.trunc(af * angles) % angles) : 0;
      if (g.mirror && angles > 1) {
        const half = Math.floor(angles / 2);
        if (a > half) { a = angles - a; mirror = true; }
      }
      const f = frame >= 0 && frame < frames ? frame : 0;
      fidx = a * frames + f;
    }
    if (fidx >= s.num) fidx = 0;
    cmds.push([g.slp, fidx, color, mirror, X, Y]);
  }
  // lệnh vẽ của khoá: [slp, khung, màu, lật, X, Y]
  keyCommands(ks) {
    const cmds = [];
    const v = ks.slice(1).split(",").map(x => +x - 1);         // giá trị đã cắt -> như World._unpack
    if (ks[0] === "g") {
      const [gid, frame, angle, gid2, frame2, color, stage] = v;
      const g = this.gd.graphics.get(gid);
      if (g) {
        this._drawGraphic(cmds, g, 0, 0, color, this.angleFrac(angle, g), 0, frame, stage);
        const g2 = gid2 >= 0 ? this.gd.graphics.get(gid2) : null;
        if (g2) this._drawGraphic(cmds, g2, 0, 0, color, this.angleFrac(angle, g2), 0, frame2, -1);
      }
    } else {
      const [dat, angle, color, dead] = v;
      const u = this.gd.units.get(dat);
      let g = null;
      if (u) {
        const gid = dead && u.dying >= 0 ? u.dying : u.standing;
        if (gid >= 0) g = this.gd.graphics.get(gid) || null;
      }
      if (g) this._drawGraphic(cmds, g, 0, 0, color, this.angleFrac(angle, g), 0, -1, -1);
    }
    return cmds;
  }
  // khoá hình của unit i (World.unit_keys): chuỗi "g..." (có đồ hoạ game) / "d..." gồm các trường đã cắt như _pack
  unitKey(U, i, D) {
    const n = D.n, d = U.def[i];
    const di = Math.min(Math.max(d, 0), n - 1);
    const utype = d < n ? D.utype[di] : -1;
    const dat = D.dat_id[di], hpMax = D.hp_max[di];
    const gid = U.gid[i];
    const hasG = gid >= 0;
    const owner = U.owner[i];
    let color = this.color_lut[Math.min(Math.max(owner, 0), this.color_lut.length - 1)];
    if (!(owner > 0 && owner < this.color_lut.length)) color = 0;
    if (hasG) {
      const total = this.gtotal[Math.min(Math.max(gid, 0), this.gtotal.length - 1)];
      let stage = -1;
      if (utype === 80 && U.status[i] === 0 && hpMax > 0) {
        let frac = fround(U.hp[i] / Math.max(hpMax, fround(1e-6)));
        frac = Math.min(Math.max(frac, 0.0), fround(0.999));
        stage = Math.min(Math.trunc(frac * total), total - 1);
      }
      return `g${clipF(gid, 12)},${clipF(U.frame[i], 10)},${clipF(U.angle[i], 4)},${clipF(U.gid2[i], 12)},` +
        `${clipF(U.frame2[i], 10)},${clipF(color, 4)},${clipF(stage, 10)}`;
    }
    const dead = DEAD_TYPES.has(utype) && (U.status[i] >= 3 || U.hp[i] <= 0) ? 1 : 0;
    return `d${clipF(dat, 12)},${clipF(U.angle[i], 4)},${clipF(color, 4)},${clipF(dead, 1)}`;
  }
}

// ---- khoá hình -> mảnh sprite (webexport._Keys) ----------------------------------------------------------
class Keys {
  constructor(world, pack) {
    this.w = world; this.pack = pack;
    this.ids = new Map();
    this.spans = [];                // [đầu, số mảnh]
    this.pieces = [];               // [slp, khung, màu, lật, dx, dy]
    this.hot = new Map();
  }
  _hotspot(slp, idx, mirror) {
    const key = slp * 131072 + idx * 2 + (mirror ? 1 : 0);
    let v = this.hot.get(key);
    if (v === undefined) {
      const s = this.pack.slp(slp);
      v = false;
      if (s && idx >= 0 && idx < s.num) {
        const f = s.info(idx);
        if (f.w > 0 && f.h > 0) v = [mirror ? f.w - 1 - f.hx : f.hx, f.hy];
      }
      this.hot.set(key, v);
    }
    return v;
  }
  idOf(k) {
    let i = this.ids.get(k);
    if (i === undefined) {
      i = this.spans.length;
      this.ids.set(k, i);
      const start = this.pieces.length;
      for (const [slp, idx, color, mirror, X, Y] of this.w.keyCommands(k)) {
        const hs = this._hotspot(slp, idx, mirror);
        if (hs) this.pieces.push([slp, idx, color, mirror ? 1 : 0, pyRoundInt(X - hs[0]), pyRoundInt(Y - hs[1])]);
      }
      this.spans.push([start, this.pieces.length - start]);
    }
    return i;
  }
  toBytes() {
    const nk = this.spans.length, np = this.pieces.length;
    const out = new Uint8Array(8 + nk * 6 + np * 12);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, nk, true); dv.setUint32(4, np, true);
    let o = 8;
    for (const [s] of this.spans) { dv.setUint32(o, s, true); o += 4; }
    for (const [, c] of this.spans) { dv.setUint16(o, c, true); o += 2; }
    for (const p of this.pieces) { dv.setInt32(o, p[0], true); o += 4; }
    for (const p of this.pieces) { dv.setUint16(o, p[1], true); o += 2; }
    for (const p of this.pieces) out[o++] = p[2];
    for (const p of this.pieces) out[o++] = p[3];
    for (const p of this.pieces) { dv.setInt16(o, p[4], true); o += 2; }
    for (const p of this.pieces) { dv.setInt16(o, p[5], true); o += 2; }
    return out;
  }
}

// ---- hàng ROW_DT (uid, khoá, x, y, z, chủ, cờ) -----------------------------------------------------------
function rowsAlloc(n) {
  return { n, uid: new Int32Array(n), key: new Uint32Array(n), x: new Float32Array(n), y: new Float32Array(n),
    z: new Float32Array(n), owner: new Uint8Array(n), flags: new Uint8Array(n) };
}
function rowsTake(R, idx) {
  const O = rowsAlloc(idx.length);
  for (const f of ["uid", "key", "x", "y", "z", "owner", "flags"]) for (let i = 0; i < idx.length; i++) O[f][i] = R[f][idx[i]];
  return O;
}
// so trùng hàng như r.tobytes(): số thực theo bit
function rowSig(R, i) {
  return R.key[i] + "," + f32bits(R.x[i]) + "," + f32bits(R.y[i]) + "," + f32bits(R.z[i]) + "," + R.owner[i] + "," + R.flags[i];
}
function rowsBytes(R) {
  const n = R.n;
  const out = new Uint8Array(n * 22);
  let o = 0;
  for (const f of ["uid", "key", "x", "y", "z", "owner", "flags"]) {
    const a = R[f];
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), o);
    o += a.byteLength;
  }
  return out;
}

// webexport._RowMaker
class RowMaker {
  constructor(d, world, keys) { this.d = d; this.w = world; this.keys = keys; this.dopAt = new Map(); this.dopDef = new Map(); }
  // reuse (vật thể tĩnh, bản ghi 'Q'): {prev: hàng của mảng tĩnh trước, keep: chỉ số hàng cũ của n0 hàng đầu} -> hàng
  // giữ nguyên lấy lại, chỉ tính hàng mới / đổi và hàng mượn hình doppelganger. Cùng kết quả và cùng thứ tự cấp số khoá
  // như tính lại cả mảng (hàng giữ nguyên không tạo khoá mới; khoá, cờ chỉ phụ thuộc hàng + bảng def không đổi).
  rows(U0, reuse) {
    const D = this.d.defArrays(), nd = D.n, n = U0.n;
    const R = rowsAlloc(n);
    this.computed = null;
    if (n === 0) return R;
    const ut = new Int16Array(n), ok = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const d = U0.def[i];
      ok[i] = d >= 0 && d < nd ? 1 : 0;
      ut[i] = ok[i] ? D.utype[Math.min(Math.max(d, 0), nd - 1)] : -1;
    }
    for (let i = 0; i < n; i++) {
      if (ok[i] && ut[i] === 80 && U0.kind[i] !== 25 && U0.gid[i] >= 0) {
        const gf = [U0.gid[i], U0.frame[i]];
        this.dopAt.set(U0.def[i] + "," + Math.trunc(U0.x[i]) + "," + Math.trunc(U0.y[i]), gf);
        this.dopDef.set(U0.def[i], gf);
      }
    }
    let U = U0;
    for (let i = 0; i < n; i++) {
      if (U0.kind[i] === 25 && U0.gid[i] < 0) {
        if (U === U0) { U = ualloc(n); for (const [f] of UF) U[f].set(U0[f]); }
        const dd = U.def[i];
        const gf = this.dopAt.get(dd + "," + Math.trunc(U.x[i]) + "," + Math.trunc(U.y[i])) || this.dopDef.get(dd);
        if (gf) { U.gid[i] = gf[0]; U.frame[i] = gf[1]; }
      }
    }
    const w = this.w, mw = w.map_w, mh = w.map_h;
    const n0 = reuse ? reuse.keep.length : 0;
    const computed = reuse ? [] : null;
    for (let i = 0; i < n; i++) {
      if (i < n0 && !(U0.kind[i] === 25 && U0.gid[i] < 0)) {
        const j = reuse.keep[i], P = reuse.prev;
        R.uid[i] = P.uid[j]; R.key[i] = P.key[j]; R.x[i] = P.x[j]; R.y[i] = P.y[j]; R.z[i] = P.z[j];
        R.owner[i] = P.owner[j]; R.flags[i] = P.flags[j];
        continue;
      }
      if (computed) computed.push(i);
      const tx = Math.floor(U.x[i]), ty = Math.floor(U.y[i]);
      const inside = tx >= 0 && tx < mw && ty >= 0 && ty < mh;
      R.uid[i] = U.uid[i];
      R.key[i] = this.keys.idOf(w.unitKey(U, i, D));
      R.x[i] = U.x[i]; R.y[i] = U.y[i]; R.z[i] = U.z[i];
      R.owner[i] = Math.min(Math.max(U.owner[i], 0), 255);
      const k25 = U0.kind[i] === 25;
      const di = Math.min(Math.max(U.def[i], 0), nd - 1);
      let fl = 0;
      if (k25) fl |= F_DOP;
      if (ut[i] === 80) fl |= F_BLD;
      if (D.fogvis[di] && ok[i]) fl |= F_FOGVIS;
      if (!inside || (ut[i] === 60 && U.gid[i] < 0)) fl |= F_HIDE;
      if (k25 && ut[i] !== 25) fl |= F_DOPOK;
      R.flags[i] = fl;
    }
    this.computed = computed;                  // chỉ số hàng đã tính lại (null = tất cả)
    return R;
  }
}

// ---- dữ liệu HUD (mapcap/webhud.HudExport) -----------------------------------------------------------------
class Hud {
  constructor(d, world, gd) {
    this.d = d; this.w = world; this.gd = gd;
    this.research = gd.research;
    this.chunks = [];
    this.prevU = null; this.prevA = new Map(); this.prevT = new Map();
    this.dats = new Set();
    this.sd = []; this.sMap = null;
    this.civs = new Map();
    for (const p of d.players) {
      if (p.index && (p.addr || p.pid) && p.civ !== null && p.civ !== undefined && p.civ > 0) this.civs.set(p.index, gd.civName(p.civ));
    }
  }
  unitName(dat, lang) {
    const du = this.gd.units.get(dat);
    for (const sid of [lang, du ? du.lang : null]) {
      const v = sid ? this.gd.str(sid) : null;
      if (v) return v;
    }
    if (du && du.name) return du.name.replaceAll("_", " ");
    return "?";
  }
  // bảng chi tiết sắp theo uid, mỗi uid một hàng (sau cùng thắng): [uid, def, máu, trạng thái, loại tài nguyên, lượng, kind]
  static detail(U) {
    const n = U.n;
    const o = Array.from({ length: n }, (_, i) => i);
    o.sort((a, b) => U.uid[a] - U.uid[b] || a - b);
    const rows = [];
    for (let j = 0; j < n; j++) {
      const i = o[j];
      if (j + 1 < n && U.uid[o[j + 1]] === U.uid[i]) continue;
      rows.push([U.uid[i], U.def[i], npRound1(U.hp[i]), U.status[i], U.rtype[i], npRound1(U.ramount[i]), U.kind[i]]);
    }
    return rows;
  }
  static diff(prev, M) {
    if (!prev || !prev.length) return [M, []];
    const pu = prev.map(r => r[0]);
    const ch = [];
    const has = new Set();
    for (const r of M) {
      has.add(r[0]);
      let lo = 0, hi = pu.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (pu[m] < r[0]) lo = m + 1; else hi = m; }
      const k = Math.min(lo, pu.length - 1);
      const P = prev[k];
      let same = pu[k] === r[0];
      if (same) for (let c = 0; c < 7; c++) { if (!(P[c] === r[c] || (Number.isNaN(P[c]) && Number.isNaN(r[c])))) { same = false; break; } }
      if (!same) ch.push(r);
    }
    return [ch, pu.filter(u => !has.has(u))];
  }
  static rowsOut(M) { return M.map(r => [r[0], r[1], num(r[2]), r[3], r[4], num(r[5]), r[6]]); }

  frame(fi, st) {
    if (fi % HSTEP) return;
    const start = fi % this.w.chunk === 0;
    if (start) { this.chunks.push([]); this.prevU = null; this.prevA = new Map(); this.prevT = new Map(); }
    const U = st.units();
    const rows = Hud.detail(U);
    const [ch, gone] = Hud.diff(this.prevU, rows);
    const uOut = Hud.rowsOut(ch);
    this.prevU = rows;
    const vill = new Map();
    if (U.n) {
      const D = this.d.defArrays();
      for (let i = 0; i < U.n; i++) {
        const di = Math.min(Math.max(U.def[i], 0), D.n - 1);
        const alive = U.kind[i] !== 25 && U.status[i] < 3 && U.hp[i] > 0;
        if (alive && D.utype[di] === 70 && D.cls[di] === 4) vill.set(U.owner[i], (vill.get(U.owner[i]) || 0) + 1);
      }
    }
    const P = {}, R = {}, AV = {}, T = {};
    let hasR = false, hasA = false, hasT = false;
    for (const pl of this.d.players) {
      if (pl.index === 0 || !(pl.addr || pl.pid)) continue;
      const idx = pl.index;
      const ps = st.pstate.get(idx);
      const attrs = ps ? (ps[0] || []) : [];
      const a = i => i < attrs.length ? num(attrs[i]) : null;
      const pstat = st.pstat.get(idx);
      const ptype = pstat ? pstat[0] : 0, resigned = pstat ? pstat[1] : 0;
      const kills = a(A.KILLS);
      const stt = ptype === 2 && resigned ? 3 : (ptype === 1 ? 1 : ptype === 2 ? 2 : 0);
      const tribute = a(A.TRIBUTE_GIVEN);
      P[idx] = [a(A.AGE), vill.get(idx) || 0, a(A.POP), a(A.POP_ROOM), a(40), kills,
        st.lost.get(idx) || 0, st.conv.get(idx) || 0, a(A.GOLD_COLLECTED),
        tribute !== null ? Math.max(tribute, 0) : null, a(A.FOOD), a(A.WOOD), a(A.GOLD), a(A.STONE), stt];
      const res = [];
      const prs = st.prs.get(idx);
      if (prs) {
        for (const [tid, sec] of [...prs].sort((x, y) => x[0] - y[0])) {
          if (tid >= 0 && tid < this.research.length && this.research[tid].time > 0)
            res.push([tid, Math.trunc(1000 * Math.max(0.0, Math.min(1.0, sec / this.research[tid].time)))]);
        }
      }
      if (res.length) { R[idx] = res; hasR = true; }
      const avail = st.pav.get(idx);
      if (avail !== undefined) {
        const av = [...avail].map(Number).sort((x, y) => x - y);
        const pa = this.prevA.get(idx);
        if (start || !pa || canon(pa) !== canon(av)) { AV[idx] = av; hasA = true; }
        this.prevA.set(idx, av);
      }
      const trn = st.ptr.get(idx);
      if (trn !== undefined) {
        const tr = trn.map(x => [x[0], x[1], x[2]]).sort(cmpArr);
        const pt = this.prevT.get(idx);
        if (start || !pt || canon(pt) !== canon(tr)) {
          T[idx] = tr; hasT = true;
          for (const x of tr) this.dats.add(x[0]);
        }
        this.prevT.set(idx, tr);
      }
    }
    const Q = [];
    for (const [uid, pv] of st.prod) {
      if (!pyBool(pv)) continue;
      const [q, making, , frac] = pv;
      let total = 0;
      for (const e of q) total += e[1];
      const head = q.length ? q[0][0] : -1;
      Q.push([uid, making, total, head, making >= 0 ? Math.trunc(1000 * Math.max(0.0, Math.min(1.0, frac || 0.0))) : 0]);
      for (const x of [making, head]) if (x >= 0) this.dats.add(x);
    }
    const s = { f: fi, p: P };
    if (hasR) s.r = R;
    if (hasA) s.a = AV;
    if (hasT) s.t = T;
    if (Q.length) s.q = Q;
    if (uOut.length) s.u = uOut;
    if (gone.length) s.x = gone;
    this.chunks[this.chunks.length - 1].push(s);
  }

  // chi tiết vật thể tĩnh theo bản ghi (webhud.HudExport.static); keep / removed: bản ghi 'Q' (chỉ hàng sau keep là mới)
  static(first, S, keep, removed) {
    const det = i => [S.uid[i], S.def[i], npRound1(S.hp[i]), S.status[i], S.rtype[i], npRound1(S.ramount[i]), S.kind[i]];
    const same = (P, r) => { for (let c = 0; c < 7; c++) if (!(P[c] === r[c] || (Number.isNaN(P[c]) && Number.isNaN(r[c])))) return false; return true; };
    let prev = this.sMap;
    const ch = [];
    let gone = [];
    if (!prev || !keep) {
      const cur = new Map();
      for (let i = 0; i < S.n; i++) cur.set(S.uid[i], det(i));          // uid trùng: hàng sau thắng
      if (prev) for (const u of prev.keys()) if (!cur.has(u)) gone.push(u);
      for (const [u, r] of cur) { const P = prev && prev.get(u); if (!P || !same(P, r)) ch.push(r); }
      this.sMap = cur;
    } else {
      const now = new Map();
      for (let i = keep.length; i < S.n; i++) now.set(S.uid[i], det(i));
      if (removed) { const g = new Set(); for (const u of removed) if (prev.has(u) && !now.has(u)) g.add(u); gone = [...g]; }
      for (const [u, r] of now) { const P = prev.get(u); if (!P || !same(P, r)) ch.push(r); }
      for (const u of gone) prev.delete(u);
      for (const [u, r] of now) prev.set(u, r);
    }
    ch.sort((a, b) => a[0] - b[0]);
    gone.sort((a, b) => a - b);
    this.sd.push([first, this.sd.length ? 0 : 1, Hud.rowsOut(ch), gone]);
  }

  tables() {
    const d = this.d, gd = this.gd;
    const defs = {};
    for (const [i, df] of d.defs) {
      const du = gd.units.get(df.dat_id);
      defs[i] = [df.dat_id, df.utype, df.cls, num(df.hp_max || 0), this.unitName(df.dat_id, null),
        du && du.icon !== null && du.icon !== undefined ? du.icon : -1];
    }
    const units = {};
    for (const dat of [...this.dats].sort((a, b) => a - b)) {
      const du = gd.units.get(dat);
      units[dat] = [this.unitName(dat, null), du && du.icon !== null ? du.icon : -1, du ? du.type : -1];
    }
    const techs = {};
    for (const r of this.research) {
      if (r.researchable) techs[r.id] = [gd.str(r.lang) || r.name, r.icon, r.time, r.location, r.button,
        r.costs.filter(c => c[1] > 0).map(c => [c[0], c[1]])];
    }
    const stats = [], sidx = new Map(), dstats = {};
    for (const [di, [frames, lst]] of d.stats) {
      const ent = [];
      const dat = d.defs.has(di) ? d.defs.get(di).dat_id : -1;
      frames.forEach((f, j) => {
        const s = clean(lst[j]);
        s.name = this.unitName(dat, s.lang === undefined ? null : s.lang);
        const key = canon(s);
        let k = sidx.get(key);
        if (k === undefined) { k = stats.length; sidx.set(key, k); stats.push(sortKeys(s)); }
        ent.push([f, k]);
      });
      dstats[di] = ent;
    }
    const done = {};
    for (const [idx, tt] of d.final_tech_times) {
      const lst = [];
      for (const [t, ms] of tt) if (t >= 0 && t < this.research.length && this.research[t].researchable) lst.push([ms, t]);
      lst.sort(cmpArr);
      done[idx] = lst.map(([ms, t]) => [t, ms]);
    }
    const civs = {};
    for (const [k, v] of this.civs) civs[k] = v;
    return { step: HSTEP, defs, units, techs, stats, dstats, done, civs };
  }
}

// ---- bộ chuyển ---------------------------------------------------------------------------------------------
function cat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const u32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const i32b = a => new Uint8Array(Int32Array.from(a).buffer);
const u32b = a => new Uint8Array(Uint32Array.from(a).buffer);

export class RecBuilder {
  // pack: SpritePack (sprites.js), gd: GameData; opts.info: thông tin trận (danh sách trận), opts.encodeJpeg(rgb, w, h)
  // -> Promise<Uint8Array> (không có thì giữ ảnh RGB thô trong this.terrainRGB)
  constructor(pack, gd, opts = {}) {
    this.pack = pack; this.gd = gd; this.opts = opts;
    this.started = false;
  }

  header(hdr) {
    const d = this.d = new Stream(hdr);
    const w = this.w = new World(hdr, this.gd, this.pack);
    w.chunk = CHUNK;
    this.keys = new Keys(w, this.pack);
    this.maker = new RowMaker(d, w, this.keys);
    this.hud = new Hud(d, w, this.gd);
    this.st = new FrameState(d.map_w, d.map_h);
    this.accR = 0; this.frozen = 0; this.broken = false;
    this.cur = new Map();
    this.prevVis = null;
    this.chunks = [];                       // khối đã xong (bytes chưa nén)
    this.buf = null;
    this.statics = null;
    this.sRows = null;                      // hàng của mảng tĩnh hiện tại (dùng lại cho bản ghi 'Q' sau)
    this.scur = null;                       // uid -> chữ ký hàng tĩnh đã xuất
    this.srecs = [];                        // [{first, full, rows, removed}] + bytes
    this.srecBytes = [];
    this.started = true;
  }

  // địa hình + chỉ số ô (gọi sau header); JPEG qua opts.encodeJpeg
  async terrain(progress) {
    const w = this.w;
    let ts = 0.5;
    while (w.full_w * w.full_h * ts * ts > TERRAIN_BUDGET && ts > 1 / 16) ts /= 2;
    w.ts = ts;
    w.tex_w = pyRoundInt(w.full_w * ts); w.tex_h = pyRoundInt(w.full_h * ts);
    const T = { hdr: w.hdrArr, gd: this.gd, map_w: w.map_w, map_h: w.map_h, Y0: w.Y0, elev: w.elev, full_w: w.full_w,
      full_h: w.full_h, ts, tex_w: w.tex_w, tex_h: w.tex_h, store: w.store };
    const rgb = buildTerrain(T, progress);
    this.terrainRGB = rgb;
    this.tiles = [];
    for (let y = 0; y < w.tex_h; y += TILE) {
      for (let x = 0; x < w.tex_w; x += TILE) {
        const tw = Math.min(x + TILE, w.tex_w) - x, th = Math.min(y + TILE, w.tex_h) - y;
        const sub = new RGB(tw, th);
        for (let r = 0; r < th; r++) sub.px.set(rgb.px.subarray(((y + r) * w.tex_w + x) * 4, ((y + r) * w.tex_w + x + tw) * 4), r * tw * 4);
        const jpg = this.opts.encodeJpeg ? await this.opts.encodeJpeg(sub) : new Uint8Array(0);
        this.tiles.push({ rect: [x, y, tw, th], jpg });
      }
    }
    this.terr = { scale: ts, w: w.tex_w, h: w.tex_h,
      tiles: this.tiles.map((t, k) => ({ x: t.rect[0], y: t.rect[1], w: t.rect[2], h: t.rect[3], section: "t" + k })) };
    const its = ts / INDEX_SCALE_DIV;
    const I = { ...T, ts: its, tex_w: pyRoundInt(w.full_w * its), tex_h: pyRoundInt(w.full_h * its) };
    this.index = buildIndex(I);
    this.idxInfo = { scale: its, w: I.tex_w, h: I.tex_h, section: "index" };
  }

  feed(tag, p) {
    if (this.broken) return;
    if (tag === "D") this.d.applyDefs(p);
    else if (tag === "S" || tag === "Q") this._static(tag, p);
    else if (tag === "U") {
      const fn = this.d.n_frames;
      for (const [idx, stv] of p) {
        const k = Math.trunc(idx);
        let e = this.d.stats.get(k);
        if (!e) { e = [[], []]; this.d.stats.set(k, e); }
        e[0].push(fn); e[1].push(stv);
      }
    } else if (tag === "F") this._frame(p);
  }

  _static(tag, p) {
    const d = this.d;
    const first = d.n_frames;
    d.s_first.push(first);
    const units = normUnits(p.get("units"));
    let keep = null, removed = null;
    if (tag === "S" || this.statics === null) this.statics = units;
    else {
      removed = ints(p.get("removed"));
      const r = applyStaticDelta(this.statics, units, removed);
      this.statics = r.arr; keep = r.keep;
    }
    const S = this.statics;
    const R = this.maker.rows(S, keep && this.sRows ? { prev: this.sRows, keep } : null);
    const todo = this.maker.computed || Array.from({ length: R.n }, (_, i) => i);
    // so với hàng đã xuất theo uid (như so khối byte trên mảng sắp theo uid của webexport)
    const sc = this.scur, outIdx = [];
    let rem;
    if (sc === null) {
      for (let i = 0; i < R.n; i++) outIdx.push(i);
      rem = [];
    } else {
      for (const i of todo) if (sc.get(R.uid[i]) !== rowSig(R, i)) outIdx.push(i);
      if (keep) {
        const now = new Set();
        for (let i = keep.length; i < R.n; i++) now.add(R.uid[i]);
        const r = new Set();
        if (removed) for (const u of removed) if (sc.has(u) && !now.has(u)) r.add(u);
        rem = [...r];
      } else {
        const now = new Set(R.uid);
        rem = [];
        for (const u of sc.keys()) if (!now.has(u)) rem.push(u);
      }
      rem.sort((x, y) => x - y);
    }
    if (sc === null || !keep) {
      this.scur = new Map();
      for (let i = 0; i < R.n; i++) if (!this.scur.has(R.uid[i])) this.scur.set(R.uid[i], rowSig(R, i));
    } else {
      for (const u of rem) sc.delete(u);
      for (const i of todo) sc.set(R.uid[i], rowSig(R, i));
    }
    this.sRows = R;
    const out = rowsTake(R, outIdx);
    const full = this.srecs.length ? 0 : 1;
    const head = new Uint8Array(9);
    const hv = new DataView(head.buffer);
    hv.setInt32(0, first, true); head[4] = full; hv.setUint32(5, out.n, true);
    this.srecBytes.push(cat([head, rowsBytes(out), u32(rem.length), i32b(rem)]));
    this.srecs.push({ first, full, rows: out, removed: Int32Array.from(rem) });
    this.hud.static(first, S, keep, removed);
  }

  _frame(p) {
    const d = this.d, st = this.st;
    const fi = d.n_frames;
    let t, at;
    try {
      st.apply(p, fi);
      if (fi % SEEN_EVERY === 0) d.markSeen(st, fi);
      t = Math.trunc(p.get("t")); at = Number(p.get("at"));
      if (!Number.isFinite(at)) throw new Error("giờ sai");
    } catch (e) {
      this.broken = true;
      return;
    }
    if (fi) {
      let dr = Math.min(Math.max(at - d.f_at[d.f_at.length - 1], 0.0), MAX_STEP);
      if (t === d.f_t[d.f_t.length - 1]) {
        this.frozen += dr;
        if (this.frozen > PAUSE_GAP) dr = 0.0;
      } else this.frozen = 0.0;
      this.accR += dr;
    }
    d.f_t.push(t); d.f_at.push(at); d.f_r.push(this.accR);
    this.hud.frame(fi, st);
    const full = fi % CHUNK === 0;
    if (full) { this._flushChunk(); this.buf = []; }
    const removed = [];
    let out;
    if (full || p.get("full_units")) {
      const U = st.units();
      const R = this.maker.rows(U);
      if (p.get("full_units") && !full) {
        const alive = new Set(U.uid);
        for (const u of this.cur.keys()) if (!alive.has(u)) removed.push(u);
      }
      this.cur = new Map();
      for (let i = 0; i < R.n; i++) this.cur.set(R.uid[i], rowSig(R, i));
      out = R;
    } else {
      const ch = normUnits(p.get("units"));
      const rem = ints(p.get("removed"));
      if (rem && rem.length) for (const u of rem) if (this.cur.delete(u)) removed.push(u);
      const R = this.maker.rows(ch);
      const keep = [];
      for (let i = 0; i < R.n; i++) {
        const sig = rowSig(R, i);
        if (this.cur.get(R.uid[i]) !== sig) { this.cur.set(R.uid[i], sig); keep.push(i); }
      }
      out = rowsTake(R, keep);
    }
    const V = st.vis;
    const head = new Uint8Array(5);
    head[0] = full ? 1 : 0;
    new DataView(head.buffer).setUint32(1, out.n, true);
    const parts = [head, rowsBytes(out), u32(removed.length), i32b(removed)];
    if (full || this.prevVis === null) {
      parts.push(u32(V.length), new Uint8Array(V.slice().buffer));
    } else {
      let ix;
      if (st.delta) ix = st.chIdx.slice(0, st.nChanged);
      else {
        const PV = this.prevVis, a = [];
        for (let i = 0; i < V.length; i++) if (V[i] !== PV[i]) a.push(i);
        ix = Uint32Array.from(a);
      }
      const vals = new Uint32Array(ix.length);
      for (let k = 0; k < ix.length; k++) vals[k] = V[ix[k]];
      parts.push(u32(ix.length), new Uint8Array(ix.buffer), new Uint8Array(vals.buffer));
    }
    if (this.prevVis === null || this.prevVis.length !== V.length) this.prevVis = V.slice(); else this.prevVis.set(V);
    this.buf.push(cat(parts));
  }

  _flushChunk() {
    if (this.buf && this.buf.length) this.chunks.push(cat([u32(this.buf.length), ...this.buf]));
    this.buf = null;
  }

  // sau bản ghi cuối: các phần + meta của .aoeweb (sections chưa nén: {tên: Uint8Array}; phần "t<k>" là JPEG).
  // partial = true: đóng gói GIỮA CHỪNG phần đã dựng (để trình xem phát dần trong lúc dựng tiếp) - không đổi trạng thái
  // bộ chuyển: khối đang dở xuất tạm thành khối cuối, meta.partial = true. Khoá hình, bản ghi tĩnh, khối đã xong của bản
  // giữa chừng là phần đầu của bản cuối nên trình xem đổi sang bản sau mà không phải dựng lại gì.
  finish(fileName, partial = false) {
    const d = this.d, w = this.w, hud = this.hud;
    const n = d.n_frames;
    if (!n) throw new Error("trận không có mẫu nào");
    let chunks = this.chunks;
    if (!partial) this._flushChunk();
    else if (this.buf && this.buf.length) chunks = [...chunks, cat([u32(this.buf.length), ...this.buf])];
    d.final_tech_times = new Map([...this.st.tech_times].map(([k, v]) => [k, new Map(v)]));
    const S = new Map();
    this.tiles.forEach((t, k) => S.set("t" + k, t.jpg));
    S.set("index", new Uint8Array(this.index.buffer, this.index.byteOffset, this.index.byteLength));
    chunks.forEach((c, k) => S.set("c" + k, c));
    const te = new TextEncoder();
    // khối HUD đã đủ (mọi khối trừ khối cuối) chỉ mã hoá JSON một lần: lần đóng gói sau dùng lại đúng mảng byte đó
    const hc = this._hEnc || (this._hEnc = new Map());
    hud.chunks.forEach((c, k) => {
      let b = hc.get(k);
      if (!b) { b = te.encode(JSON.stringify(c)); if (k < hud.chunks.length - 1) hc.set(k, b); }
      S.set("h" + k, b);
    });
    S.set("statics", cat([u32(this.srecBytes.length), ...this.srecBytes]));
    S.set("times", cat([i32b(d.f_t), new Uint8Array(Float32Array.from(d.f_r).buffer)]));
    const sb = [];
    for (const seen of d.seen) {
      const items = [...seen].sort((a, b) => a[0] - b[0]);
      sb.push(u32(items.length), i32b(items.map(x => x[0])), i32b(items.map(x => x[1])));
    }
    S.set("seen", cat(sb));
    S.set("keys", this.keys.toBytes());
    S.set("sd", te.encode(JSON.stringify(hud.sd)));
    const hudMeta = hud.tables();
    hudMeta.icons = {};
    for (const sid of ICON_SLPS) {
      const b = this.gd.icons[sid];
      if (b) { S.set("i" + sid, b); hudMeta.icons[sid] = "i" + sid; }
    }
    const hdr = d.header;
    const rec = d.recorderIndex();
    let recTeam = d.teams.findIndex(t => t.includes(rec));
    const teams = d.teams.map(t => {
      let vm = 0n, em = 0n;
      for (const i of t) { vm |= BigInt(d.players[i].visible_mask); em |= BigInt(d.players[i].explored_mask); }
      return { players: [...t], vm: Number(vm), em: Number(em) };
    });
    const players = [];
    for (const p of d.players) {
      if (p.index === 0) continue;
      const [r, g, b] = w.playerRgb(p.index);
      players.push({ index: p.index, name: p.name, color: "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join(""),
        color_id: p.index < w.color_lut.length ? w.color_lut[p.index] : 0 });
    }
    const meta = {
      version: WEB_VERSION, file: fileName, info: this.opts.info ?? null,
      map_w: d.map_w, map_h: d.map_h, full_w: w.full_w, full_h: w.full_h, Y0: w.Y0,
      reveal: !!hdr.get("reveal"), fog_dim: FOG_DIM, frames: n, chunk: CHUNK, chunks: chunks.length,
      terrain: this.terr, index: this.idxInfo, players, teams, rec_team: recTeam,
      ages: d.ageEvents(), keys: this.keys.spans.length, pieces: this.keys.pieces.length,
      hud: hudMeta, civs: Object.fromEntries([...hud.civs].map(([k, v]) => [String(k), v])),
    };
    if (partial) meta.partial = true;
    return { meta, sections: S };
  }
}

// meta + phần (chưa nén trừ JPEG / icon) -> bytes .aoeweb; nén zlib từng phần như máy tính.
// opts.cache (Map): phần khối mẫu / khối HUD (c<k>, h<k>) đã nén ở lần đóng gói trước và mảng nguồn vẫn là mảng đó thì
// dùng lại (đóng gói giữa chừng nhiều lần chỉ nén phần mới); opts.level: mức nén các phần còn lại (mặc định 6).
export function packAoeweb(meta, sections, zlibSync, opts = {}) {
  const order = [...sections.keys()];
  const blobs = [];
  const sec = {};
  const cache = opts.cache || null, level = opts.level ?? 6;
  let pos = 0;
  for (const name of order) {
    let b = sections.get(name);
    const raw = /^t\d+$/.test(name) || /^i\d+$/.test(name);
    if (!raw) {
      const keep = cache && /^[ch]\d+$/.test(name);
      const hit = keep ? cache.get(name) : null;
      if (hit && hit.src === b) b = hit.out;
      else {
        const out = zlibSync(b, { level: keep ? 6 : level });
        if (keep) cache.set(name, { src: b, out });
        b = out;
      }
    }
    sec[name] = [pos, b.length];
    blobs.push(b);
    pos += b.length;
  }
  const js = new TextEncoder().encode(JSON.stringify({ ...meta, sections: sec }));
  const head = new Uint8Array(12);
  head.set(new TextEncoder().encode("AOEWEB01"), 0);
  new DataView(head.buffer).setUint32(8, js.length, true);
  return cat([head, js, ...blobs]);
}
