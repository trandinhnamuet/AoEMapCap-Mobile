// Trình xem một trận: phát / tua, đổi tầm nhìn đội, kéo / chụm để di chuyển và zoom máy quay, HUD như trình xem máy
// tính (bảng tỉ số, công nghệ, chạm vào unit / nhà, minimap; hud.js). Phím tắt giống replay/viewer.py khi có bàn phím.
// Logic chọn unit theo tầm nhìn giống replay/viewer.py (_rebuild).
import { F_BLD, F_DOP, F_DOPOK, F_FOGVIS, F_HIDE, Match, State } from "./format.js";
import { Renderer } from "./gl.js";
import { AGE_VI, ECO_COLS, HudData, Icons, MIL_COLS, P_AGE, TC_DAT, esc, fmtMs, scoreCell, statusOf, unitInfo } from "./hud.js";

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16];
const JUMP_MS = 15000;             // lùi / tới 15 giây giờ game
const HUD_MS = 200;                // làm mới bảng HUD tối đa 5 lần mỗi giây khi đang phát
const DECODE_BUDGET_MS = 8;        // giải mã sprite mới tối đa mỗi khung hình; còn lại để khung sau

export function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
  const p = n => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

export class Viewer {
  constructor(root, matchBuf, pack, opts = {}) {
    this.root = root;
    this.pack = pack;
    this.opts = opts;
    this.buf = matchBuf;
  }

  async init() {
    this.m = await Match.open(this.buf);
    const M = this.m.meta;
    this.build = M.partial ? (this.opts.build || { pos: 0, frames: M.frames }) : null;   // trận đang dựng dần
    this.state = new State(this.m);
    this.canvas = this.root.querySelector("canvas");
    this.R = new Renderer(this.canvas);
    this.R.setPalette(this.pack.palette);
    const blobOf = name => new Blob([this.m.section(name)], { type: "image/jpeg" });
    await this.R.setTerrain(M, blobOf);
    this.R.setIndex(M, this.m.index);
    this.R.setOutline(M);
    this.fog = new Uint8Array(M.map_w * M.map_h);
    this.fogDim = Math.round(M.fog_dim * 255);
    this.persp = M.rec_team >= 0 ? M.rec_team : null;
    this.lastTeam = this.persp ?? 0;
    this.r = 0;
    this.playing = false;
    this.speedIdx = SPEEDS.indexOf(1);
    this.hud = new HudData(this.m);
    this.icons = new Icons(this.m, this.pack.palette);
    this.hudStatics = new Map();
    this.hs = null;
    this.show = { score: false, techs: false, mini: true, hide: false, help: false };
    this.scoreMode = 0;
    const recTeam = M.teams[this.lastTeam];
    this.selected = recTeam && recTeam.players.length ? recTeam.players[0] : (M.players[0] || {}).index ?? null;
    this.sel = null;               // unit / công trình đang chọn: {kind: "u" | "s", uid, owner}
    this.follow = false;
    this.autoCam = false;          // máy quay tự động (setAutoCam)
    this.drawn = []; this.drawnS = [];
    this.inst = { statics: new Float32Array(10 * 4096), units: new Float32Array(10 * 4096) };
    this.dirtyUnits = true; this.dirtyStatics = true; this.dirtyFog = true;
    this.lastStaticsKey = null;
    this.frameMs = [];
    this._resize();
    this.fitView();
    await this.state.seek(0);
    this._buildUi();
    this._bindInput();
    new ResizeObserver(() => { this._resize(); this.needDraw = true; }).observe(this.canvas);
    this.needDraw = true;
    this._last = performance.now();
    requestAnimationFrame(t => this._loop(t));
  }

  // ---- trận đang dựng dần trên điện thoại (rec/live.js) ---------------------------------------------
  // độ dài thanh thời gian: trận đủ = thời lượng thật; đang dựng = ước lượng theo phần file đã đọc (núm tua không giật
  // lùi mỗi lần có thêm dữ liệu); tua quá phần đã dựng thì dừng ở cuối phần đã dựng
  get total() {
    const b = this.build, d = this.m.duration;
    return this.m.meta.partial && b && b.pos > 0.02 ? Math.max(d, d / b.pos) : d;
  }

  // đổi sang bản dựng đầy đủ hơn của CÙNG trận (bản trước là phần đầu của bản này: khoá hình, bản ghi tĩnh, khối mẫu
  // giữ nguyên số thứ tự nên trạng thái đang phát, atlas hình và địa hình dùng tiếp); st = {pos, frames, final}
  async swap(buf, st) {
    if (this._swapBusy) { this._swapNext = [buf, st]; return; }
    this._swapBusy = true;
    try {
      const m = await Match.open(buf);
      this.m = m; this.state.m = m; this.buf = buf;
      this.hud = new HudData(m);
      this.icons.m = m; this.icons.slps.clear();
      this.build = st && !st.final ? st : null;
      this._hudDirty = true;
      if (this.ui) { this._drawAges(); this._updateUi(); }
      this.needDraw = true;
    } catch (e) { this._error(e); }
    finally {
      this._swapBusy = false;
      if (this._swapNext) { const a = this._swapNext; this._swapNext = null; this.swap(...a); }
    }
  }

  // tiến độ dựng giữa hai lần có bản mới (chỉ để hiện %, không đổi thang thanh thời gian)
  buildProgress(pos) { if (this.build) this.build.now = pos; }

  // ---- máy quay ----------------------------------------------------------------
  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const c = this.canvas;
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    this.dpr = dpr;
    if (this.R) this.R.outlinePx = Math.max(1.5, dpr * 0.9);
  }

  fitZoom() {
    const M = this.m.meta, c = this.canvas;
    return Math.min(c.width / M.full_w, c.height / M.full_h) * 0.98;
  }

  fitView() {
    const M = this.m.meta;
    this.cam = { x: M.full_w / 2, y: M.full_h / 2, zoom: this.fitZoom() };
    this.needDraw = true;
  }

  zoomAt(factor, sx, sy) {       // sx, sy: pixel khung vẽ
    const c = this.cam, W = this.canvas.width, H = this.canvas.height;
    const z = Math.min(4, Math.max(this.fitZoom() * 0.9, c.zoom * factor));
    const wx = c.x + (sx - W / 2) / c.zoom, wy = c.y + (sy - H / 2) / c.zoom;
    c.zoom = z;
    c.x = wx - (sx - W / 2) / z; c.y = wy - (sy - H / 2) / z;
    this._clamp();
  }

  _clamp() {
    const M = this.m.meta, c = this.cam;
    c.x = Math.min(M.full_w, Math.max(0, c.x));
    c.y = Math.min(M.full_h, Math.max(0, c.y));
    this.needDraw = true;
  }

  // ---- dựng lại dữ liệu vẽ -------------------------------------------------------------
  _teamMasks() {
    const t = this.m.meta.teams[this.persp];
    return [t.vm >>> 0, t.em >>> 0];
  }

  _buildFog() {
    const V = this.state.vis, fog = this.fog;
    if (this.persp === null) { fog.fill(255); }
    else {
      const [vm, em] = this._teamMasks();
      const rev = this.m.meta.reveal;
      const dim = this.fogDim;
      for (let i = 0; i < V.length; i++) {
        const v = V[i];
        fog[i] = (v & vm) ? 255 : ((v & em) || rev) ? dim : 0;
      }
    }
    this.R.setFog(fog);
  }

  // mảnh sprite của một khoá -> ghi vào out; trả về số mảnh, -1 nếu chưa giải mã kịp
  _emit(out, n, key, ax, ay, bright, deadline) {
    const m = this.m, atlas = this.R.atlas;
    const s = m.kStart[key], c = m.kCount[key];
    for (let j = 0; j < c; j++) {
      const p = s + j;
      const ak = m.pSlp[p] * 65536 + m.pFrame[p];
      let e = atlas.map.get(ak);
      if (e === undefined) {
        // ngân sách giải mã tính bằng thời gian GIẢI MÃ THẬT của khung này (trước: hạn chót tính từ đầu khung -> máy chậm
        // duyệt hết vật thể tĩnh đã quá hạn, hình chưa giải mã ở cuối danh sách không bao giờ được giải mã, khung nào
        // cũng dựng lại toàn bộ vật thể tĩnh - đo 12/11: ~20 ms mỗi khung khi CPU chậm 4 lần)
        if (this.decodeLeft <= 0) { this.deferred++; return n; }
        const td = performance.now();
        const slp = this.pack.slp(m.pSlp[p]);
        const img = slp ? slp.decode(m.pFrame[p]) : null;
        this.decodeLeft -= performance.now() - td;
        e = img ? atlas.add(ak, img) : null;
        if (e === undefined) {                               // atlas đầy: xoá, dựng lại cả hai lô
          atlas.clear(); this.dirtyStatics = true; this.deferred++;
          return n;
        }
        if (!img) atlas.map.set(ak, null);
      }
      if (!e) continue;
      if ((n + 1) * 10 > out.length) return -2 - n;          // cần mảng lớn hơn
      const o = n * 10;
      out[o] = Math.floor(ax + m.pDx[p] + 0.5); out[o + 1] = Math.floor(ay + m.pDy[p] + 0.5);
      out[o + 2] = e.w; out[o + 3] = e.h;
      out[o + 4] = e.x; out[o + 5] = e.y; out[o + 6] = e.layer; out[o + 7] = m.pMirror[p];
      out[o + 8] = m.pColor[p]; out[o + 9] = bright;
      n++;
    }
    return n;
  }

  _fill(name, items, deadline) {
    // items: mảng [key, ax, ay, bright] đã sắp theo thứ tự vẽ
    for (;;) {
      let out = this.inst[name], n = 0, grow = false;
      for (let i = 0; i < items.length; i += 4) {
        const r = this._emit(out, n, items[i], items[i + 1], items[i + 2], items[i + 3], deadline);
        if (r < -1) { grow = true; break; }
        n = r;
      }
      if (!grow) { this.R.setBatch(name, out, n); return; }
      this.inst[name] = new Float32Array(out.length * 2);
    }
  }

  _anchor(x, y, z) {
    return [(x + y) * 32, (y - x) * 16 - z * 16 + this.m.meta.Y0];
  }

  _rebuildStatics(deadline) {
    const S = this.state.statics;
    const rows = [];
    this.drawnS = [];
    for (const [uid, r] of S) {
      if (r[5] & (F_HIDE | F_DOP)) continue;
      rows.push(r);
      this.drawnS.push(uid);
    }
    rows.sort((a, b) => (a[2] - a[1]) - (b[2] - b[1]) || (a[1] + a[2]) - (b[1] + b[2]));
    const items = new Float64Array(rows.length * 4);
    rows.forEach((r, i) => {
      const [ax, ay] = this._anchor(r[1], r[2], r[3]);
      items.set([r[0], ax, ay, -1], i * 4);
    });
    const before = this.deferred;
    this._fill("statics", items, deadline);
    this.dirtyStatics = this.deferred > before;
  }

  _rebuildUnits(deadline) {
    const st = this.state, M = this.m.meta;
    const mw = M.map_w, mh = M.map_h;
    const V = st.vis;
    const idx = [];
    let vm = 0, em = 0;
    const rec = this.persp !== null && this.persp === M.rec_team;
    if (this.persp !== null) [vm, em] = this._teamMasks();
    const seen = this.persp !== null ? this.m.seen[this.persp] : null;
    const rev = M.reveal;
    // ô có bản ghi nhớ (doppelganger) đang thay vật thể thật
    let D = null;
    if (rec) {
      D = new Set();
      for (let i = 0; i < st.cap; i++) {
        if (!st.valid[i]) continue;
        const f = st.flags[i];
        if ((f & F_DOP) && (f & F_DOPOK) && !(f & F_HIDE)) {
          const t = Math.floor(st.y[i]) * mw + Math.floor(st.x[i]);
          if (!(V[t] & vm)) D.add(t);
        }
      }
    }
    const bright = [];
    for (let i = 0; i < st.cap; i++) {
      if (!st.valid[i]) continue;
      const f = st.flags[i];
      if (f & F_HIDE) continue;
      const k25 = (f & F_DOP) !== 0;
      let b = 1;
      if (this.persp === null) { if (k25) continue; }
      else {
        const tx = Math.min(mw - 1, Math.max(0, Math.floor(st.x[i])));
        const ty = Math.min(mh - 1, Math.max(0, Math.floor(st.y[i])));
        const t = ty * mw + tx;
        const vT = (V[t] & vm) !== 0;
        const eT = vT || (V[t] & em) !== 0 || rev;
        let fv = (f & F_FOGVIS) !== 0;
        if (!fv && (f & F_BLD) && seen) { const s = seen.get(st.uid[i]); fv = s !== undefined && s <= st.frame; }
        let keep;
        if (rec) keep = (k25 && (f & F_DOPOK) && !vT) || (!k25 && (vT || (eT && fv && !D.has(t))));
        else keep = !k25 && (vT || (eT && fv));
        if (!keep) continue;
        b = vT && !k25 ? 1 : M.fog_dim;
      }
      idx.push(i);
      bright.push(b);
    }
    const order = idx.map((_, k) => k);
    order.sort((a, b) => {
      const ia = idx[a], ib = idx[b];
      return (st.y[ia] - st.x[ia]) - (st.y[ib] - st.x[ib]) || (st.x[ia] + st.y[ia]) - (st.x[ib] + st.y[ib]);
    });
    const items = new Float64Array(order.length * 4);
    order.forEach((k, j) => {
      const i = idx[k];
      const [ax, ay] = this._anchor(st.x[i], st.y[i], st.z[i]);
      items[j * 4] = st.key[i]; items[j * 4 + 1] = ax; items[j * 4 + 2] = ay; items[j * 4 + 3] = bright[k];
    });
    this.unitCount = order.length;
    this.drawn = idx;
    const before = this.deferred;
    this._fill("units", items, deadline);
    this.dirtyUnits = this.deferred > before;
  }

  // ---- phát lại -------------------------------------------------------------------------
  get speed() { return SPEEDS[this.speedIdx]; }

  seekR(r) {
    this.r = Math.max(0, Math.min(this.m.duration, r));
    this.needSeek = true;
  }

  setPersp(p) {
    this.persp = p;
    if (p !== null) this.lastTeam = p;
    this.dirtyFog = this.dirtyUnits = true;
    this._updateUi();
  }

  jumpMs(d) {                     // lùi / tới d ms giờ game
    const m = this.m, t = m.t;
    const target = t[Math.max(0, this.state.frame)] + d;
    let lo = 0, hi = m.frames - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (t[mid] <= target) lo = mid; else hi = mid - 1; }
    this.seekR(m.r[lo]);
    this.toast((d < 0 ? "Lùi " : "Tới ") + Math.abs(d / 1000) + " giây");
  }

  setSpeed(i) {
    this.speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, i));
    this._updateUi();
    this.toast("Tốc độ " + this.speed + "x");
  }

  _loop(now) {
    const dt = Math.min(0.25, (now - this._last) / 1000);
    this._last = now;
    if (this.playing) {
      this.r += dt * this.speed;
      if (this.r >= this.m.duration) {
        this.r = this.m.duration;
        // trận đang dựng dần: tới cuối phần đã dựng thì chờ (vẫn ở trạng thái phát), có thêm dữ liệu là chạy tiếp
        if (!this.m.meta.partial) { this.playing = false; this._updateUi(); }
      }
      this.needSeek = true;
    }
    if (this.follow) this._followCam();
    if (this.needSeek && !this.seeking) {
      this.needSeek = false;
      const fi = this.m.frameAtR(this.r);
      if (fi !== this.state.frame) {
        this.seeking = true;
        this.state.seek(fi).then(changed => {
          this.seeking = false;
          if (changed) { this.dirtyUnits = this.dirtyFog = true; }
        }).catch(e => { this.seeking = false; this._error(e); });
      }
    }
    const t0 = performance.now();
    const deadline = t0 + DECODE_BUDGET_MS;
    this.decodeLeft = DECODE_BUDGET_MS;
    this.deferred = 0;
    let rebuilt = false;
    if (this.dirtyFog) { this._buildFog(); this.dirtyFog = false; rebuilt = true; }
    const skey = this.state.sVersion + ":" + this.R.atlas.generation;
    if (this.dirtyStatics || skey !== this.lastStaticsKey) {
      this.lastStaticsKey = skey;
      this._rebuildStatics(deadline);
      rebuilt = true;
    }
    if (this.R.atlas.generation !== this.unitGen) { this.unitGen = this.R.atlas.generation; this.dirtyUnits = true; }
    if (this.dirtyUnits || this.dirtyStatics) { this._rebuildUnits(deadline); rebuilt = true; }
    if (rebuilt || this.needDraw) {
      this.R.draw(this.cam);
      this.needDraw = false;
      this.frameMs.push(performance.now() - t0);
      if (this.frameMs.length > 600) this.frameMs.shift();
    }
    if (this.ui) this._tickUi();
    requestAnimationFrame(t => this._loop(t));
  }

  _error(e) {
    console.error(e);
    if (this.opts.onError) this.opts.onError(e);
  }

  // ---- giao diện -----------------------------------------------------------------------
  _buildUi() {
    const M = this.m.meta, root = this.root;
    const q = s => root.querySelector(s);
    const add = (cls, tag = "div", html = "") => {
      let el = q("." + cls.split(" ")[0]);
      if (!el) { el = document.createElement(tag); el.className = cls; root.appendChild(el); }
      el.innerHTML = html;
      return el;
    };
    this.ui = { time: q(".v-time"), play: q(".v-play"), speed: q(".v-speed"), seek: q(".v-seek"),
                persp: q(".v-persp"), ages: q(".v-ages"), top: q(".v-top"), bottom: q(".v-bottom"),
                build: q(".v-build") };
    const u = this.ui;
    u.tools = add("v-tools", "div", [["score", "Bảng"], ["techs", "Công nghệ"], ["mini", "Bản đồ"],
      ["auto", "Tự động"], ["follow", "Khoá"], ["fit", "Toàn cảnh"], ["hide", "Ẩn"], ["help", "?"]]
      .map(([a, t]) => `<button data-a="${a}">${t}</button>`).join(""));
    u.panels = add("v-panels");
    u.techs = document.createElement("div"); u.techs.className = "v-panel v-techs"; u.panels.appendChild(u.techs);
    u.score = document.createElement("div"); u.score.className = "v-panel v-score"; u.panels.appendChild(u.score);
    u.info = document.createElement("div"); u.info.className = "v-panel v-info"; u.panels.appendChild(u.info);
    u.mini = add("v-mini", "canvas");
    u.help = add("v-help");
    u.toast = add("v-toast");
    u.mark = add("v-mark");
    u.unhide = add("v-unhide", "button", "Hiện HUD");
    u.seek.max = 1000;
    u.play.onclick = () => this.togglePlay();
    u.speed.onclick = () => this.setSpeed(SPEEDS.indexOf(1));
    q(".v-slow").onclick = () => this.setSpeed(this.speedIdx - 1);
    q(".v-fast").onclick = () => this.setSpeed(this.speedIdx + 1);
    q(".v-jb").onclick = () => this.jumpMs(-JUMP_MS);
    q(".v-jf").onclick = () => this.jumpMs(JUMP_MS);
    u.seek.oninput = () => { this.seekR(u.seek.value / 1000 * this.total); this.scrubbing = true; };
    u.seek.onchange = () => { this.scrubbing = false; };
    u.tools.onclick = e => { const b = e.target.closest("button"); if (b) this.action(b.dataset.a); };
    u.unhide.onclick = () => this.action("hide");
    u.help.onclick = () => this.action("help");
    u.help.innerHTML = this._helpHtml();
    // tầm nhìn: Toàn bản đồ, Đội 1, Đội 2...
    u.persp.innerHTML = "";
    const opts = [[null, "Toàn map"]];
    M.teams.forEach((t, k) => opts.push([k, "Đội " + (k + 1)]));
    for (const [p, label] of opts) {
      const b = document.createElement("button");
      b.textContent = label;
      b.dataset.p = p === null ? "" : p;
      if (p !== null) {
        const dots = M.teams[p].players.map(i => M.players.find(x => x.index === i)).filter(Boolean)
          .map(pl => `<i style="background:${pl.color}"></i>`).join("");
        b.innerHTML = `${dots}<span>${label}</span>`;
      }
      b.onclick = () => this.setPersp(p);
      u.persp.appendChild(b);
    }
    this._drawAges();
    // bảng: chạm vào hàng người chơi = chọn; nút đổi kinh tế / quân sự; ô lệnh = xem tên + giá
    u.panels.onclick = e => {
      const t = e.target.closest("[data-pl],[data-team],[data-x],[data-cmd],[data-close]");
      if (!t) return;
      if (t.dataset.team !== undefined) { this.setPersp(+t.dataset.team); this._renderHud(); }
      else if (t.dataset.pl) {             // chạm người chơi: chọn + tới nhà chính + xem tầm nhìn đội của người đó
        const idx = +t.dataset.pl;
        const k = this.m.meta.teams.findIndex(tm => tm.players.includes(idx));
        if (k >= 0 && this.persp !== k && t.closest(".v-score")) this.setPersp(k);
        this.selectPlayer(idx);
      }
      else if (t.dataset.x !== undefined) { this.scoreMode = +t.dataset.x; this._renderHud(); }
      else if (t.dataset.cmd !== undefined) { const c = this._cmd[+t.dataset.cmd]; if (c) this.toast(c.name + (c.cost ? ` (${c.cost})` : "")); }
      else if (t.dataset.close === "info") this.selectUnit(null);
      else this.action(t.dataset.close);
    };
    u.mini.addEventListener("pointerdown", e => this._miniPointer(e));
    u.mini.addEventListener("pointermove", e => { if (e.buttons) this._miniPointer(e); });
    this._buildMinimap();
    if (!this.hud.ok) this.toast("Trận này chưa có bảng thông số: cập nhật AoE-MapCap trên máy tính (v17 trở lên), " +
      "rồi mở lại trận khi điện thoại kết nối được máy tính.", 6000);
    else this.toast("Chạm \"?\" để xem cách dùng", 3000);
    this._updateUi();
  }

  // vạch lên đời trên thanh thời gian (vẽ lại khi trận đang dựng có thêm dữ liệu)
  _drawAges() {
    const u = this.ui, M = this.m.meta;
    u.ages.innerHTML = "";
    const dur = this.total || 1;
    for (const [r, idx, age] of M.ages) {
      const pl = M.players.find(x => x.index === idx);
      const s = document.createElement("i");
      s.style.left = (r / dur * 100) + "%";
      s.style.background = pl ? pl.color : "#fff";
      s.title = `${pl ? pl.name : idx}: đời ${age}`;
      u.ages.appendChild(s);
    }
  }

  _helpHtml() {
    const rows = [
      ["Kéo / chụm 2 ngón", "di chuyển / zoom máy quay; chạm đúp: phóng to"],
      ["Chạm vào unit / nhà", "xem máu, công, giáp, tài nguyên, đang nghiên cứu, hàng đợi sinh và các nâng cấp còn làm được"],
      ["Khoá", "máy quay đi theo unit đang chọn (kéo bản đồ cũng bỏ khoá)"],
      ["Bảng", "bảng tỉ số: Kinh tế / Quân sự; chạm tên người chơi để chọn và bay tới nhà chính"],
      ["Công nghệ", "công nghệ đã xong (giờ xong) + đang nghiên cứu bao nhiêu % của người chơi đang chọn"],
      ["Bản đồ", "minimap: chạm / kéo để đưa máy quay tới"],
      ["Tự động", "máy quay tự tới nơi đang giao tranh; không có giao tranh thì xem nhà đang xây, dân đang làm việc. Tự kéo máy quay thì tắt"],
      ["Bảng → chạm đội / người chơi", "xem tầm nhìn của đội đó (chạm người chơi: tới nhà chính của họ)"],
      ["Toàn map / Đội", "tầm nhìn cả bản đồ hoặc của từng đội (sương mù)"],
      ["−15s / +15s", "lùi / tới 15 giây; − / + đổi tốc độ 0,25x … 16x, chạm số tốc độ: về 1x"],
      ["Ẩn", "ẩn toàn bộ HUD để xem trận"],
      ["Bàn phím", "P phát, −/=/0 tốc độ, Backspace/J lùi/tới, F1/F2/F3 tầm nhìn, V/F, O/X bảng, C công nghệ, " +
        "M minimap, H ẩn, L khoá, Home toàn cảnh, Space về nhà chính, 1–5 / Q–T chọn người chơi"],
    ];
    return `<div class="v-help-box"><b>Cách dùng</b>${rows.map(([k, d]) =>
      `<div class="hr"><span>${esc(k)}</span><em>${esc(d)}</em></div>`).join("")}<div class="hint">Chạm để đóng</div></div>`;
  }

  action(a) {
    const s = this.show;
    if (a === "score" || a === "techs" || a === "mini" || a === "help" || a === "hide") s[a] = !s[a];
    else if (a === "auto") this.setAutoCam(!this.autoCam);
    else if (a === "follow") {
      this._takeCamera();
      if (this.follow) { this.follow = false; this.toast("Bỏ khoá máy quay"); }
      else if (this.sel && this.sel.kind === "u") { this.follow = true; this.toast("Khoá máy quay theo unit đang chọn"); }
      else this.toast("Chạm chọn một unit trước để khoá máy quay");
    } else if (a === "fit") { this._takeCamera(); this.follow = false; this.fitView(); }
    if (a === "techs" && s.techs && this.selected == null) this.selected = (this.m.meta.players[0] || {}).index;
    this._updateUi();
    this._renderHud();
  }

  togglePlay() {
    if (this.r >= this.m.duration && !this.m.meta.partial) this.r = 0;
    this.playing = !this.playing;
    this._updateUi();
  }

  toast(text, ms = 1600) {
    const t = this.ui && this.ui.toast;
    if (!t) return;
    t.textContent = text; t.hidden = false;
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { t.hidden = true; }, ms);
  }

  _updateUi() {
    const u = this.ui;
    if (!u) return;
    const s = this.show;
    u.play.textContent = this.playing ? "❚❚" : "▶";
    u.speed.textContent = String(this.speed).replace(".", ",") + "x";
    for (const b of u.persp.children) b.classList.toggle("on", b.dataset.p === (this.persp === null ? "" : String(this.persp)));
    for (const b of u.tools.children) {
      const a = b.dataset.a;
      b.classList.toggle("on", a === "follow" ? this.follow : a === "auto" ? this.autoCam : !!s[a]);
    }
    for (const el of [u.top, u.bottom, u.tools, u.panels]) el.hidden = s.hide;
    u.mini.hidden = s.hide || !s.mini;
    u.unhide.hidden = !s.hide;
    u.help.hidden = !s.help;
    u.score.hidden = !s.score;
    u.techs.hidden = !s.techs;
    u.info.hidden = !this.sel;
  }

  _tickUi() {
    const u = this.ui;
    const fi = Math.max(0, this.state.frame);
    const txt = fmtClock(this.m.t[fi]);
    if (u.time.textContent !== txt) u.time.textContent = txt;
    if (!this.scrubbing) u.seek.value = Math.round(this.r / (this.total || 1) * 1000);
    if (u.build) {                 // trận đang dựng dần: tiến độ; phát tới cuối phần đã dựng thì báo đang chờ
      const b = this.m.meta.partial ? this.build : null;
      const wait = b && this.playing && this.r >= this.m.duration;
      const bt = b ? (wait ? "Chờ dựng tiếp… " : "Đang dựng trận ") + Math.round((b.now ?? b.pos) * 100) + "%" : "";
      if (u.build.textContent !== bt) { u.build.textContent = bt; u.build.hidden = !bt; }
    }
    const now = performance.now();
    const want = this.show.score || this.show.techs || this.sel || this.autoCam;
    if (want && !this._hudBusy && (fi !== this._hudFrame || this._hudDirty) && now - (this._hudT || 0) >= HUD_MS) {
      this._hudBusy = true; this._hudT = now; this._hudDirty = false;
      this._refreshHud(fi).catch(e => console.warn(e)).finally(() => { this._hudBusy = false; });
    }
    this._placeMark();
    if (!u.mini.hidden && now - (this._miniT || 0) > 250) { this._miniT = now; this._drawMinimap(); }
  }

  async _refreshHud(fi) {
    const hs = await this.hud.at(fi);
    this.hudStatics = await this.hud.statics(this.state.sIdx);
    this.hs = hs;
    this._hudFrame = fi;
    if (this.autoCam && hs) this._director(hs);
    this._renderHud();
  }

  // ---- máy quay tự động (như phím A của trình xem máy tính) -----------------------------------------------
  // Luôn khoá theo một unit trong tầm nhìn đang xem: nơi đang giao tranh (unit / nhà mất máu, unit chết) -> công trình
  // lớn đang xây -> nhà (House) đang xây -> dân đang làm việc. Tự kéo máy quay / chạm chọn unit thì tắt.
  setAutoCam(on) {
    this.autoCam = !!on;
    this._dir = { hp: new Map(), heat: new Map(), t: -1, lockAt: 0, rank: -1, uid: null, label: "" };
    if (on) { this._hudT = 0; this._hudDirty = true; }
    this.toast(on ? "Máy quay tự động: BẬT (giao tranh → xây nhà → dân làm việc)" : "Máy quay tự động: tắt", 2200);
    this._updateUi();
  }

  _takeCamera() { if (this.autoCam) this.setAutoCam(false); }

  _dirLock(uid, owner, rank, label) {
    const D = this._dir;
    if (D.uid !== uid) {
      this.sel = { kind: "u", uid, owner };
      this.follow = true;
      this.cam.zoom = Math.max(this.cam.zoom, 0.55 * this.dpr);
      this._hudDirty = true;
      if (D.label !== label) this.toast("Tự động: " + label, 1400);
    }
    D.uid = uid; D.rank = rank; D.label = label; D.lockAt = performance.now();
  }

  _director(hs) {
    const D = this._dir, st = this.state, H = this.hud.H;
    if (!H) return;
    const tms = this.m.t[Math.max(0, st.frame)];
    if (D.t < 0 || tms < D.t || tms - D.t > 6000) { D.hp = new Map(); D.heat = new Map(); D.uid = null; D.rank = -1; }   // vừa tua
    D.t = tms;
    for (const [k, v] of D.heat) { const n = v * 0.7; if (n < 1) D.heat.delete(k); else D.heat.set(k, n); }
    const hp = new Map();
    const cellOf = i => Math.floor(st.x[i] / 6) * 4096 + Math.floor(st.y[i] / 6);
    const army = new Map(), any = new Map();        // ô -> unit đại diện (ưu tiên quân)
    let build = null, house = null;
    const workers = [];
    for (const i of this.drawn) {
      if (st.flags[i] & F_DOP) continue;
      const uid = st.uid[i], row = hs.units.get(uid);
      if (!row) continue;
      const def = H.defs[row[1]];
      if (!def) continue;
      const utype = def[1], cls = def[2], h = row[2], status = row[3];
      if (utype !== 70 && utype !== 80) continue;
      if (st.owner[i] <= 0) continue;
      hp.set(uid, h);
      const ph = D.hp.get(uid);
      const alive = status < 3 && h > 0;
      const c = cellOf(i);
      if (ph !== undefined && h < ph - 0.01) {
        const dmg = Math.min(ph - h, 60) * (utype === 70 ? 1 : 0.4) + (alive ? 0 : 25);
        D.heat.set(c, (D.heat.get(c) || 0) + dmg);
      }
      if (!alive) continue;
      if (utype === 70) {
        if (cls !== 4) { if (!army.has(c)) army.set(c, i); }
        else workers.push(i);
        if (!any.has(c)) any.set(c, i);
      } else if (status === 0 && ph !== undefined && h > ph + 0.01) {       // công trình đang xây (máu tăng dần)
        if (def[0] === 70) house = house ?? i; else build = build ?? i;
      }
    }
    D.hp = hp;
    // nơi nóng nhất còn unit để bám
    let best = null, bh = 12;
    for (const [c, v] of D.heat) if (v > bh && (army.has(c) || any.has(c))) { best = c; bh = v; }
    const now = performance.now();
    const curOk = D.uid !== null && st.pos.has(D.uid) && hp.has(D.uid) && (hs.units.get(D.uid) || [])[3] < 3;
    const held = now - D.lockAt;
    let pick = null;
    if (best !== null) pick = [army.get(best) ?? any.get(best), 4, "giao tranh"];
    else if (build !== null) pick = [build, 3, "công trình đang xây"];
    else if (house !== null) pick = [house, 2, "nhà đang xây"];
    else if (workers.length) pick = [workers[Math.floor(Math.random() * workers.length)], 1, "dân làm việc"];
    if (!pick) return;
    const [i, rank, label] = pick;
    // đổi mục tiêu: mục tiêu cũ mất; hoặc việc quan trọng hơn sau 2 s; hoặc cùng / kém quan trọng sau 8 s (giao tranh: 4 s)
    const cur = D.uid !== null ? st.pos.get(D.uid) : undefined;
    const sameCell = rank === 4 && cur !== undefined && cellOf(cur) === best;
    if (curOk && sameCell) { D.rank = 4; D.label = label; return; }
    if (curOk && !(rank > D.rank ? held > 2000 : held > (D.rank === 4 ? 4000 : 8000))) return;
    this._dirLock(st.uid[i], st.owner[i], rank, label);
  }

  _renderHud() {
    const u = this.ui, hs = this.hs, M = this.m.meta;
    if (!u) return;
    this._updateUi();
    if (!this.hud.ok) {
      if (this.show.score || this.show.techs) u.score.innerHTML = `<div class="ph">Trận này chưa có bảng thông số: cập nhật AoE-MapCap trên máy tính (v17 trở lên) rồi mở lại trận khi điện thoại kết nối được máy tính.</div>`;
      return;
    }
    if (!hs) return;
    const tms = this.m.t[Math.max(0, this.state.frame)];
    const players = M.players;
    const ntech = idx => this.hud.done(idx, tms).length;
    if (this.show.score) {
      const cols = this.scoreMode === 0 ? ECO_COLS : MIL_COLS;
      const head = cols.map(([label]) => label.startsWith("res")
        ? `<th>${this.icons.res(+label.slice(3))}</th>` : `<th>${esc(label)}</th>`).join("");
      let body = "";
      const grouped = M.teams.some(t => t.players.length > 1);
      M.teams.forEach((t, k) => {
        if (grouped) body += `<tr class="team ${this.persp === k ? "on" : ""}" data-team="${k}"><td colspan="${cols.length + 1}">Đội ${k + 1}<em>${this.persp === k ? "đang xem tầm nhìn" : "chạm để xem tầm nhìn"}</em></td></tr>`;
        for (const idx of t.players) {
          const pl = players.find(p => p.index === idx);
          const p = hs.p[idx];
          if (!pl || !p) continue;
          const stt = statusOf(p);
          const civ = stt ? stt.toUpperCase() : ((M.civs || {})[idx] || "");
          body += `<tr data-pl="${idx}" class="${idx === this.selected ? "sel" : ""} ${stt === "thua" || stt === "đầu hàng" ? "lost" : ""}">` +
            `<td class="nm"><i style="background:${pl.color}"></i>${esc(pl.name)}<em class="${stt === "thắng" ? "win" : stt ? "lose" : ""}">${esc(civ)}</em></td>` +
            cols.map(([, key]) => `<td>${esc(scoreCell(p, key, ntech(idx)))}</td>`).join("") + `</tr>`;
        }
      });
      u.score.innerHTML = `<div class="ph"><b>Bảng tỉ số</b>
        <span class="tabs"><button data-x="0" class="${this.scoreMode === 0 ? "on" : ""}">Kinh tế</button><button data-x="1" class="${this.scoreMode === 1 ? "on" : ""}">Quân sự</button></span>
        <button data-close="score" class="x">✕</button></div><div class="sc"><table><tr><th></th>${head}</tr>${body}</table></div>`;
    }
    if (this.show.techs) {
      const idx = this.selected;
      const pl = players.find(p => p.index === idx);
      const chips = players.map(p => `<button data-pl="${p.index}" class="${p.index === idx ? "on" : ""}"><i style="background:${p.color}"></i>${esc(p.name)}</button>`).join("");
      let html = `<div class="ph"><b>Công nghệ</b><button data-close="techs" class="x">✕</button></div><div class="chips">${chips}</div>`;
      if (pl) {
        const res = (hs.r[idx] || []).map(([tid, pm]) => {
          const T = this.hud.H.techs[tid] || ["#" + tid, -1];
          return `<div class="prog">${this.icons.tech(T[1], T[0])}<div><span>${esc(T[0])}  <b>${Math.floor(pm / 10)}%</b></span>
            <div class="pbar"><i style="width:${pm / 10}%"></i></div></div></div>`;
        }).join("");
        const done = this.hud.done(idx, tms);
        const grid = done.map(([tid, ms]) => {
          const T = this.hud.H.techs[tid] || ["#" + tid, -1];
          return `<div class="tc" title="${esc(T[0])}">${this.icons.tech(T[1], T[0])}<span>${fmtMs(ms)}</span></div>`;
        }).join("");
        html += res ? `<div class="sub">Đang nghiên cứu</div>${res}` : "";
        html += `<div class="sub">Đã xong (${done.length})</div>` + (grid ? `<div class="grid">${grid}</div>` : `<div class="muted">(chưa có)</div>`);
        html += `<div class="muted">Chạm vào một nhà để xem các nâng cấp còn làm được ở nhà đó.</div>`;
      }
      u.techs.innerHTML = html;
    }
    this._renderInfo();
  }

  _renderInfo() {
    const u = this.ui;
    if (!this.sel) { u.info.innerHTML = ""; return; }
    if (!this.hud.ok || !this.hs) return;
    const I = unitInfo(this, this.sel, this.hs);
    if (I.gone) { u.info.innerHTML = `<div class="ph"><b>(unit không còn)</b><button data-close="info" class="x">✕</button></div>`; return; }
    const ic = I.iconId >= 0 ? this.icons.unit(I.iconId, I.utype, I.colorId, I.age, I.name) : "";
    let h = `<div class="ph">${ic}<div class="nm"><b>${esc(I.name)}</b><span style="color:${I.color}">${esc(I.owner)}</span></div>` +
      `<button data-close="info" class="x">✕</button></div>`;
    if (I.hp) {
      const f = I.hp[1] ? Math.max(0, Math.min(1, I.hp[0] / I.hp[1])) : 0;
      h += `<div class="hp"><div class="pbar ${f < 0.35 ? "low" : ""}"><i style="width:${f * 100}%"></i></div><span>${Math.ceil(I.hp[0])} / ${Math.round(I.hp[1])}</span></div>`;
    }
    if (I.rows.length) h += `<div class="stats">${I.rows.map(([k, l, v]) =>
      `<span>${k ? this.icons.stat(k) : ""}<em>${esc(l)}</em> ${esc(v)}</span>`).join("")}</div>`;
    if (I.res) h += `<div class="line">${this.icons.res(I.res[0])} ${esc(I.res[1])}</div>`;
    for (const [name, frac, icon] of I.progress) {
      h += `<div class="prog">${this.icons.tech(icon, name)}<div><span>Nghiên cứu: ${esc(name)} <b>${Math.floor(frac * 100)}%</b></span>
        <div class="pbar"><i style="width:${frac * 100}%"></i></div></div></div>`;
    }
    if (I.queue) {
      const Q = I.queue;
      h += `<div class="prog">${Q.icon >= 0 ? this.icons.unit(Q.icon, Q.utype, I.colorId, I.age, Q.name) : ""}<div><span>Đang sinh: ${esc(Q.name)} <b>${Math.floor(Q.frac * 100)}%</b> · hàng đợi ${Q.count}</span>
        <div class="pbar"><i style="width:${Q.frac * 100}%"></i></div></div></div>`;
    }
    this._cmd = I.cmd || [];
    if (I.cmd && I.cmd.length) {
      h += `<div class="sub">Làm được ở nhà này (chạm để xem tên, giá)</div><div class="cmd">${I.cmd.map((c, k) =>
        `<button data-cmd="${k}" class="${c.kind}">${c.kind === "tech" ? this.icons.tech(c.icon, c.name)
          : this.icons.unit(c.icon, c.utype, I.colorId, I.age, c.name)}</button>`).join("")}</div>`;
    }
    for (const l of I.lines) h += `<div class="muted">${esc(l)}</div>`;
    u.info.innerHTML = h;
  }

  // ---- chọn unit / người chơi ------------------------------------------------------------
  _screenOf(x, y, z) {
    const [ax, ay] = this._anchor(x, y, z);
    const c = this.cam;
    return [(ax - c.x) * c.zoom + this.canvas.width / 2, (ay - c.y) * c.zoom + this.canvas.height / 2];
  }

  _pick(sx, sy) {
    const st = this.state, z = this.cam.zoom, dpr = this.dpr;
    let best = null, bd = Infinity;
    const consider = (kind, uid, x, y, zz, owner, flags) => {
      const [X, Y] = this._screenOf(x, y, zz);
      const bld = (flags & F_BLD) !== 0;
      const cy = Y - (bld ? 28 : 16) * z;
      const lim = Math.max((bld ? 26 : 18) * dpr, (bld ? 60 : 22) * z);
      const d = Math.hypot(sx - X, sy - cy) * (bld ? 1.4 : 1) * (kind === "s" ? 1.2 : 1);
      if (d < lim * (bld ? 1.4 : 1) * (kind === "s" ? 1.2 : 1) && d < bd) { bd = d; best = { kind, uid, owner }; }
    };
    for (const i of this.drawn) consider("u", st.uid[i], st.x[i], st.y[i], st.z[i], st.owner[i], st.flags[i]);
    for (const uid of this.drawnS) {
      const r = st.statics.get(uid);
      if (r) consider("s", uid, r[1], r[2], r[3], r[4], r[5]);
    }
    return best;
  }

  selectUnit(sel) {
    this.sel = sel;
    this.follow = !!(sel && sel.kind === "u");
    this._hudDirty = true;
    this._hudT = 0;
    this._updateUi();
    this._renderInfo();
  }

  _unitPos(sel) {
    const st = this.state;
    if (sel.kind === "u") {
      const i = st.pos.get(sel.uid);
      return i !== undefined && st.valid[i] ? [st.x[i], st.y[i], st.z[i]] : null;
    }
    const r = st.statics.get(sel.uid);
    return r ? [r[1], r[2], r[3]] : null;
  }

  _followCam() {
    const p = this.sel && this._unitPos(this.sel);
    if (!p) return;
    const [ax, ay] = this._anchor(...p);
    if (Math.abs(ax - this.cam.x) + Math.abs(ay - this.cam.y) > 0.5) { this.cam.x = ax; this.cam.y = ay; this._clamp(); }
  }

  _placeMark() {
    const mk = this.ui.mark;
    const p = this.sel && !this.show.hide ? this._unitPos(this.sel) : null;
    if (!p) { if (!mk.hidden) mk.hidden = true; return; }
    const [X, Y] = this._screenOf(...p);
    mk.hidden = false;
    mk.style.transform = `translate(${X / this.dpr}px, ${Y / this.dpr}px)`;
  }

  selectPlayer(idx) {
    this.selected = idx;
    const pl = this.m.meta.players.find(p => p.index === idx);
    this.toast("Đang chọn: " + (pl ? pl.name : idx));
    this.flyHome(idx);
    this._renderHud();
  }

  // nhà chính (Town Center) của người chơi, không có thì trọng tâm unit của họ
  flyHome(idx) {
    const st = this.state, H = this.hud.H, hs = this.hs;
    let tc = null;
    const xs = [], ys = [], zs = [];
    for (let i = 0; i < st.cap; i++) {
      if (!st.valid[i] || st.owner[i] !== idx || (st.flags[i] & (F_DOP | F_HIDE))) continue;
      xs.push(st.x[i]); ys.push(st.y[i]); zs.push(st.z[i]);
      const row = hs && hs.units.get(st.uid[i]);
      if (H && row && H.defs[row[1]] && TC_DAT.has(H.defs[row[1]][0])) { tc = [st.x[i], st.y[i], st.z[i]]; break; }
    }
    if (!tc && xs.length) {
      const med = a => [...a].sort((p, q) => p - q)[a.length >> 1];
      tc = [med(xs), med(ys), med(zs)];
    }
    if (!tc) return;
    this.follow = false;
    const [ax, ay] = this._anchor(...tc);
    this.cam.x = ax; this.cam.y = ay;
    this.cam.zoom = Math.max(this.cam.zoom, 0.5 * this.dpr);
    this._clamp();
  }

  // ---- minimap ---------------------------------------------------------------------------
  async _buildMinimap() {
    const M = this.m.meta, c = this.ui.mini;
    const w = 168, h = Math.round(w * M.full_h / M.full_w);
    const k = Math.min(this.dpr, 2);
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.style.width = w + "px"; c.style.height = h + "px";
    const bg = document.createElement("canvas");
    bg.width = c.width; bg.height = c.height;
    const g = bg.getContext("2d");
    const T = M.terrain, sx = bg.width / T.w, sy = bg.height / T.h;
    try {
      for (const t of T.tiles) {
        const im = await createImageBitmap(new Blob([this.m.section(t.section)], { type: "image/jpeg" }));
        g.drawImage(im, t.x * sx, t.y * sy, t.w * sx, t.h * sy);
        im.close && im.close();
      }
    } catch (e) { console.warn("minimap", e); }
    this.miniBg = bg;
  }

  _drawMinimap() {
    const c = this.ui.mini, g = c.getContext("2d"), M = this.m.meta;
    const W = c.width, H = c.height, kx = W / M.full_w, ky = H / M.full_h;
    g.clearRect(0, 0, W, H);
    if (this.miniBg) g.drawImage(this.miniBg, 0, 0);
    g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(0, 0, W, H);
    const st = this.state;
    const col = {};
    for (const p of M.players) col[p.index] = p.color;
    const r = Math.max(1.5, W / 110);
    for (const i of this.drawn) {
      const o = st.owner[i];
      if (!o || !col[o]) continue;
      const [ax, ay] = this._anchor(st.x[i], st.y[i], 0);
      g.fillStyle = col[o];
      const big = (st.flags[i] & F_BLD) ? 1.8 : 1;
      g.fillRect(ax * kx - r * big / 2, ay * ky - r * big / 2, r * big, r * big);
    }
    const cm = this.cam, cw = this.canvas.width / cm.zoom, ch = this.canvas.height / cm.zoom;
    g.strokeStyle = "#fff"; g.lineWidth = Math.max(1, W / 170);
    g.strokeRect((cm.x - cw / 2) * kx, (cm.y - ch / 2) * ky, cw * kx, ch * ky);
  }

  _miniPointer(e) {
    const c = this.ui.mini, M = this.m.meta;
    const r = c.getBoundingClientRect();
    this._takeCamera();
    this.follow = false;
    this.cam.x = (e.clientX - r.left) / r.width * M.full_w;
    this.cam.y = (e.clientY - r.top) / r.height * M.full_h;
    this._clamp();
    this._miniT = 0;
    e.preventDefault();
  }

  // ---- nhập liệu -------------------------------------------------------------------------
  _bindInput() {
    const c = this.canvas;
    const pts = new Map();
    let pinch = null, lastTap = 0, down = null;
    c.addEventListener("pointerdown", e => {
      c.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      down = pts.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now(), moved: false } : null;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: this.cam.zoom };
      }
      const now = performance.now();
      if (pts.size === 1 && now - lastTap < 300) {               // chạm đúp: phóng to 2 lần quanh điểm chạm
        const r = c.getBoundingClientRect();
        this.zoomAt(2, (e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr);
        down = null;
      }
      lastTap = now;
    });
    c.addEventListener("pointermove", e => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) down.moved = true;
      if (down && !down.moved) return;
      const prev = [...pts.values()];
      const mid0 = prev.reduce((s, q) => [s[0] + q[0] / prev.length, s[1] + q[1] / prev.length], [0, 0]);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      const cur = [...pts.values()];
      const mid1 = cur.reduce((s, q) => [s[0] + q[0] / cur.length, s[1] + q[1] / cur.length], [0, 0]);
      const z = this.cam.zoom / this.dpr;
      this._takeCamera();
      this.follow = false;                                        // tự kéo máy quay: bỏ khoá
      this.cam.x -= (mid1[0] - mid0[0]) / z;
      this.cam.y -= (mid1[1] - mid0[1]) / z;
      if (pinch && pts.size === 2) {
        const [a, b] = cur;
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const r = c.getBoundingClientRect();
        const f = (pinch.zoom * d / pinch.d) / this.cam.zoom;
        this.zoomAt(f, (mid1[0] - r.left) * this.dpr, (mid1[1] - r.top) * this.dpr);
      }
      this._clamp();
    });
    const up = e => {
      if (down && !down.moved && pts.size === 1 && e.type === "pointerup" && performance.now() - down.t < 400) {
        const r = c.getBoundingClientRect();
        const hit = this._pick((e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr);
        // chạm chỗ trống: bỏ chọn (chờ xem có phải chạm đúp không)
        if (hit) { this._takeCamera(); this.selectUnit(hit); }
        else setTimeout(() => { if (performance.now() - lastTap >= 290 && this.sel && !this.autoCam) this.selectUnit(null); }, 300);
      }
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      down = null;
      if (this._updateUi) this._updateUi();
    };
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener("wheel", e => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.zoomAt(Math.pow(1.0015, -e.deltaY), (e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr);
    }, { passive: false });
    const M = this.m.meta;
    const selKeys = {};
    if (M.teams.length === 2 && M.teams.every(t => t.players.length <= 5)) {
      M.teams[0].players.forEach((p, k) => { selKeys["12345"[k]] = p; });
      M.teams[1].players.forEach((p, k) => { selKeys["qwert"[k]] = p; });
    } else M.players.slice(0, 8).forEach((p, k) => { selKeys[String(k + 1)] = p.index; });
    window.addEventListener("keydown", e => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key, K = k.length === 1 ? k.toLowerCase() : k;
      const fk = { F1: 0, F2: 1, F4: 2, F5: 3, F6: 4, F7: 5, F8: 6 };
      let used = true;
      if (K === "p") this.togglePlay();
      else if (K === "-" || K === "_") this.setSpeed(this.speedIdx - 1);
      else if (K === "=" || K === "+") this.setSpeed(this.speedIdx + 1);
      else if (K === "0") this.setSpeed(SPEEDS.indexOf(1));
      else if (K === "Backspace") this.jumpMs(-JUMP_MS);
      else if (K === "j") this.jumpMs(JUMP_MS);
      else if (K === "F3") this.setPersp(null);
      else if (K in fk) { if (fk[K] < M.teams.length) this.setPersp(fk[K]); }
      else if (K === "v") { const seq = [null, ...M.teams.map((_, i) => i)]; this.setPersp(seq[(seq.indexOf(this.persp) + 1) % seq.length]); }
      else if (K === "f") this.setPersp(this.persp === null ? this.lastTeam : null);
      else if (K === " ") { if (this.selected != null) this.flyHome(this.selected); }
      else if (K in selKeys) this.selectPlayer(selKeys[K]);
      else if (K === "o") this.action("score");
      else if (K === "x") { this.scoreMode = 1 - this.scoreMode; this.show.score = true; this._renderHud(); }
      else if (K === "c") this.action("techs");
      else if (K === "m") this.action("mini");
      else if (K === "h") this.action("hide");
      else if (K === "l") this.action("follow");
      else if (K === "a") this.action("auto");
      else if (K === "Home") this.action("fit");
      else if (K === "?" || K === "/" || K === "Escape") this.action("help");
      else used = false;
      if (used) e.preventDefault();
    });
  }

  // ---- tự kiểm tra: tua nhiều chỗ, đo thời gian dựng + vẽ -----------------------------------
  async selftest() {
    const out = { frames: this.m.frames, units: [], seekMs: [], buildMs: [] };
    const dur = this.m.duration;
    for (const frac of [0.1, 0.35, 0.6, 0.9]) {
      const t0 = performance.now();
      await this.state.seek(this.m.frameAtR(dur * frac));
      out.seekMs.push(+(performance.now() - t0).toFixed(1));
      this.dirtyUnits = this.dirtyFog = true;
      // dựng tới khi hết sprite chờ giải mã
      for (let k = 0; k < 40 && (this.dirtyUnits || this.dirtyStatics || this.dirtyFog); k++) {
        const t1 = performance.now();
        this.deferred = 0;
        this.decodeLeft = Infinity;
        if (this.dirtyFog) { this._buildFog(); this.dirtyFog = false; }
        this._rebuildStatics(t1 + 1e9);
        this._rebuildUnits(t1 + 1e9);
        this.R.draw(this.cam);
        out.buildMs.push(+(performance.now() - t1).toFixed(1));
      }
      out.units.push(this.unitCount);
    }
    // phát x8 trong 3 s: đo khung
    this.frameMs = [];
    this.speedIdx = SPEEDS.indexOf(8); this.playing = true;
    await new Promise(r => setTimeout(r, 3000));
    this.playing = false;
    const f = [...this.frameMs].sort((a, b) => a - b);
    out.play = { n: f.length, median: f[f.length >> 1], p95: f[Math.floor(f.length * 0.95)] };
    out.atlasLayers = this.R.atlas.layer + 1;
    return out;
  }
}
