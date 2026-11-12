// Dựng trận trên điện thoại trong luồng nền (worker.js) và phát dần: first = bản đầu tiên phát được (giữa chừng hoặc
// đầy đủ), onSnapshot(buf, {pos, frames, final}) mỗi khi có bản đầy đủ hơn, done = trận đầy đủ (.aoeweb để lưu).
export class LiveBuild {
  static supported() {
    return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined";
  }

  // rec / sprites / gamedata: ArrayBuffer (rec được chuyển hẳn sang luồng nền; hai gói kia là bản sao của người gọi)
  constructor({ rec, sprites, gamedata, info, file, onProgress }) {
    this.onProgress = onProgress || null;
    this._onSnapshot = null;
    this._latest = null;            // bản mới nhất chưa giao (trình xem chưa sẵn sàng nhận)
    this.finished = false;
    let firstRes, firstRej, doneRes, doneRej;
    this.first = new Promise((a, b) => { firstRes = a; firstRej = b; });
    this.done = new Promise((a, b) => { doneRes = a; doneRej = b; });
    this.done.catch(() => {});      // người gọi có thể chỉ chờ first
    const w = this.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    let gotFirst = false;
    const fail = e => { this.finished = true; firstRej(e); doneRej(e); w.terminate(); };
    w.onerror = e => fail(new Error(e.message || "bộ dựng trận lỗi"));
    w.onmessage = ev => {
      const m = ev.data;
      if (m.type === "progress") { if (this.onProgress) this.onProgress(m); return; }
      if (m.type === "error") return fail(new Error(m.message));
      if (m.type !== "snapshot") return;
      const st = { pos: m.pos, frames: m.frames, final: m.final };
      if (!gotFirst) { gotFirst = true; this.firstState = st; firstRes(m.buf); }
      else if (this._onSnapshot) this._onSnapshot(m.buf, st);
      else this._latest = [m.buf, st];
      if (m.final) { this.finished = true; doneRes(m.buf); w.terminate(); }
    };
    w.postMessage({ rec, sprites, gamedata, info, file }, [rec, sprites, gamedata]);
  }

  // gắn nơi nhận các bản sau bản đầu; bản tới trong lúc chưa gắn được giao ngay
  set onSnapshot(fn) {
    this._onSnapshot = fn;
    if (fn && this._latest) { const a = this._latest; this._latest = null; fn(...a); }
  }

  cancel() {
    if (!this.finished) { this.finished = true; this.worker.terminate(); }
  }
}
