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
const MAX_SAVED = 400;          // số trận giữ trên điện thoại (giới hạn chính là dung lượng, xem SET.maxBytes)
const LIST_KEY = "/l/list";     // danh sách trận lần gần nhất lấy từ máy tính (lịch sử đấu hiện cả khi máy tính tắt)
// Cài đặt của người dùng (trang Cài đặt), lưu trong localStorage
const SET = {
  auto: () => localStorage.getItem("aoe.auto") !== "0",                  // tự lưu trận mới khi kết nối được máy tính
  days: () => +(localStorage.getItem("aoe.autoDays") || 2),               // ... các trận trong mấy ngày gần nhất
  wifi: () => localStorage.getItem("aoe.autoWifi") !== "0",              // ... chỉ khi dùng Wi-Fi
  maxBytes: () => +(localStorage.getItem("aoe.maxMB") || 500) * 1e6,      // tổng dung lượng trận đã lưu; trận vừa mở luôn giữ
};
const SIZE_GUESS = 20e6;        // trận lưu từ bản trước chưa ghi cỡ
const WEB_VERSION = 3;          // .aoeweb bản 3: số Chết / Đã phù đếm từ unit; trận lưu bản cũ thì dựng lại khi lấy được file ghi
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
// Danh tính thiết bị: mã ngẫu nhiên tạo một lần + tên máy. Gửi kèm khi hỏi danh sách / lấy file ghi để trang Điện thoại
// của AoE-MapCap trên máy tính hiện máy nào đã liên kết, đã lưu trận nào (máy tính bản cũ bỏ qua các tham số này).
function deviceId() {
  let d = localStorage.getItem("aoe.dev");
  if (!d) {
    d = Array.from(crypto.getRandomValues(new Uint8Array(9)), b => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
    localStorage.setItem("aoe.dev", d);
  }
  return d;
}
function deviceName() {
  const app = window.AoEApp;
  let n = "";
  try { n = app && app.deviceName ? String(app.deviceName() || "") : ""; } catch { /* app bản cũ */ }
  if (!n) {
    const m = /Android [\d.]+; ([^;)]+)/.exec(navigator.userAgent);
    n = m ? m[1].trim() : "Trình duyệt";
  }
  return n.slice(0, 40);
}
function who() {
  const app = window.AoEApp;
  const ver = app && app.versionCode ? app.versionCode() : 0;
  return "cid=" + deviceId() + "&dev=" + encodeURIComponent(deviceName()) + "&app=" + ver;
}
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
      if (n === 1 || (n <= MAX_SAVED && total <= SET.maxBytes())) continue;
      await this.remove(e.file);
    }
  }
  async remove(file) {
    const k = encodeURIComponent(file);
    await this.c.delete("/m/" + k); await this.c.delete("/i/" + k);
  }
  async clearMatches() { for (const e of await this.saved()) await this.remove(e.file); }
  async clearPacks() { await this.c.delete("/s/sprites"); await this.c.delete(GAMEDATA_KEY); }
  async has(key) { return !!(await this.c.match(key)); }
  async getList() {
    try { const r = await this.c.match(LIST_KEY); return r ? await r.json() : null; } catch { return null; }
  }
  async putList(items) { await this.put(LIST_KEY, new TextEncoder().encode(JSON.stringify(items))); }
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
    const r = await this.fetch("api/matches?" + who());
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
  // báo cho máy tính các trận đang lưu trên điện thoại này (reset = đây là toàn bộ danh sách); lỗi / máy tính bản cũ: bỏ qua
  async reportSaved(files, reset) {
    if (!this.linked) return;
    const chunks = [];
    let cur = [];
    for (const f of files) {
      if (cur.join("|").length + f.length > 1200) { chunks.push(cur); cur = []; }
      cur.push(f);
    }
    if (cur.length || reset) chunks.push(cur);
    try {
      for (let k = 0; k < chunks.length; k++) {
        const r = await this.fetch("api/saved?cid=" + deviceId() + (reset && k === 0 ? "&reset=1" : "") +
          "&f=" + encodeURIComponent(chunks[k].join("|")));
        if (!r.ok) return;
        await r.arrayBuffer();
      }
    } catch { /* không báo được cũng không sao */ }
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
    onStatus && onStatus("Đang lấy file ghi trận từ máy tính…");
    try {
      rec = await this._retry(() => this._download("api/rec?f=" + encodeURIComponent(file) + "&cid=" + deviceId(),
        (f, got) => onStatus && onStatus("Đang lấy file ghi trận từ máy tính… " + pct(f, got))), onStatus);
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
// trạng thái vỏ app: nguồn trận, bộ nhớ, danh sách (từ máy tính hoặc bản nhớ lần trước), trận đã lưu, máy tính có đang
// kết nối được không (null = chưa biết), bộ lọc danh sách, lượt tự lưu đang chạy
const APP = { src: null, store: null, items: [], saved: new Map(), online: null, filter: "all", find: "", autoRun: false,
  autoLive: null, via: null, view: localStorage.getItem("aoe.view") === "table" ? "table" : "cards" };
const TABS = {
  list: ["Trận đã ghi", "Toàn bộ lịch sử đấu trên máy tính của bạn"],
  setup: ["Máy tính", "Liên kết với AoE-MapCap trên máy tính"],
  settings: ["Cài đặt", "Tự lưu trận, bộ nhớ, phiên bản"],
  about: ["Hướng dẫn", "App hoạt động thế nào"],
};

function show(id) {
  for (const el of document.querySelectorAll(".screen")) el.hidden = el.id !== id;
}

function showTab(tab) {
  if (!TABS[tab]) tab = "list";
  show("shell");
  for (const el of document.querySelectorAll(".page")) el.hidden = el.id !== tab;
  for (const b of $("#tabs").children) b.classList.toggle("on", b.dataset.tab === tab);
  $("#page-title").textContent = TABS[tab][0];
  $("#page-sub").textContent = TABS[tab][1];
  $("#pages").scrollTop = 0;
  if (tab === "setup") renderLink();
  if (tab === "settings") renderSettings();
}

// hộp thoại báo / hỏi: act = {label, fn} thêm một nút hành động
function dialog(text, act) {
  $("#dlg-text").textContent = text;
  const b = $("#dlg-act");
  b.hidden = !act;
  if (act) { b.textContent = act.label; b.onclick = () => { $("#dlg").hidden = true; act.fn(); }; }
  $("#dlg-ok").textContent = act ? "Để sau" : "Đóng";
  $("#dlg-ok").onclick = () => { $("#dlg").hidden = true; };
  $("#dlg").hidden = false;
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

// Liên kết với máy tính chỉ đổi ở hai chỗ: ghép đôi thành công (connect) và người dùng bấm Bỏ liên kết. Mở trang Máy
// tính, kết nối lỗi, máy tính tắt... đều KHÔNG xoá liên kết (trước v9 bấm nút Máy tính đưa về màn hình ghép đôi trống,
// người dùng tưởng mất kết nối).
function saveLink(link) {
  for (const [k, v] of [[PC_KEY, link.lan], [ROOM_KEY, link.room]]) {
    if (v) localStorage.setItem(k, v); else localStorage.removeItem(k);
  }
}

// thử kết nối bằng liên kết mới; được thì lưu và về danh sách, không được thì giữ nguyên liên kết cũ
async function connect(link) {
  const msg = $("#setup-msg");
  msg.textContent = "Đang kết nối máy tính…"; msg.className = "msg";
  const src = new Source(link, APP.store);
  try { await src.list(); }
  catch (err) {
    msg.textContent = "Không kết nối được máy tính (" + err.message + "). Kiểm tra: AoE-MapCap trên máy tính đang mở, " +
      "đã bật mục Điện thoại" + (link.room ? " và máy tính có Internet." : "; nhập tay địa chỉ thì phải cùng Wi-Fi.") +
      (APP.src && APP.src.linked ? " Liên kết cũ vẫn được giữ." : "");
    msg.className = "msg err";
    return false;
  }
  saveLink(link);
  msg.textContent = "";
  APP.src = src; APP.online = null; APP.items = [];
  showTab("list");
  loadList();
  return true;
}

// trang Máy tính: thẻ trạng thái liên kết + ghép đôi (quét QR / nhập tay)
function renderLink() {
  const link = APP.src ? APP.src.link : {};
  const linked = !!(link.lan || link.room);
  const direct = !!link.base;                  // trang mở thẳng từ máy tính (phát triển / kiểm thử)
  $("#link-card").hidden = !linked;
  $("#setup-title").textContent = linked ? "Liên kết lại / đổi máy tính" : "Liên kết với máy tính";
  if (linked) {
    const st = $("#link-state");
    st.textContent = APP.online === null ? "Đang kiểm tra…" : APP.online ? "Đang kết nối được"
      : "Không kết nối được (máy tính tắt hoặc mất mạng)";
    st.className = APP.online ? "ok" : APP.online === false ? "bad" : "";
    $("#link-via").textContent = !APP.online ? "—" : APP.via === "lan" ? "Mạng nhà (Wi-Fi), đi thẳng"
      : APP.via === "relay" ? "Qua Internet (trạm chuyển tiếp)" : "—";
    $("#link-lan").textContent = link.lan || "—";
    $("#link-room").textContent = link.room ? link.room.slice(0, 4) + "…" + link.room.slice(-2) : "—";
  }
  const inp = $("#pc-addr");
  if (!inp.value) inp.value = link.lan || "";
  const app = window.AoEApp;
  $("#scan-qr").hidden = !(app && app.scanQr);
  $("#setup-camera").hidden = !CLOUD;
  $("#setup-manual").hidden = CLOUD || direct;     // trang https trên trạm không gọi được địa chỉ http trong mạng nhà
  $("#setup-form").hidden = direct;
}

function bindSetup() {
  const inp = $("#pc-addr"), msg = $("#setup-msg");
  const app = window.AoEApp;
  $("#scan-qr").onclick = () => {
    msg.textContent = "Đang mở máy quét…"; msg.className = "msg";
    // app gọi lại: (nội dung mã, null) | (null, lỗi) | (null, null) = huỷ
    window.onQrResult = (text, err) => {
      if (err) { msg.textContent = "Không quét được: " + err + ". Có thể nhập tay bên dưới."; msg.className = "msg err"; return; }
      if (text == null) { msg.textContent = ""; return; }
      const link = parsePair(text);
      if (!link) { msg.textContent = "Mã QR này không phải của AoE-MapCap."; msg.className = "msg err"; return; }
      if (link.lan) inp.value = link.lan;
      connect(link);
    };
    app.scanQr();
  };
  $("#setup-form").onsubmit = e => {
    e.preventDefault();
    const link = parsePair(inp.value);
    if (!link) { msg.textContent = "Địa chỉ dạng 192.168.1.5:8765/abc123"; msg.className = "msg err"; return; }
    if (!link.room) link.room = localStorage.getItem(ROOM_KEY);   // giữ phòng đã ghép (đổi địa chỉ mạng nhà)
    connect(link);
  };
  $("#link-retry").onclick = async () => { APP.online = null; renderLink(); await loadList(); renderLink(); };
  $("#link-remove").onclick = () => dialog("Bỏ liên kết với máy tính này?\nCác trận đã lưu trên điện thoại vẫn được giữ. " +
    "Muốn xem trận mới phải quét lại mã QR.", { label: "Bỏ liên kết", fn: () => {
      saveLink({});
      if (APP.autoLive) APP.autoLive.cancel();
      APP.src = new Source(null, APP.store); APP.online = false; APP.via = null;
      $("#pc-addr").value = "";
      renderLink(); loadList();
    } });
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
async function checkUpdate(force) {
  const app = window.AoEApp;
  if (!app || !app.versionCode || (!force && sessionStorage.getItem("aoe.upd"))) return null;
  sessionStorage.setItem("aoe.upd", "1");
  const last = await latestApp();
  if (!last || last.code <= +app.versionCode()) return last ? false : null;
  const n = $("#update-note");
  n.innerHTML = `Có bản app mới (${esc(last.tag)}). <a href="${esc(last.url)}">Tải về</a>`;
  n.hidden = false;
  const tab = $("#tabs [data-tab=settings]");
  if (tab && !tab.querySelector(".dot")) tab.insertAdjacentHTML("beforeend", `<i class="dot"></i>`);
  return last;
}

// ---- trang Cài đặt -------------------------------------------------------------------------------------
const mb = b => b >= 1e9 ? (b / 1e9).toFixed(2).replace(".", ",") + " GB" : Math.round(b / 1e6) + " MB";

async function renderSettings() {
  $("#set-auto").checked = SET.auto();
  $("#set-days").value = String(SET.days());
  $("#set-wifi").checked = SET.wifi();
  $("#set-max").value = String(Math.round(SET.maxBytes() / 1e6));
  const app = window.AoEApp;
  $("#app-ver").textContent = app && app.versionCode ? "v" + app.versionCode() + " (app Android)" : "trang web (không phải app)";
  $("#app-check").hidden = !(app && app.versionCode);
  const st = APP.store;
  if (!st) {
    $("#st-matches").textContent = "trang này không lưu trận (chỉ app / trang trên trạm)";
    $("#st-packs").textContent = "—";
    return;
  }
  const saved = await st.saved();
  const total = saved.reduce((a, e) => a + (e.size || SIZE_GUESS), 0);
  $("#st-matches").textContent = saved.length ? `${saved.length} trận, ${mb(total)}` : "chưa có trận nào";
  const [sp, gd] = [await st.has("/s/sprites"), await st.has(GAMEDATA_KEY)];
  $("#st-packs").textContent = sp && gd ? "đã có (khoảng 24 MB)" : sp ? "có hình, chưa có dữ liệu game" : "chưa tải";
}

function bindSettings() {
  const set = (k, v) => { localStorage.setItem(k, v); };
  $("#set-auto").onchange = e => { set("aoe.auto", e.target.checked ? "1" : "0"); if (e.target.checked) autoSave(); else stopAuto(); };
  $("#set-days").onchange = e => { set("aoe.autoDays", e.target.value); autoSave(); };
  $("#set-wifi").onchange = e => { set("aoe.autoWifi", e.target.checked ? "1" : "0"); autoSave(); };
  $("#set-max").onchange = e => { set("aoe.maxMB", e.target.value); };
  $("#st-clear").onclick = () => dialog("Xoá mọi trận đã lưu trên điện thoại?\nLịch sử đấu vẫn hiện; muốn xem lại phải lấy " +
    "file ghi từ máy tính.", { label: "Xoá", fn: async () => {
      stopAuto();
      if (APP.store) await APP.store.clearMatches();
      await loadSaved(); renderList(); renderSettings();
    } });
  $("#st-clear-packs").onclick = () => dialog("Xoá gói hình và dữ liệu game?\nLần mở trận tới app sẽ tải lại từ máy tính " +
    "(khoảng 24 MB).", { label: "Xoá", fn: async () => {
      if (APP.store) await APP.store.clearPacks();
      packPromise = null;
      renderSettings();
    } });
  $("#app-check").onclick = async () => {
    const m = $("#app-check-msg");
    m.className = "msg"; m.textContent = "Đang kiểm tra…";
    const r = await checkUpdate(true);
    m.innerHTML = r === null ? "Không hỏi được trang phát hành (kiểm tra Internet)."
      : r === false ? "Bạn đang dùng bản mới nhất."
      : `Có bản mới ${esc(r.tag)}: <a href="${esc(r.url)}">tải về</a> rồi cài đè, trận đã lưu được giữ nguyên.`;
  };
}

// ---- danh sách trận (toàn bộ lịch sử đấu) ------------------------------------------------------------------
async function loadSaved() {
  const saved = APP.store ? await APP.store.saved() : [];
  APP.saved = new Map(saved.map(s => [s.file, s]));
  return saved;
}

function setOnline(on) {
  APP.online = on;
  const pill = $("#pc-state");
  const linked = APP.src && APP.src.linked;
  pill.hidden = !linked;
  pill.className = "pill " + (on ? "on" : on === false ? "off" : "");
  pill.textContent = on ? "● Máy tính" : on === false ? "○ Ngoại tuyến" : "… Máy tính";
  const note = $("#list-note");
  if (on === false && linked) {
    note.textContent = "Không kết nối được máy tính: chỉ hiện trận đã lưu trên điện thoại là mở được. Lịch sử đấu bên " +
      "dưới là bản lấy lần gần nhất.";
    note.hidden = false;
  } else note.hidden = true;
}

// Lấy danh sách: hiện ngay bản nhớ lần trước (nếu có), rồi hỏi máy tính; không hỏi được thì giữ bản nhớ + trận đã lưu.
async function loadList() {
  const box = $("#matches");
  const st = APP.store, src = APP.src;
  const saved = await loadSaved();
  const cached = st ? await st.getList() : null;
  if (!APP.items.length && cached) { APP.items = cached; renderList(); }
  else if (!APP.items.length) box.innerHTML = `<div class="msg">Đang tải danh sách…</div>`;
  if (!src || !src.linked) {
    setOnline(false);
    APP.items = mergeSaved(cached || [], saved);
    renderList();
    return;
  }
  setOnline(null);
  let items = null, err = null;
  try { items = await src.list(); } catch (e) { err = e; }
  if (src !== APP.src) return;                 // đã đổi / bỏ liên kết trong lúc chờ
  if (items) {
    APP.via = src.link.base ? "direct" : await Promise.resolve(src.via).catch(() => null);
    if (st) st.putList(items);
    APP.items = mergeSaved(items, saved);
    setOnline(true);
    if (st) src.reportSaved(saved.filter(s => webVersionOk(s)).map(s => s.file), true);
  } else {
    APP.items = mergeSaved(cached || [], saved);
    setOnline(false);
    if (!APP.items.length) { box.innerHTML = `<div class="msg err">${esc(err.message)}</div>`; $("#list-count").textContent = ""; return; }
  }
  renderList();
  // tự lưu bắt đầu sau 3 giây: người vừa mở app thường bấm xem ngay một trận, lúc đó không tranh đường truyền với nó
  if (items) { clearTimeout(APP.autoTimer); APP.autoTimer = setTimeout(autoSave, 3000); }
}

// danh sách từ máy tính + các trận đã lưu mà máy tính không còn (đã xoá / dọn trên máy tính), mới nhất trước
function mergeSaved(items, saved) {
  const have = new Set(items.map(i => i.file));
  const out = items.concat(saved.filter(s => !have.has(s.file)).map(s => ({ file: s.file, info: s.info })));
  return out.sort((a, b) => ((b.info || {}).created || 0) - ((a.info || {}).created || 0));
}

const webVersionOk = () => true;       // (mọi bản lưu đều mở được; bản cũ sẽ dựng lại khi lấy được file ghi)

function dayLabel(d) {
  const t = new Date(), y = new Date(Date.now() - 864e5);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return same(d, t) ? "Hôm nay" : same(d, y) ? "Hôm qua"
    : d.toLocaleDateString("vi-VN", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
}

function renderList() {
  const box = $("#matches");
  const find = APP.find.trim().toLowerCase();
  const all = APP.items;
  const items = all.filter(it => {
    const i = it.info || {};
    if (APP.filter === "saved" && !APP.saved.has(it.file)) return false;
    if (APP.filter === "win" && resultClass(i.result) !== "win") return false;
    if (APP.filter === "lose" && resultClass(i.result) !== "lose") return false;
    if (!find) return true;
    const hay = [i.map, i.format, i.result, it.file].concat((i.players || []).map(p => p.name + " " + p.civ)).join(" ").toLowerCase();
    return hay.includes(find);
  });
  const nSaved = all.filter(it => APP.saved.has(it.file)).length;
  $("#list-count").textContent = all.length ? `${items.length === all.length ? all.length : items.length + " / " + all.length} trận · ${nSaved} đã lưu trên điện thoại` : "";
  if (!all.length) {
    const linked = APP.src && APP.src.linked;
    box.innerHTML = `<div class="msg">${linked ? "Chưa có trận nào." : "Chưa liên kết máy tính.<br>Vào mục <b>Máy tính</b> ở thanh dưới để quét mã QR."}</div>`;
    return;
  }
  if (!items.length) { box.innerHTML = `<div class="msg">Không có trận nào khớp bộ lọc.</div>`; return; }
  box.innerHTML = "";
  box.classList.toggle("astable", APP.view === "table");
  if (APP.view === "table") return renderTable(box, items);
  let lastDay = null;
  for (const it of items) {
    const i = it.info || {};
    const d = new Date((i.created || 0) * 1000);
    const day = d.toDateString();
    if (day !== lastDay) {
      lastDay = day;
      const h = document.createElement("div");
      h.className = "day"; h.textContent = dayLabel(d);
      box.appendChild(h);
    }
    const time = d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
    const teams = {};
    for (const p of i.players || []) (teams[p.team] = teams[p.team] || []).push(p);
    const tl = Object.keys(teams).sort().map(k => `<div class="team">${teams[k].map(p =>
      `<span class="${p.name === i.recorder ? "me" : ""}">${esc(p.name)}<em>${esc(p.civ)}</em></span>`).join("")}</div>`)
      .join(`<div class="vs">vs</div>`);
    const saved = APP.saved.has(it.file);
    const el = document.createElement("button");
    el.className = "match " + resultClass(i.result) + (!saved && APP.online === false ? " off" : "");
    el.dataset.file = it.file;
    el.innerHTML = `<div class="row1"><b class="res ${resultClass(i.result)}">${esc(i.result)}</b>
      <span class="mode">${esc(i.format)} · ${esc(i.map)}</span><span class="dur">${fmtClock(i.duration_ms || 0)}</span></div>
      <div class="row2${Object.keys(teams).length > 2 ? " many" : ""}">${tl}</div><div class="row3"><span>${time}</span>${i.age3 != null ? `<span>Kích 3 ${fmtClock(i.age3)}</span>` : ""}
      ${(i.hack || []).length ? `<span class="tag hack">có hack</span>` : ""}<span class="sp"></span>
      ${saved ? `<span class="tag saved">đã lưu</span>` : it.push ? `<span class="tag push">chờ lưu</span>` : `<span class="tag cloud">chưa lưu</span>`}</div>`;
    el.onclick = () => openFromList(it);
    box.appendChild(el);
  }
}

// Dạng bảng như trang Trận đã ghi của AoE-MapCap trên máy tính: Ngày, Người chơi, Quân, Kết quả, Thể thức, Map, Kích 3,
// Thời gian (+ cột Lưu). Kéo ngang để xem hết cột; chạm một dòng để mở trận.
function renderTable(box, items) {
  const rows = items.map(it => {
    const i = it.info || {};
    const d = new Date((i.created || 0) * 1000);
    const date = d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }) + " " +
      d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
    const saved = APP.saved.has(it.file);
    const rc = resultClass(i.result);
    return `<tr class="match ${rc}${!saved && APP.online === false ? " off" : ""}" data-file="${esc(it.file)}">
      <td>${date}</td><td class="me">${esc(i.recorder)}</td><td>${esc(i.recorder_civ)}</td>
      <td class="res ${rc}">${(i.hack || []).length ? "⚠ " : ""}${esc(i.result)}</td>
      <td>${esc(i.format)} ${esc(i.civ_mode || "")}</td><td>${esc(i.map)}</td>
      <td class="num">${i.age3 != null ? fmtClock(i.age3) : "—"}</td><td class="num">${fmtClock(i.duration_ms || 0)}</td>
      <td>${saved ? `<span class="tag saved">đã lưu</span>` : it.push ? `<span class="tag push">chờ lưu</span>` : `<span class="tag cloud">chưa lưu</span>`}</td></tr>`;
  }).join("");
  box.innerHTML = `<div class="tblwrap"><table class="mt"><thead><tr><th>Ngày</th><th>Người chơi</th><th>Quân</th><th>Kết quả</th>
    <th>Thể thức</th><th>Map</th><th>Kích 3</th><th>Thời gian</th><th>Lưu</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const by = new Map(items.map(it => [it.file, it]));
  box.querySelector("tbody").onclick = e => {
    const tr = e.target.closest("tr[data-file]");
    if (tr && by.has(tr.dataset.file)) openFromList(by.get(tr.dataset.file));
  };
}

// chạm một trận: đã lưu -> mở ngay; chưa lưu -> lấy file ghi từ máy tính nếu máy tính đang kết nối được, không thì báo
function openFromList(it) {
  if (!APP.saved.has(it.file) && APP.online !== true) {
    const linked = APP.src && APP.src.linked;
    dialog(linked ? "Trận này chưa lưu file ghi về điện thoại.\nCần bật máy tính (mở AoE-MapCap, vào mục Điện thoại, máy " +
      "tính có Internet) để lấy file ghi trận." : "Trận này chưa lưu file ghi về điện thoại và điện thoại chưa liên kết máy " +
      "tính.\nVào mục Máy tính để quét mã QR.", linked ? { label: "Thử kết nối lại", fn: () => loadList() }
      : { label: "Mở mục Máy tính", fn: () => showTab("setup") });
    return;
  }
  stopAuto();
  if (!PAIRED) return openMatch(APP.src, it.file, it.info);
  // trong app / trang trên trạm: sang trang trận để nút Back quay về danh sách
  sessionStorage.setItem("aoe.open", JSON.stringify(it));
  location.href = "?m=" + encodeURIComponent(it.file);
}

// ---- tự lưu trận mới (Cài đặt -> Tự lưu trận) --------------------------------------------------------------
function autoNote(html, frac) {
  const n = $("#auto-note");
  if (!html) { n.hidden = true; return; }
  n.innerHTML = `<span>${html}</span>` + (frac != null ? `<span class="bar"><i style="width:${Math.round(frac * 100)}%"></i></span>` : "");
  n.hidden = false;
}

function stopAuto() {
  clearTimeout(APP.autoTimer);
  APP.autoStop = true;
  if (APP.autoLive) APP.autoLive.cancel();
}

async function onWifi() {
  if (APP.via === "lan" || APP.via === "direct") return true;      // đang đi thẳng trong mạng nhà
  const c = navigator.connection;
  return !(c && (c.type === "cellular" || c.type === "bluetooth" || c.type === "wimax"));
}

// Lần lượt lấy file ghi + dựng + lưu các trận mới trong SET.days() ngày gần nhất chưa có trên điện thoại (mới nhất
// trước). Chạy khi vừa lấy được danh sách từ máy tính; dừng khi mở một trận, tắt cài đặt, đầy bộ nhớ, mất kết nối.
async function autoSave() {
  if (APP.autoRun || APP.online !== true || !SET.auto() || !APP.store || !LiveBuild.supported()) return;
  const since = Date.now() / 1000 - SET.days() * 86400;
  const todo = APP.items.filter(it => (((it.info || {}).created || 0) >= since || it.push) && !APP.saved.has(it.file));
  if (!todo.length) { autoNote(""); return; }
  if (SET.wifi() && !(await onWifi())) {
    autoNote(`Có <b>${todo.length} trận mới</b> chưa lưu: đang dùng mạng di động nên chưa tự lưu (đổi trong Cài đặt).`);
    return;
  }
  APP.autoRun = true; APP.autoStop = false;
  const src = APP.src;
  let done = 0;
  try {
    autoNote(`Tự lưu ${todo.length} trận mới: đang chuẩn bị…`);
    if (!packPromise) packPromise = src.sprites(t => autoNote("Tự lưu trận mới: " + esc(t))).then(b => ({ buf: b, pack: new SpritePack(b) }));
    const { buf: packBuf } = await packPromise;
    for (const it of todo) {
      if (APP.autoStop || src !== APP.src) break;
      const used = [...APP.saved.values()].reduce((a, e) => a + (e.size || SIZE_GUESS), 0);
      if (used + SIZE_GUESS > SET.maxBytes()) {
        autoNote(`Bộ nhớ trận đã lưu sắp đầy (${mb(used)} / ${mb(SET.maxBytes())}): tăng giới hạn trong Cài đặt để tự lưu thêm.`);
        return;
      }
      const head = `Tự lưu trận mới <b>${done + 1}/${todo.length}</b>: `;
      const live = await src.live(it.file, it.info, packBuf, t => autoNote(head + esc(t.replace("trên điện thoại", "").replace("…", "")) + "…"));
      if (!live) { autoNote("Chưa tự lưu được: máy tính cần AoE-MapCap v38 trở lên."); return; }
      APP.autoLive = live;
      live.onProgress = p => autoNote(head + "đang dựng…", p.pos);
      const final = await live.done;
      APP.autoLive = null;
      await APP.store.saveMatch(it.file, final, it.info);
      src.reportSaved([it.file]);
      done++;
      await loadSaved();
      if (!$("#list").hidden || true) renderList();
    }
    autoNote(done && !APP.autoStop ? `Đã tự lưu ${done} trận mới về điện thoại.` : "");
    if (done) setTimeout(() => { if (!APP.autoRun) autoNote(""); }, 6000);
  } catch (e) {
    if (!APP.autoStop) autoNote("Tự lưu tạm dừng: " + esc(e.message));
    else autoNote("");
  } finally { APP.autoRun = false; APP.autoLive = null; }
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
      { onError: e => say("Lỗi: " + e.message), build: live ? live.firstState : null,
        autoplay: !selftest && !new URLSearchParams(location.search).get("noplay") });
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
        if (src.store) { await src.store.saveMatch(file, final, info); src.reportSaved([file]); }
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
  // vỏ app: thanh menu dưới, bộ lọc danh sách, trang Máy tính, trang Cài đặt
  $("#tabs").onclick = e => { const b = e.target.closest("button"); if (b) showTab(b.dataset.tab); };
  $("#find").oninput = e => { APP.find = e.target.value; renderList(); };
  const setView = v => {
    APP.view = v;
    localStorage.setItem("aoe.view", v);
    for (const x of $("#list-view").children) x.classList.toggle("on", x.dataset.v === v);
    renderList();
  };
  $("#list-view").onclick = e => { const b = e.target.closest("button"); if (b) setView(b.dataset.v); };
  for (const x of $("#list-view").children) x.classList.toggle("on", x.dataset.v === APP.view);
  $("#list-chips").onclick = e => {
    const b = e.target.closest("button");
    if (!b) return;
    APP.filter = b.dataset.f;
    for (const x of $("#list-chips").children) x.classList.toggle("on", x === b);
    renderList();
  };
  bindSetup();
  bindSettings();
  window.addEventListener("pagehide", () => { if (APP.autoLive) APP.autoLive.cancel(); });
  if (!PAIRED) {                         // trang mở thẳng từ máy chủ của máy tính (phát triển / kiểm thử): không lưu trận
    APP.src = new Source({ base: home.replace(/[^/]*$/, "") }, null);
    if (q.get("m")) return openMatch(APP.src, q.get("m"), null, q.get("selftest"));
    showTab("list");
    loadList();
    appBanner({ lan: location.host + home.replace(/[^/]*$/, "").replace(/\/$/, "") });
    return;
  }
  if (CLOUD && location.hash) {          // quét mã QR bằng camera: https://<trạm>/#r=<phòng>&l=<địa chỉ mạng nhà>
    const link = parsePair(location.hash);
    if (link && link.room) saveLink(link);
    history.replaceState(null, "", location.pathname + location.search);   // mã phòng không nằm lại trên thanh địa chỉ
  }
  const store = APP.store = await Store.open();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const link = savedLink();
  const src = APP.src = new Source(link, store);
  if (q.get("m")) {
    let info = null;
    try {
      const it = JSON.parse(sessionStorage.getItem("aoe.open")) || {};
      if (it.file === q.get("m")) info = it.info || null;
    } catch { /* không có */ }
    return openMatch(src, q.get("m"), info, q.get("selftest"));
  }
  if (q.get("pair")) {                   // mở từ trình duyệt: aoemapcap://pair?r=<phòng>&l=<địa chỉ> (v14: ?a=<địa chỉ>)
    const p = parsePair(q.get("pair"));
    history.replaceState(null, "", location.pathname);
    showTab("setup");
    if (p) { if (p.lan) $("#pc-addr").value = p.lan; if (!(await connect(p))) loadList(); }
    else loadList();
  } else {
    const saved = store ? await store.saved() : [];
    showTab(!src.linked && !saved.length ? "setup" : "list");      // mở app luôn về danh sách trận
    loadList();
    if (IN_APP) checkUpdate(); else if (src.linked) appBanner(link);
  }
  // Back từ trang trận có thể khôi phục nguyên trang cũ (bfcache): vẽ lại danh sách cho nhãn "đã lưu" mới
  window.addEventListener("pageshow", e => {
    if (e.persisted && !q.get("m")) loadList();
  });
}

main();
