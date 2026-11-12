// HUD trình xem điện thoại: bảng tỉ số (kinh tế / quân sự), công nghệ của người chơi đang chọn, thông tin unit /
// công trình (máu, công / giáp, tài nguyên, đang nghiên cứu, hàng đợi sinh, bảng lệnh: quân sinh được + công nghệ còn
// nghiên cứu được), minimap, trợ giúp. Dữ liệu: meta.hud + phần h<k> / sd / i<slp> của .aoeweb (mapcap/webhud.py),
// cùng nguồn với HUD trình xem máy tính (replay/hud.py, replay/viewer.py _hud_model / _unit_info / _command_panel).
import { inflate } from "./format.js";
import { PX_BLACK, PX_PAL, PX_PLAYER, PX_SHADOW, SLP } from "./sprites.js";

export const AGE_VI = { 0: "Du mục", 1: "Đồ đá", 2: "Công cụ", 3: "Đồ đồng", 4: "Đồ sắt" };
const TC_DAT = new Set([109, 71, 141, 142]);           // Town Center các đời
// cột mẫu HUD người chơi (webhud.HudExport.frame)
const P_AGE = 0, P_VILL = 1, P_POP = 2, P_ROOM = 3, P_ARMY = 4, P_KILLS = 5, P_DEATHS = 6, P_RAZE = 7, P_GOLDM = 8,
  P_TRIB = 9, P_FOOD = 10, P_WOOD = 11, P_GOLD = 12, P_STONE = 13, P_STATUS = 14;
// interfac.drs 50731: icon tài nguyên / chỉ số (như replay/hud.py STAT_ICONS)
const RES_FRAME = { 0: 2, 1: 0, 2: 1, 3: 3 };           // loại tài nguyên (0 thực, 1 gỗ, 2 đá, 3 vàng) -> khung
const RES_NAME = { 0: "thực", 1: "gỗ", 2: "đá", 3: "vàng" };
const STAT_FRAME = { attack: 7, armor: 8, reload: 9, pierce: 10 };
export const ECO_COLS = [["Thời đại", "age"], ["Dân", P_VILL], ["Dân số", "popcap"], ["res0", P_FOOD], ["res1", P_WOOD],
  ["res3", P_GOLD], ["res2", P_STONE]];
export const MIL_COLS = [["Quân", P_ARMY], ["Kill", P_KILLS], ["Chết", P_DEATHS], ["Phá nhà", P_RAZE],
  ["Công nghệ", "ntech"], ["Vàng KT", P_GOLDM], ["Bơm", P_TRIB]];

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const fmtNum = v => (typeof v === "number" && !Number.isInteger(v))
  ? (Math.round(v * 10) / 10).toString().replace(".", ",") : String(v);
const fmtMs = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

// ---- dữ liệu ----------------------------------------------------------------------------------------------
export class HudData {
  constructor(match) {
    this.m = match;
    this.H = match.meta.hud || null;
    this.ok = !!this.H;
    this.cache = new Map();          // khối -> Promise<[mẫu]>
    this.cur = null;                 // {k, j, units: Map} trạng thái chi tiết unit đã áp
    this.sd = null;
    this.sIdx = -1;
    this.sMap = new Map();
  }

  _chunk(k) {
    let p = this.cache.get(k);
    if (!p) {
      const name = "h" + k;
      p = this.m.meta.sections[name]
        ? inflate(this.m.section(name)).then(b => JSON.parse(new TextDecoder().decode(b))) : Promise.resolve([]);
      this.cache.set(k, p);
      if (this.cache.size > 3) { const f = this.cache.keys().next().value; if (f !== k) this.cache.delete(f); }
    }
    return p;
  }

  // Trạng thái HUD tại mẫu fi: {f, p, r, a, t, q: Map uid -> hàng, units: Map uid -> chi tiết}
  async at(fi) {
    if (!this.ok) return null;
    const C = this.m.meta.chunk;
    const k = Math.floor(fi / C);
    const S = await this._chunk(k);
    if (!S.length) return null;
    let j = 0;
    while (j + 1 < S.length && S[j + 1].f <= fi) j++;
    let c = this.cur;
    if (!c || c.k !== k || c.j > j) { c = this.cur = { k, j: -1, units: new Map(), a: {}, t: {} }; }
    for (let q = c.j + 1; q <= j; q++) {
      const s = S[q];
      for (const u of s.x || []) c.units.delete(u);
      for (const row of s.u || []) c.units.set(row[0], row);
      for (const [pi, v] of Object.entries(s.a || {})) c.a[pi] = v;
      for (const [pi, v] of Object.entries(s.t || {})) c.t[pi] = v;
    }
    c.j = j;
    const s = S[j];
    const q = new Map();
    for (const row of s.q || []) q.set(row[0], row);
    return { f: s.f, p: s.p || {}, r: s.r || {}, a: c.a, t: c.t, q, units: c.units };
  }

  async statics(sIdx) {
    if (!this.ok || sIdx < 0) return this.sMap;
    if (!this.sd) this.sd = JSON.parse(new TextDecoder().decode(await inflate(this.m.section("sd"))));
    if (sIdx < this.sIdx) { this.sMap = new Map(); this.sIdx = -1; }
    for (let i = this.sIdx + 1; i <= sIdx && i < this.sd.length; i++) {
      const [, full, rows, gone] = this.sd[i];
      if (full) this.sMap.clear();
      for (const u of gone) this.sMap.delete(u);
      for (const r of rows) this.sMap.set(r[0], r);
    }
    this.sIdx = sIdx;
    return this.sMap;
  }

  stats(def, fi) {
    const e = this.H.dstats[def];
    if (!e || !e.length) return null;
    let k = 0;
    while (k + 1 < e.length && e[k + 1][0] <= fi) k++;
    return this.H.stats[e[k][1]];
  }

  // công nghệ đã xong tới giờ game tms: [[tid, ms]] theo thứ tự xong
  done(player, tms) {
    return (this.H.done[player] || []).filter(([, ms]) => ms <= tms);
  }
}

// ---- icon game (interfac.drs trong .aoeweb) ------------------------------------------------------------------
export class Icons {
  constructor(match, palette) {
    this.m = match; this.pal = palette;
    this.slps = new Map(); this.urls = new Map();
  }
  _slp(sid) {
    let s = this.slps.get(sid);
    if (s === undefined) {
      const name = (this.m.meta.hud && this.m.meta.hud.icons || {})[sid];
      s = name ? new SLP(this.m.section(name)) : null;
      this.slps.set(sid, s);
    }
    return s;
  }
  // data URL của khung frame (màu quân colorId) hoặc null
  url(sid, frame, colorId = 0) {
    const key = sid + ":" + frame + ":" + colorId;
    if (this.urls.has(key)) return this.urls.get(key);
    let url = null;
    const s = this._slp(sid);
    const img = s && frame >= 0 ? s.decode(frame) : null;
    if (img) {
      const c = document.createElement("canvas");
      c.width = img.w; c.height = img.h;
      const g = c.getContext("2d");
      const id = g.createImageData(img.w, img.h);
      const pal = this.pal, px = img.px, d = id.data;
      for (let i = 0; i < img.w * img.h; i++) {
        const t = px[i * 2 + 1];
        if (t === 0) continue;
        let idx = px[i * 2];
        if (t === PX_SHADOW) { d[i * 4 + 3] = 110; continue; }
        if (t === PX_BLACK) { d[i * 4 + 3] = 255; continue; }
        if (t === PX_PLAYER) idx = Math.min(16 * (colorId + 1) + idx, 255);
        else if (t !== PX_PAL) continue;
        const rgb = pal[idx];
        d[i * 4] = rgb[0]; d[i * 4 + 1] = rgb[1]; d[i * 4 + 2] = rgb[2]; d[i * 4 + 3] = 255;
      }
      g.putImageData(id, 0, 0);
      url = c.toDataURL();
    }
    this.urls.set(key, url);
    return url;
  }
  img(sid, frame, colorId, cls = "ic", title = "") {
    const u = this.url(sid, frame, colorId);
    return u ? `<img class="${cls}" src="${u}" alt="" title="${esc(title)}">` : `<span class="${cls} none">${esc(title.slice(0, 3))}</span>`;
  }
  res(type) { return this.img(50731, RES_FRAME[type], 0, "ri", RES_NAME[type]); }
  stat(key) { return this.img(50731, STAT_FRAME[key], 0, "si", key); }
  tech(icon, title = "") { return this.img(50729, icon, 0, "ic", title); }
  // chân dung unit (50730) / công trình (50704..50707 theo đời của chủ)
  unit(datOrIcon, utype, colorId, age, title = "") {
    const sid = utype === 80 ? 50704 + Math.max(0, Math.min(3, (age || 1) - 1)) : 50730;
    return this.img(sid, datOrIcon, colorId, "ic", title);
  }
}

// ---- thông tin unit (như replay/viewer.py _unit_info) -------------------------------------------------------
export function unitInfo(v, sel, hs) {
  const H = v.hud.H, M = v.m.meta;
  const row = sel.kind === "s" ? v.hudStatics.get(sel.uid) : hs.units.get(sel.uid);
  if (!row) return { gone: true };
  const [, def, hp, status, rtype, ramount, kind] = row;
  const D = H.defs[def] || [-1, 0, -1, 0, "?", -1];
  const [dat, utype, cls, hpDef, defName, iconId] = D;
  const fi = Math.max(0, v.state.frame);
  const st = v.hud.stats(def, fi);
  const owner = sel.owner;
  const pl = M.players.find(p => p.index === owner);
  const colorId = pl ? pl.color_id : 0;
  const P = hs.p[owner] || [];
  const hpMax = (st && st.hp) || hpDef || 0;
  const rows = [];
  if (st && st.attacks) {
    const atk = Math.max(0, ...st.attacks.map(a => a[1]));
    const pierceAtk = st.attacks.filter(a => a[0] === 3);
    const melee = Math.max(st.armor0 || 0, ...(st.armors || []).filter(a => a[0] !== 3).map(a => a[1]));
    const pierce = Math.max(0, ...(st.armors || []).filter(a => a[0] === 3).map(a => a[1]));
    const plus = (cur, base) => base != null && cur > base ? `${fmtNum(base)}+${fmtNum(Math.round((cur - base) * 10) / 10)}` : fmtNum(cur);
    if (atk > 0) rows.push(["attack", "Công", plus(atk, st.d_attack > 0 ? st.d_attack : null)]);
    rows.push(["armor", "Giáp", plus(melee, st.d_melee)]);
    if (pierce || pierceAtk.length || "d_pierce" in st) rows.push(["pierce", "Giáp xuyên", plus(pierce, st.d_pierce)]);
    const rng = st.range || 0;
    if (rng >= 1) rows.push([null, "Tầm", plus(Math.round(rng * 10) / 10, Math.round((st.d_range || 0) * 10) / 10 || null)]);
    if (atk > 0 && st.reload) rows.push(["reload", "Tốc đánh", fmtNum(Math.round(st.reload * 100) / 100) + " giây"]);
  }
  if (st) {
    if (st.speed) rows.push([null, "Tốc chạy", fmtNum(Math.round(st.speed * 100) / 100)]);
    if (st.los) rows.push([null, "Tầm nhìn", fmtNum(Math.round(st.los * 10) / 10)]);
    if (st.accuracy && (st.range || 0) >= 1) rows.push([null, "Chính xác", st.accuracy + "%"]);
  }
  let res = null;
  if (rtype >= 0 && rtype <= 3) {
    if (utype === 70) { if (ramount >= 0.5) res = [rtype, `Đang mang ${Math.floor(ramount)} ${RES_NAME[rtype]}`]; }
    else res = [rtype, `Còn lại ${Math.floor(ramount)} ${RES_NAME[rtype]}`];
  }
  const progress = [];
  if (utype === 80 && status === 2 && owner > 0) {
    for (const [tid, pm] of hs.r[owner] || []) {
      const T = H.techs[tid];
      if (T && T[3] === dat) progress.push([T[0], pm / 1000, T[1]]);
    }
  }
  let queue = null;
  const qv = hs.q.get(sel.uid);
  if (utype === 80 && kind !== 25 && qv) {
    const [, making, count, head, pm] = qv;
    const cur = making >= 0 ? making : head;
    const U = H.units[cur] || ["?", -1, 70];
    queue = { name: U[0], count, frac: making >= 0 ? pm / 1000 : 0, icon: U[1], utype: U[2] };
  }
  let cmd = null;
  if (utype === 80 && kind !== 25 && status === 2 && owner > 0 && hp > 0) {
    const slots = new Map();
    for (const [did, loc, btn] of hs.t[owner] || []) {
      if (loc === dat && btn > 0 && !slots.has(btn)) {
        const U = H.units[did] || ["?", -1, 70];
        slots.set(btn, { kind: "unit", name: U[0], icon: U[1], utype: U[2], cost: "" });
      }
    }
    for (const tid of hs.a[owner] || []) {
      const T = H.techs[tid];
      if (!T || T[3] !== dat || T[4] <= 0 || slots.has(T[4])) continue;
      slots.set(T[4], { kind: "tech", name: T[0], icon: T[1],
                        cost: T[5].map(([t, a]) => `${a} ${RES_NAME[t] || "?"}`).join(", ") });
    }
    cmd = [...slots.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
  }
  const lines = [];
  if (kind === 25) lines.push("Hình ghi nhớ trong sương mù");
  else if (status >= 3 || hp <= 0) lines.push("Đã chết / đã cạn");
  else if (status === 0 && utype === 80) lines.push(`Đang xây: ${hpMax ? Math.floor(100 * Math.max(hp, 0) / hpMax) : 0}%`);
  const civ = (M.civs || {})[owner] || "";
  return {
    name: (st && st.name) || defName, owner: owner > 0 ? (pl ? pl.name : "#" + owner) + (civ ? "  ·  " + civ : "") : "Gaia",
    color: owner > 0 && pl ? pl.color : "#c8c8c8", colorId, age: P[P_AGE], dat, utype, iconId, rows, res, progress,
    queue, cmd, lines, hp: hpMax > 0 ? [Math.max(hp, 0), hpMax] : null,
  };
}

export function scoreCell(p, key, nt) {
  if (key === "age") return p[P_AGE] == null ? "-" : (AGE_VI[p[P_AGE]] || String(p[P_AGE]));
  if (key === "popcap") return p[P_POP] == null ? "-" : `${p[P_POP]}/${p[P_POP] + (p[P_ROOM] || 0)}`;
  if (key === "ntech") return String(nt);
  const v = p[key];
  return v == null ? "-" : String(Math.floor(v));
}

export function statusOf(p) {
  return { 1: "thắng", 2: "thua", 3: "đầu hàng" }[p[P_STATUS]] || "";
}

export { TC_DAT, P_AGE, esc, fmtMs };
