// Luồng nền dựng trận ngay trên điện thoại: nhận file ghi trận (.aoerec) + gói hình + gói dữ liệu game, chạy bộ chuyển
// (build.js) và gửi về trang chính:
//   {type: "progress", pos, frames}                      tiến độ (pos = tỉ lệ file đã đọc)
//   {type: "snapshot", buf, pos, frames, final: false}   phần đã dựng, đóng gói thành .aoeweb tạm (meta.partial) để
//                                                         trình xem phát ngay trong lúc dựng tiếp
//   {type: "snapshot", buf, pos: 1, frames, final: true} trận đầy đủ (lưu lại trên điện thoại)
//   {type: "error", message}
// Bản giữa chừng đầu tiên sau FIRST_FRAMES mẫu (~20 giây giờ game), các bản sau cách nhau SNAP_MS (hoặc 6 lần thời
// gian đóng gói lần trước nếu lâu hơn, để việc đóng gói không chiếm quá ~15% thời gian dựng).
import { SpritePack } from "../sprites.js";
import { zlibSync } from "../vendor/fflate.js";
import { GameData, RecBuilder, packAoeweb, records } from "./build.js";

const FIRST_FRAMES = 500;
const SNAP_MS = 4000;
const PROGRESS_MS = 250;
const JPEG_QUALITY = 0.88;

// ô địa hình RGBA (alpha bỏ) -> JPEG bằng OffscreenCanvas
async function encodeJpeg(img) {
  const px = new Uint8ClampedArray(img.px.length);
  px.set(img.px);
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  const c = new OffscreenCanvas(img.w, img.h);
  c.getContext("2d").putImageData(new ImageData(px, img.w, img.h), 0, 0);
  const blob = await c.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  return new Uint8Array(await blob.arrayBuffer());
}

async function build({ rec, sprites, gamedata, info, file }) {
  const u8 = new Uint8Array(rec);
  const pack = new SpritePack(sprites);
  const gd = new GameData(gamedata);
  const b = new RecBuilder(pack, gd, { info, encodeJpeg });
  const cache = new Map();
  let first = true, frames = 0, snapped = false, lastSnap = 0, lastProg = 0, snapCost = 0, pos = 0;
  const snapshot = final => {
    const t = performance.now();
    const { meta, sections } = b.finish(file, !final);
    const out = packAoeweb(meta, sections, zlibSync, { cache, level: final ? 6 : 1 });
    const buf = out.buffer.byteLength === out.byteLength ? out.buffer : out.slice().buffer;
    self.postMessage({ type: "snapshot", buf, pos: final ? 1 : pos, frames, final }, [buf]);
    snapCost = performance.now() - t;
    lastSnap = performance.now();
    snapped = true;
  };
  for (const r of records(u8)) {
    pos = r.pos;
    if (first) {
      if (r.tag !== "H") throw new Error("file ghi trận thiếu phần đầu");
      b.header(r.p);
      await b.terrain();
      first = false;
      lastSnap = performance.now();
      continue;
    }
    b.feed(r.tag, r.p);
    if (b.broken) break;
    if (r.tag !== "F") continue;
    frames++;
    if (frames % 25) continue;
    const now = performance.now();
    if (now - lastProg > PROGRESS_MS) { lastProg = now; self.postMessage({ type: "progress", pos, frames }); }
    if (!snapped ? frames >= FIRST_FRAMES : now - lastSnap > Math.max(SNAP_MS, snapCost * 6)) snapshot(false);
  }
  if (first) throw new Error("file ghi trận rỗng");
  snapshot(true);
}

self.onmessage = e => {
  build(e.data).catch(err => self.postMessage({ type: "error", message: String(err && err.message || err) }));
};
