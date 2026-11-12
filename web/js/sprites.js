// Gói hình (mapcap/webexport.export_sprites): SLP của bộ cài game người dùng + bảng màu.
// Giải mã SLP thành 2 byte mỗi pixel: R = chỉ số bảng màu (hoặc độ lệch màu quân), G = loại pixel.
// Màu thật tính trong shader (bảng màu + màu quân của từng mảnh), như mapcap/slp.py.

export const PX_NONE = 0, PX_PAL = 1, PX_PLAYER = 2, PX_SHADOW = 3, PX_BLACK = 4;
const MAGIC = "AOESPR01";

export class SpritePack {
  constructor(buf) {
    const u8 = new Uint8Array(buf);
    if (new TextDecoder().decode(u8.subarray(0, 8)) !== MAGIC) throw new Error("gói hình hỏng");
    const n = new DataView(buf).getUint32(8, true);
    this.meta = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + n)));
    this.base = 12 + n;
    this.u8 = u8;
    this.slps = new Map();
    this.palette = this.meta.palette;
  }

  slp(id) {
    let s = this.slps.get(id);
    if (s === undefined) {
      const e = this.meta.slp[id];
      s = e ? new SLP(this.u8.subarray(this.base + e[0], this.base + e[0] + e[1])) : null;
      this.slps.set(id, s);
    }
    return s;
  }
}

export class SLP {
  constructor(u8) {
    this.d = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.num = this.dv.getInt32(4, true);
  }

  info(idx) {
    const o = 32 + 32 * idx;
    const dv = this.dv;
    return { cmd: dv.getUint32(o, true), outline: dv.getUint32(o + 4, true), w: dv.getInt32(o + 16, true),
             h: dv.getInt32(o + 20, true), hx: dv.getInt32(o + 24, true), hy: dv.getInt32(o + 28, true) };
  }

  // -> {w, h, px: Uint8Array(w*h*2)} hoặc null (khung rỗng)
  decode(idx) {
    if (idx < 0 || idx >= this.num) return null;
    const f = this.info(idx);
    const w = f.w, h = f.h;
    if (w <= 0 || h <= 0) return null;
    const d = this.d, dv = this.dv;
    const px = new Uint8Array(w * h * 2);
    for (let row = 0; row < h; row++) {
      const left = dv.getUint16(f.outline + row * 4, true), right = dv.getUint16(f.outline + row * 4 + 2, true);
      if (left === 0x8000 || right === 0x8000) continue;
      let p = dv.getUint32(f.cmd + row * 4, true);
      let x = left;
      const line = row * w;
      const put = (n, idxOf, type) => {
        if (x + n <= w) for (let k = 0; k < n; k++) { const o = (line + x + k) * 2; px[o] = idxOf(k); px[o + 1] = type; }
        x += n;
      };
      for (;;) {
        if (p >= d.length) break;
        const cmd = d[p++];
        const low = cmd & 0x0f;
        if (low === 0x0f) break;
        if ((cmd & 3) === 0) {                               // lesser draw
          const n = cmd >> 2; const s = p; p += n;
          put(n, k => d[s + k], PX_PAL);
        } else if ((cmd & 3) === 1) {                        // lesser skip
          let n = cmd >> 2;
          if (n === 0) n = d[p++];
          x += n;
        } else if (low === 0x02) {                           // greater draw
          const n = ((cmd & 0xf0) << 4) + d[p++]; const s = p; p += n;
          put(n, k => d[s + k], PX_PAL);
        } else if (low === 0x03) {                           // greater skip
          x += ((cmd & 0xf0) << 4) + d[p++];
        } else if (low === 0x06) {                           // player color draw
          let n = cmd >> 4;
          if (n === 0) n = d[p++];
          const s = p; p += n;
          put(n, k => d[s + k], PX_PLAYER);
        } else if (low === 0x07) {                           // fill
          let n = cmd >> 4;
          if (n === 0) n = d[p++];
          const c = d[p++];
          put(n, () => c, PX_PAL);
        } else if (low === 0x0a) {                           // player color fill
          let n = cmd >> 4;
          if (n === 0) n = d[p++];
          const c = d[p++];
          put(n, () => c, PX_PLAYER);
        } else if (low === 0x0b) {                           // shadow
          let n = cmd >> 4;
          if (n === 0) n = d[p++];
          if (x + n <= w) for (let k = 0; k < n; k++) {
            const o = (line + x + k) * 2;
            if (px[o + 1] === PX_NONE) px[o + 1] = PX_SHADOW;
          }
          x += n;
        } else if (low === 0x0e) {                           // extended
          if (cmd === 0x4e || cmd === 0x5e) {                // outline 1 pixel: màu quân / đen
            if (x < w) { const o = (line + x) * 2; px[o] = 4; px[o + 1] = cmd === 0x4e ? PX_PLAYER : PX_BLACK; }
            x += 1;
          } else if (cmd === 0x6e || cmd === 0x7e) {
            const n = d[p++];
            put(n, () => 4, cmd === 0x6e ? PX_PLAYER : PX_BLACK);
          }
        } else break;
      }
    }
    return { w, h, px };
  }
}
