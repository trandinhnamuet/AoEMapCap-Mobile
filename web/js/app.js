// Màn hình danh sách trận + mở trình xem. Ba cách chạy:
// - trình duyệt mở thẳng máy chủ AoE-MapCap trên máy tính (http://<ip>:8765/<mã>/): nguồn là chính máy chủ đó;
// - app Android: trang nằm trong app (https://appassets.androidplatform.net/app/). Ghép đôi bằng quét mã QR trên app
//   Windows (AoEApp.scanQr), mở app từ trình duyệt (aoemapcap://pair -> ?pair=) hoặc nhập tay địa chỉ mạng nhà. Mã QR
//   có r = phòng trên trạm chuyển tiếp và l = địa chỉ mạng nhà. Lấy dữ liệu: thử mạng nhà trước (app chuyển tiếp
//   /pc/<ip:cổng>/<mã>/... sang http://<ip:cổng>/<mã>/...), không được thì qua trạm (Relay, relay/src/index.js);
// - trình duyệt mở trang trên trạm (quét mã QR bằng camera thường, https://<trạm>/#r=...): chỉ qua trạm (trang https
//   không gọi được http trong mạng nhà).
// Trong app và trên trạm, gói hình và trận đã mở được lưu trên điện thoại (Cache Storage) để xem khi máy tính tắt.
//
// Mở một trận chưa lưu (từ v7): máy tính chỉ gửi file ghi trận gốc (api/rec) + một lần gói hình (api/sprites) và gói dữ
// liệu game (api/gamedata); điện thoại tự dựng trong luồng nền (rec/live.js) và phát ngay phần đã dựng. Máy tính bản cũ
// (trước v38, không có api/gamedata) hoặc máy không chạy được luồng nền: cách cũ - máy tính chuyển sẵn (api/match).
import { LiveBuild } from "./rec/live.js";
import { SpritePack } from "./sprites.js";
import { fmtClock, Viewer } from "./viewer.js";

const IN_APP = location.hostname === "appassets.androidplatform.net";
const CLOUD = !IN_APP && location.protocol === "https:";      // trang trên trạm chuyển tiếp
const PAIRED = IN_APP || CLOUD;                                // ghép đôi + lưu trận trên điện thoại
const PC_KEY = "aoe.pc";
const ROOM_KEY = "aoe.room";
const MAX_SAVED = 40;           // số trận giữ trên điện thoại, bỏ trận mở lâu nhất
const MAX_SAVED_BYTES = 500e6;  // và tổng dung lượng trận đã lưu (máy ít bộ nhớ không bị đầy); trận vừa mở luôn giữ
const SIZE_GUESS = 20e6;        // trận lưu từ bản trước chưa ghi cỡ
const WEB_VERSION = 2;          // .aoeweb có bảng thông số (mapcap/webexport.py); trận lưu bản cũ thì lấy lại khi được
const GAMEDATA_KEY = "/s/gamedata1";   // gói dữ liệu game phiên bản 1 (mapcap/webexport.py GAMEDATA_VERSION)
const REPO = "trandinhnamuet/AoEMapCap-Mobile";
const APP_PKG = "io.github.trandinhnamuet.aoemapcap";
const RELEASES = `https://github.com/${REPO}/releases`;
const RELAY = CLOUD ? location.origin : "https://aoe-mapcap-relay.aoemapcap.workers.dev";
const CREDIT = 16;              // số khung 64 KB máy tính được gửi trước khi điện thoại nhận (trạm chỉ giữ tạm ~1 MB)
const OFFLINE = "Máy tính chưa sẵn sàng: mở AoE-MapCap trên máy tính, bật mục Điện thoại và kiểm tra Internet.";
const PC_BACK_MS = 10000;       // máy tính vừa rớt khỏi trạm (mạng chập chờn) thường nối lại sau 2-3 s: chờ rồi mới báo lỗi
const HEAD_MS = 90000;          // yêu cầu qua trạm không có khung nào: coi như mất (máy tính rớt giữa chừng), hỏi lại
const RETRY_MS = 120000;        // chờ máy tính chuẩn bị / tải trận: lỗi kết nối liên tiếp quá lâu mới báo lỗi
const fatal = e => { e.fatal = true; return e; };     // lỗi không thử lại (máy tính trả lỗi rõ ràng)
const sleep = ms => new Promise(res => setTimeout(res, ms));
// tiến độ tải: % khi biết tổng dung lượng, không thì số MB đã nhận (WebView có lúc không đưa Content-Length)
const pct = (f, got) => f === null || f === undefined ? (got / 1e6).toFixed(1).replace(".", ",") + " MB" : Math.round(f * 100) + "%";
const mark = k => { const T = window.aoeTimes; if (T) T[k] = Math.round(performance.now() - T.t0); };   // đo các bước mở trận

// bản app Android mới nhất: Release "latest" của repo app (tag v<N>, N = versionCode); null nếu không hỏi được
async function latestApp() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!r.ok) return null;
    const rel = await r.json();
    const m = /^v(\d+)$/.exec(rel.tag_name || "");
    const apk = m && (rel.assets || []).find(a => a.name === "AoE-MapCap.apk");
    return apk ? { code: +m[1], url: apk.browser_download_url, tag: rel.tag_name } : null;
  } catch { return null; }
}

// trận + gói hình lưu trên máy (Cache Storage chỉ có ở trang https, tức là trong app)
class Store {
  static async open() {
    if (!self.caches) return null;
    try { return new Store(await caches.open("aoe-web-1")); } catch { return null; }
  }
  constructor(c) { this.c = c; }
  async get(key) {
    const r = await this.c.match(key);
    return r ? r.arrayBuffer() : null;
  }
  async put(key, buf) {
    try { await this.c.put(key, new Response(buf)); return true; }
    catch (e) { console.warn("không lưu được", key, e); return false; }
  }
  async saved() {               // [{file, info, at}] mới mở trước
    const out = [];
    for (const req of await this.c.keys()) {
      if (!new URL(req.url).pathname.startsWith("/i/")) continue;
      const r = await this.c.match(req);
      try { out.push(await r.json()); } catch { /* bỏ bản hỏng */ }
    }
    return out.sort((a, b) => b.at - a.at);
  }
  async saveMatch(file, buf, info) {
    const k = encodeURIComponent(file);
    if (!await this.put("/m/" + k, buf)) return;
    await this.put("/i/" + k, new TextEncoder().encode(JSON.stringify({ file, info, at: Date.now(), size: buf.byteLength })));
    let n = 0, total = 0;
    for (const e of await this.saved()) {          // mới mở trước: giữ tới khi quá số trận / dung lượng
      n++; total += e.size || SIZE_GUESS;
      if (n === 1 || (n <= MAX_SAVED && total <= MAX_SAVED_BYTES)) continue;
      const ok = encodeURIComponent(e.file);
      await this.c.delete("/m/" + ok); await this.c.delete("/i/" + ok);
    }
  }
  async touch(file) {
    const k = "/i/" + encodeURIComponent(file);
    const r = await this.c.match(k);
    if (!r) return;
    const j = await r.json(); j.at = Date.now();
    await this.put(k, new TextEncoder().encode(JSON.stringify(j)));
  }
}

// Kết nối qua trạm chuyển tiếp (khung tin xem relay/src/index.js và mapcap/relay_client.py).
// fetch(path) trả Response như fetch thường; thân đọc dần, mỗi 4 khung nhận được cấp thêm 4 tín dụng cho máy tính.
class Relay {
  constructor(room) {
    this.room = room; this.ws = null; this.ready = null; this.n = 0; this.pending = new Map(); this.pcOn = false;
    this.pcWait = [];             // hàm gọi khi máy tính kết nối lại
    this.pcSeen = false;          // máy tính đã online trong phiên này (rớt thì chờ nối lại; tắt hẳn từ đầu thì báo ngay)
  }
  _pcBack() { this.pcSeen = true; const w = this.pcWait; this.pcWait = []; for (const f of w) f(); }
  async _waitPc(ms) {
    if (this.pcOn) return;
    await new Promise(res => { const t = setTimeout(res, ms); this.pcWait.push(() => { clearTimeout(t); res(); }); });
  }
  _connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(RELAY.replace(/^http/, "ws") + "/r/" + this.room + "?role=phone");
      ws.binaryType = "arraybuffer";
      let ping = 0;
      const timer = setTimeout(() => { reject(new Error("không kết nối được trạm chuyển tiếp (Internet?)")); ws.close(); }, 15000);
      ws.onmessage = ev => {
        if (typeof ev.data !== "string") return this._frame(ev.data);
        if (ev.data === "pong") return;
        let j;
        try { j = JSON.parse(ev.data); } catch { return; }
        if (j.hello) {
          clearTimeout(timer);
          this.ws = ws; this.pcOn = !!j.pc;
          if (this.pcOn) this._pcBack();
          ping = setInterval(() => { try { ws.send("ping"); } catch { /* đang đóng */ } }, 25000);
          resolve(ws);
        } else if (j.pc === "on") { this.pcOn = true; this._pcBack(); }
        else if (j.pc === "off") { this.pcOn = false; this._failAll(new Error(OFFLINE)); }
        else if (j.err) this._fail(j.r, new Error(j.err === "pc-offline" ? OFFLINE : j.err));
      };
      ws.onclose = () => {
        clearTimeout(timer); clearInterval(ping);
        this.ws = null; this.ready = null;
        this._failAll(new Error("mất kết nối trạm chuyển tiếp"));
        reject(new Error("không kết nối được trạm chuyển tiếp (Internet?)"));
      };
    });
    return this.ready;
  }
  _send(o) { try { this.ws && this.ws.send(JSON.stringify(o)); } catch { /* đang đóng */ } }
  _fail(r, e) { const p = this.pending.get(r); if (p) p.fail(e); }
  _failAll(e) { for (const p of [...this.pending.values()]) p.fail(e); }
  _frame(buf) {
    if (buf.byteLength < 5) return;
    const dv = new DataView(buf);
    const p = this.pending.get(dv.getUint32(0, true));
    if (!p) return;
    const kind = dv.getUint8(4), body = buf.slice(5);
    if (kind === 1) p.head(JSON.parse(new TextDecoder().decode(body)));
    else if (kind === 2) p.data(body);
    else if (kind === 3) p.end();
    else p.fail(new Error(JSON.parse(new TextDecoder().decode(body)).error || "máy tính báo lỗi"));
  }
  async fetch(path) {
    await this._connect();
    if (!this.pcOn && this.pcSeen) await this._waitPc(PC_BACK_MS);
    if (!this.pcOn) throw new Error(OFFLINE);
    const r = ++this.n;
    return new Promise((resolve, reject) => {
      let ctl = null, got = 0, started = false, lost = 0;
      const arm = () => {           // không có khung nào quá HEAD_MS: máy tính rớt mà trạm chưa biết
        clearTimeout(lost);
        lost = setTimeout(() => {
          this._send({ r, x: 1 });
          this._fail(r, new Error("máy tính không trả lời qua trạm chuyển tiếp"));
        }, HEAD_MS);
      };
      arm();
      const done = () => { clearTimeout(lost); this.pending.delete(r); };
      const stream = new ReadableStream({
        start(c) { ctl = c; },
        cancel: () => { done(); this._send({ r, x: 1 }); },
      });
      this.pending.set(r, {
        head: h => {
          started = true;
          arm();
          const headers = { "Content-Type": h.type || "application/octet-stream" };
          if (h.size >= 0) headers["Content-Length"] = String(h.size);
          resolve(new Response(stream, { status: h.status || 200, headers }));
        },
        data: b => {
          arm();
          ctl.enqueue(new Uint8Array(b));
          if (++got % 4 === 0) this._send({ r, k: 4 });
        },
        end: () => { done(); ctl.close(); },
        fail: e => { done(); if (started) { try { ctl.error(e); } catch { /* đã đóng */ } } else reject(e); },
      });
      this._send({ r, p: path, k: CREDIT });
    });
  }
}

// phiên bản file .aoeweb (meta.version) đọc từ đầu file; 0 nếu không đọc được
function webVersion(buf) {
  try {
    const n = new DataView(buf).getUint32(8, true);
    const head = new TextDecoder().decode(new Uint8Array(buf, 12, Math.min(n, 64)));
    const m = /"version":\s*(\d+)/.exec(head);
    return m ? +m[1] : 0;
  } catch { return 0; }
}

function fetchTimeout(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { cache: "no-store", signal: ac.signal }).finally(() => clearTimeout(t));
}

// Nguồn trận. link: {base} (trang mở thẳng từ máy tính) | {lan, room} (app / trang trên trạm).
class Source {
  constructor(link, store) {
    this.link = link || {};
    this.store = store;
    this.relay = this.link.room ? new Relay(this.link.room) : null;
    this.via = null;            // "lan" | "relay": chọn ở lần gọi đầu
  }
  get linked() { return !!(this.link.base || this.link.lan || this.link.room); }
  async _pick() {
    if (this.link.lan && IN_APP) {
      try {
        const r = await fetchTimeout("/pc/" + this.link.lan + "/api/matches", this.relay ? 3000 : 15000);
        if (r.ok) return "lan";
        if (!this.relay) throw new Error("máy tính trả lỗi " + r.status);
      } catch (e) {
        if (!this.relay) throw new Error("không kết nối được " + this.link.lan + " (" + e.message + ")");
      }
    }
    if (this.relay) return "relay";
    throw new Error("chưa kết nối máy tính");
  }
  async fetch(path) {
    if (this.link.base) return fetch(this.link.base + path, { cache: "no-store" });
    if (!this.linked) throw new Error("chưa kết nối máy tính");
    if (!this.via) this.via = this._pick().catch(e => { this.via = null; throw e; });
    if ((await this.via) === "lan") {
      // app trả 502 khi không nối được máy tính: rời Wi-Fi nhà giữa chừng thì chuyển sang trạm
      let r = null;
      try { r = await fetch("/pc/" + this.link.lan + "/" + path, { cache: "no-store" }); }
      catch (e) { if (!this.relay) throw e; }
      if (r && (r.status !== 502 || !this.relay)) return r;
      this.via = Promise.resolve("relay");
    }
    return this.relay.fetch(path);
  }
  async list() {
    const r = await this.fetch("api/matches");
    if (!r.ok) throw new Error("máy tính trả lỗi " + r.status);
    return r.json();
  }
  // lỗi kết nối (máy tính rớt khỏi trạm, điện thoại đổi mạng): thử lại tới RETRY_MS rồi mới báo. Trước v5 lỗi
  // giữa chừng làm trang đứng mãi ở thông báo cuối ("đang chuẩn bị trận… 0%") hoặc báo lỗi phải mở lại trận.
  async _retry(fn, onStatus, on = true) {
    if (!on) return fn();
    let since = 0;
    for (;;) {
      try { return await fn(); }
      catch (e) {
        if (e.fatal) throw e;
        since = since || Date.now();
        if (Date.now() - since > RETRY_MS) throw e;
        onStatus && onStatus("Mất kết nối máy tính, đang thử lại… (" + e.message + ")");
        await sleep(2000);
      }
    }
  }
  async _download(path, onProgress) {
    const r = await this.fetch(path);
    if (!r.ok) { const e = new Error("tải lỗi " + r.status); e.status = r.status; throw r.status >= 502 ? e : fatal(e); }
    const total = +r.headers.get("Content-Length") || 0;
    const reader = r.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      if (onProgress) onProgress(total ? got / total : null, got);
    }
    return await new Blob(parts).arrayBuffer();
  }
  // máy tính chuyển trận sang .aoeweb lần đầu (vài chục giây): hỏi lại tới khi xong
  async _fetchMatch(file, onStatus, retry = true) {
    const url = "api/match?f=" + encodeURIComponent(file);
    for (;;) {
      const j = await this._retry(async () => {
        const r = await this.fetch(url + "&check=1");
        if (!r.ok) {
          const e = new Error("không kết nối được máy tính (" + r.status + ")");
          throw r.status >= 502 ? e : fatal(e);       // 502..504: đường chuyển tiếp lỗi, thử lại
        }
        return r.json();
      }, onStatus, retry);
      if (j.error) throw new Error(j.error);
      if (j.ready) break;
      onStatus && onStatus(j.waiting ? "Máy tính đang ghi trận: sẽ chuẩn bị trận này khi hết trận…"
        : j.ahead ? "Máy tính đang chuẩn bị một trận khác, xong sẽ tới trận này…"
        : "Máy tính đang chuẩn bị trận… " + Math.round((j.progress || 0) * 100) + "%");
      await sleep(1000);
    }
    return this._retry(() => this._download(url, (f, got) => onStatus && onStatus("Đang tải trận… " + pct(f, got))),
      onStatus, retry);
  }
  // bản đã lưu trên điện thoại (đủ phiên bản), null nếu chưa có
  async cached(file) {
    if (!this.store) return null;
    const b = await this.store.get("/m/" + encodeURIComponent(file));
    if (b && webVersion(b) >= WEB_VERSION) { this.store.touch(file); return b; }
    return null;
  }
  // gói dữ liệu game (một lần, lưu trên điện thoại); null nếu máy tính là bản cũ chưa có (404)
  async gamedata(onStatus) {
    if (this.store) {
      const b = await this.store.get(GAMEDATA_KEY);
      if (b) return b;
    }
    let buf;
    onStatus && onStatus("Đang tải dữ liệu game từ máy tính (một lần)…");
    try {
      buf = await this._retry(() => this._download("api/gamedata",
        (f, got) => onStatus && onStatus("Đang tải dữ liệu game từ máy tính (một lần)… " + pct(f, got))), onStatus);
    } catch (e) { if (e.status === 404) return null; throw e; }
    if (this.store) await this.store.put(GAMEDATA_KEY, buf);
    return buf;
  }
  // tải file ghi trận gốc rồi dựng ngay trên điện thoại (phát dần); null = không dùng được cách này (máy tính bản cũ,
  // máy không có luồng nền / OffscreenCanvas) -> người gọi dùng match() như trước
  async live(file, info, packBuf, onStatus) {
    if (!LiveBuild.supported()) return null;
    const gd = await this.gamedata(onStatus);
    if (!gd) return null;
    mark("gamedata");
    let rec;
    onStatus && onStatus("Đang tải trận…");
    try {
      rec = await this._retry(() => this._download("api/rec?f=" + encodeURIComponent(file),
        (f, got) => onStatus && onStatus("Đang tải trận… " + pct(f, got))), onStatus);
    } catch (e) { if (e.status === 404) return null; throw e; }
    mark("rec");
    onStatus && onStatus("Đang dựng trận trên điện thoại…");
    return new LiveBuild({ rec, sprites: packBuf.slice(0), gamedata: gd.slice(0), info, file,
      onProgress: p => onStatus && onStatus("Đang dựng trận trên điện thoại… " + Math.round(p.pos * 100) + "%") });
  }
  async match(file, info, onStatus) {
    let old = null;
    if (this.store) {
      const b = await this.store.get("/m/" + encodeURIComponent(file));
      if (b && webVersion(b) >= WEB_VERSION) { this.store.touch(file); return b; }
      old = b;                    // bản lưu cũ (chưa có bảng thông số): lấy lại từ máy tính nếu được
    }
    let buf;
    try { buf = await this._fetchMatch(file, onStatus, !old); }     // có bản lưu cũ: lỗi thì mở bản cũ ngay
    catch (e) { if (old) { this.store.touch(file); return old; } throw e; }
    if (old && webVersion(buf) < WEB_VERSION) { this.store.touch(file); return old; }   // máy tính chưa cập nhật
    if (this.store) await this.store.saveMatch(file, buf, info);
    return buf;
  }
  async sprites(onStatus) {
    if (this.store) {
      const b = await this.store.get("/s/sprites");
      if (b) return b;
    }
    onStatus && onStatus("Đang tải hình game từ máy tính (một lần)…");
    const buf = await this._retry(() => this._download("api/sprites",
      (f, got) => onStatus && onStatus("Đang tải hình game từ máy tính (một lần)… " + pct(f, got))), onStatus);
    if (this.store) await this.store.put("/s/sprites", buf);
    return buf;
  }
}

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
let packPromise = null;

function show(id) {
  for (const el of document.querySelectorAll(".screen")) el.hidden = el.id !== id;
}

function resultClass(res) {
  return res === "Thắng" ? "win" : (res === "Thua" || res === "Đầu hàng") ? "lose" : "";
}

// "192.168.1.5:8765/abc123", có hoặc không có http:// và dấu / cuối -> "192.168.1.5:8765/abc123"
function parseAddr(t) {
  const m = /^([\w.-]+)(?::(\d{1,5}))?\/([A-Za-z0-9_-]+)$/.exec(t.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, ""));
  return m ? `${m[1]}:${m[2] || 8765}/${m[3].toLowerCase()}` : null;
}

// Nội dung mã QR / liên kết ghép đôi -> {room, lan} hoặc null. Nhận:
//   https://<trạm>/#r=<phòng>&l=<ip:cổng/mã>, aoemapcap://pair?r=...&l=..., "r=...&l=..." (từ ?pair=),
//   mã QR cũ (v14) http://<ip:cổng>/<mã>/, địa chỉ mạng nhà nhập tay.
function parsePair(t) {
  t = String(t || "").trim();
  const r = /(?:^|[#?&])r=([a-z2-9]{20,40})(?:&|$)/i.exec(t);
  if (r) {
    const l = /(?:^|[#?&])l=([^&#]+)/.exec(t);
    let lan = null;
    try { lan = l ? parseAddr(decodeURIComponent(l[1])) : null; } catch { /* bỏ */ }
    return { room: r[1].toLowerCase(), lan };
  }
  const lan = parseAddr(t);
  return lan ? { room: null, lan } : null;
}

function savedLink() {
  return { lan: localStorage.getItem(PC_KEY), room: localStorage.getItem(ROOM_KEY) };
}

function saveLink(link) {
  for (const [k, v] of [[PC_KEY, link.lan], [ROOM_KEY, link.room]]) {
    if (v) localStorage.setItem(k, v); else localStorage.removeItem(k);
  }
}

// thử kết nối rồi lưu; tải lại trang để mọi phần dùng nguồn mới
async function connect(link, store) {
  const msg = $("#setup-msg");
  msg.textContent = "Đang kết nối máy tính…"; msg.className = "msg";
  try { await new Source(link, store).list(); }
  catch (err) {
    msg.textContent = "Không kết nối được máy tính (" + err.message + "). Kiểm tra: AoE-MapCap trên máy tính đang mở, " +
      "đã bật mục Điện thoại" + (link.room ? " và máy tính có Internet." : "; nhập tay địa chỉ thì phải cùng Wi-Fi.");
    msg.className = "msg err";
    return false;
  }
  saveLink(link);
  location.replace(location.pathname);
  return true;
}

function showSetup(store) {
  show("setup");
  const inp = $("#pc-addr"), msg = $("#setup-msg");
  inp.value = localStorage.getItem(PC_KEY) || "";
  msg.textContent = ""; msg.className = "msg";
  $("#setup-offline").hidden = !store;
  $("#setup-offline").onclick = () => showList(new Source(null, store));
  const app = window.AoEApp;
  $("#scan-qr").hidden = !(app && app.scanQr);
  $("#setup-camera").hidden = !CLOUD;
  $("#setup-manual").hidden = CLOUD;          // trang https trên trạm không gọi được địa chỉ http trong mạng nhà
  $("#scan-qr").onclick = () => {
    msg.textContent = "Đang mở máy quét…"; msg.className = "msg";
    // app gọi lại: (nội dung mã, null) | (null, lỗi) | (null, null) = huỷ
    window.onQrResult = (text, err) => {
      if (err) { msg.textContent = "Không quét được: " + err + ". Có thể nhập tay bên dưới."; msg.className = "msg err"; return; }
      if (text == null) { msg.textContent = ""; return; }
      const link = parsePair(text);
      if (!link) { msg.textContent = "Mã QR này không phải của AoE-MapCap."; msg.className = "msg err"; return; }
      if (link.lan) inp.value = link.lan;
      connect(link, store);
    };
    app.scanQr();
  };
  $("#setup-form").onsubmit = e => {
    e.preventDefault();
    const link = parsePair(inp.value);
    if (!link) { msg.textContent = "Địa chỉ dạng 192.168.1.5:8765/abc123"; msg.className = "msg err"; return; }
    if (!link.room) link.room = localStorage.getItem(ROOM_KEY);   // giữ phòng đã ghép (đổi địa chỉ mạng nhà)
    connect(link, store);
  };
}

// trình duyệt trên Android (quét QR bằng camera thường): mời tải / mở app (mở app thì app ghép đôi luôn)
async function appBanner(link) {
  if (!/Android/i.test(navigator.userAgent)) return;
  const q = link.room ? "r=" + link.room + (link.lan ? "&l=" + encodeURIComponent(link.lan) : "")
    : "a=" + encodeURIComponent(link.lan);
  const ban = $("#app-banner");
  const dl = $("#app-dl");
  dl.href = RELEASES;
  $("#app-open").href = `intent://pair?${q}#Intent;scheme=aoemapcap;package=${APP_PKG};` +
    `S.browser_fallback_url=${encodeURIComponent(RELEASES)};end`;
  ban.hidden = false;
  const last = await latestApp();
  if (last) dl.href = last.url;
}

// trong app: có bản mới hơn thì báo (hỏi GitHub tối đa một lần mỗi lần mở app)
async function checkUpdate() {
  const app = window.AoEApp;
  if (!app || !app.versionCode || sessionStorage.getItem("aoe.upd")) return;
  sessionStorage.setItem("aoe.upd", "1");
  const last = await latestApp();
  if (!last || last.code <= +app.versionCode()) return;
  const n = $("#update-note");
  n.innerHTML = `Có bản app mới (${esc(last.tag)}). <a href="${esc(last.url)}">Tải về</a>`;
  n.hidden = false;
}

async function showList(src) {
  show("list");
  const box = $("#matches"), note = $("#list-note");
  note.hidden = true;
  box.innerHTML = `<div class="msg">Đang tải danh sách…</div>`;
  let items, err = null;
  try { items = await src.list(); } catch (e) { err = e; }
  const saved = src.store ? await src.store.saved() : [];
  const have = new Set(saved.map(s => s.file));
  if (err) {
    if (!saved.length) { box.innerHTML = `<div class="msg err">${esc(err.message)}</div>`; return; }
    items = saved.map(s => ({ file: s.file, info: s.info }));
    note.textContent = "Không kết nối được máy tính: chỉ hiện trận đã lưu trên điện thoại.";
    note.hidden = false;
  }
  if (!items.length) { box.innerHTML = `<div class="msg">Chưa có trận nào.</div>`; return; }
  box.innerHTML = "";
  for (const it of items) {
    const i = it.info || {};
    const d = new Date((i.created || 0) * 1000);
    const date = d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" }) + " " +
      d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
    const teams = {};
    for (const p of i.players || []) (teams[p.team] = teams[p.team] || []).push(p);
    const tl = Object.keys(teams).sort().map(k => `<div class="team">${teams[k].map(p =>
      `<span class="${p.name === i.recorder ? "me" : ""}">${esc(p.name)}<em>${esc(p.civ)}</em></span>`).join("")}</div>`)
      .join(`<div class="vs">vs</div>`);
    const el = document.createElement("button");
    el.className = "match";
    el.innerHTML = `<div class="row1"><b class="res ${resultClass(i.result)}">${esc(i.result)}</b>
      <span>${esc(i.format)} · ${esc(i.map)}</span><span class="dur">${fmtClock(i.duration_ms || 0)}</span></div>
      <div class="row2">${tl}</div><div class="row3">${date}${have.has(it.file) ? `<span class="saved">đã lưu</span>` : ""}</div>`;
    el.onclick = () => {
      if (!PAIRED) return openMatch(src, it.file, it.info);
      // trong app / trang trên trạm: sang trang trận để nút Back quay về danh sách
      sessionStorage.setItem("aoe.open", JSON.stringify(it));
      location.href = "?m=" + encodeURIComponent(it.file);
    };
    box.appendChild(el);
  }
}

async function openMatch(src, file, info, selftest) {
  show("viewer");
  const status = $("#v-status");
  status.hidden = false;
  const say = t => { status.textContent = t; };
  window.aoeTimes = { t0: performance.now() };       // ms từ lúc mở trận tới: sprites, gamedata, rec, first, viewer
  say("Đang mở trận…");
  try {
    if (!packPromise) packPromise = src.sprites(say).then(b => ({ buf: b, pack: new SpritePack(b) }));
    const { buf: packBuf, pack } = await packPromise;
    mark("sprites");
    let buf = await src.cached(file), live = null;
    if (!buf) {
      // điện thoại tự dựng từ file ghi trận gốc; không dùng được (hoặc bộ dựng lỗi trước khi có hình) thì cách cũ
      try {
        if (!info) {              // mở thẳng trận (không qua danh sách): hỏi máy tính thông tin trận để ghi vào bản dựng
          try { info = ((await src.list()).find(x => x.file === file) || {}).info || null; } catch { /* không có cũng được */ }
        }
        live = await src.live(file, info, packBuf, say);
        if (live) { buf = await live.first; mark("first"); }
      } catch (e) {
        console.warn("tự dựng trên điện thoại không được, nhờ máy tính chuyển:", e);
        if (live) live.cancel();
        live = null; buf = null;
      }
      if (!buf) buf = await src.match(file, info, say);
    }
    say("Đang dựng bản đồ…");
    const v = new Viewer($("#viewer"), buf, pack,
      { onError: e => say("Lỗi: " + e.message), build: live ? live.firstState : null });
    await v.init();
    mark("viewer");
    status.hidden = true;
    window.aoeViewer = v;
    window.aoeLive = live;
    if (live) {
      live.onProgress = p => v.buildProgress(p.pos);
      live.onSnapshot = (b, st) => v.swap(b, st);
      live.done.then(async final => {
        mark("built");
        if (src.store) await src.store.saveMatch(file, final, info);
        mark("saved");
        document.body.dataset.built = "1";
      }).catch(e => { console.error(e); v.toast("Dựng trận dở dang: " + e.message, 6000); });
      window.addEventListener("pagehide", () => live.cancel(), { once: true });
    }
    if (selftest) {
      if (live) { await live.done; while (v.m.meta.partial) await sleep(50); }
      const res = await v.selftest();
      const pre = document.createElement("pre");
      pre.id = "selftest";
      pre.textContent = JSON.stringify(res);
      document.body.appendChild(pre);
      document.title = "SELFTEST " + JSON.stringify(res);
    }
  } catch (e) {
    console.error(e);
    packPromise = null;
    say("Lỗi: " + e.message);
    document.title = "ERROR " + e.message;
  }
}

async function main() {
  window.addEventListener("error", e => { document.title = "ERROR " + e.message; });
  const q = new URLSearchParams(location.search);
  const home = location.pathname;
  $("#back").onclick = () => { if (PAIRED && history.length > 1) history.back(); else location.href = home; };
  if (!PAIRED) {
    const src = new Source({ base: home.replace(/[^/]*$/, "") }, null);
    if (q.get("m")) openMatch(src, q.get("m"), null, q.get("selftest"));
    else { showList(src); appBanner({ lan: location.host + home.replace(/[^/]*$/, "").replace(/\/$/, "") }); }
    return;
  }
  if (CLOUD && location.hash) {          // quét mã QR bằng camera: https://<trạm>/#r=<phòng>&l=<địa chỉ mạng nhà>
    const link = parsePair(location.hash);
    if (link && link.room) saveLink(link);
    history.replaceState(null, "", location.pathname + location.search);   // mã phòng không nằm lại trên thanh địa chỉ
  }
  const store = await Store.open();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const link = savedLink();
  const src = new Source(link, store);
  $("#pc-btn").hidden = false;
  $("#pc-btn").onclick = () => showSetup(store);
  if (q.get("m")) {
    let info = null;
    try {
      const it = JSON.parse(sessionStorage.getItem("aoe.open")) || {};
      if (it.file === q.get("m")) info = it.info || null;
    } catch { /* không có */ }
    openMatch(src, q.get("m"), info, q.get("selftest"));
  } else if (q.get("pair")) {            // mở từ trình duyệt: aoemapcap://pair?r=<phòng>&l=<địa chỉ> (v14: ?a=<địa chỉ>)
    const p = parsePair(q.get("pair"));
    showSetup(store);
    if (p) { if (p.lan) $("#pc-addr").value = p.lan; connect(p, store); }
  } else if (!src.linked) showSetup(store);
  else {
    showList(src);
    if (IN_APP) checkUpdate(); else appBanner(link);
  }
  // Back từ trang trận có thể khôi phục nguyên trang cũ (bfcache): vẽ lại danh sách cho nhãn "đã lưu" mới
  window.addEventListener("pageshow", e => {
    if (e.persisted && !q.get("m") && !$("#list").hidden) showList(src);
  });
}

main();
