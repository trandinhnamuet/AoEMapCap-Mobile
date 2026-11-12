// Ảnh địa hình + bản đồ chỉ số ô của bộ chuyển trên điện thoại, đúng như máy tính (replay/world.py build_terrain /
// build_index, mapcap/webexport.py _terrain): giải mã SLP ra RGBA như mapcap/slp.py, dán như Image.paste (trộn alpha
// DIV255 của Pillow), thu nhỏ bằng bộ lọc BOX của Pillow (Resample.c: hệ số 22 bit, hai lượt ngang rồi dọc).
// Mọi ảnh RGB giữ dạng 4 byte / điểm như Pillow (byte thứ tư bỏ qua).

export const TILE_W = 64, TILE_H = 32, ELEV_H = 16;
const BAND = 1024;
const BORDER_SUBSTITUTE = { 6: 4, 7: null };
const SHADOW_ALPHA = 110;

// làm tròn như Python round(x): nửa về số chẵn
export function pyRoundInt(x) {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

// ---- SLP -> RGBA (mapcap/slp.py SLP.decode) ----------------------------------------------------------------
export function decodeRGBA(slp, idx, pal, colorId = 0) {
  const dv = slp.dv, d = slp.d;
  const o = 32 + 32 * idx;
  const cmdOff = dv.getUint32(o, true), outOff = dv.getUint32(o + 4, true);
  const w = dv.getInt32(o + 16, true), h = dv.getInt32(o + 20, true);
  const hx = dv.getInt32(o + 24, true), hy = dv.getInt32(o + 28, true);
  const W = Math.max(w, 0), H = Math.max(h, 0);
  const img = new Uint8Array(W * H * 4);
  const pc = 16 * (colorId + 1);
  const put = (base, x, i) => { const c = pal[i]; const q = base + x * 4; img[q] = c[0]; img[q + 1] = c[1]; img[q + 2] = c[2]; img[q + 3] = 255; };
  for (let row = 0; row < H; row++) {
    const left = dv.getUint16(outOff + row * 4, true), right = dv.getUint16(outOff + row * 4 + 2, true);
    if (left === 0x8000 || right === 0x8000) continue;
    let p = dv.getUint32(cmdOff + row * 4, true);
    let x = left;
    const base = row * W * 4;
    for (;;) {
      const cmd = d[p++];
      const low = cmd & 0x0F;
      if (low === 0x0F) break;
      if ((cmd & 3) === 0) {                                     // lesser draw
        const n = cmd >> 2;
        if (x + n <= w) for (let k = 0; k < n; k++) put(base, x + k, d[p + k]);
        p += n; x += n;
      } else if ((cmd & 3) === 1) {                              // lesser skip
        let n = cmd >> 2;
        if (n === 0) n = d[p++];
        x += n;
      } else if (low === 0x02) {
        const n = ((cmd & 0xF0) << 4) + d[p++];
        if (x + n <= w) for (let k = 0; k < n; k++) put(base, x + k, d[p + k]);
        p += n; x += n;
      } else if (low === 0x03) {
        x += ((cmd & 0xF0) << 4) + d[p++];
      } else if (low === 0x06) {                                 // player color draw
        let n = cmd >> 4;
        if (n === 0) n = d[p++];
        if (x + n <= w) for (let k = 0; k < n; k++) put(base, x + k, Math.min(Math.max(d[p + k] + pc, 0), 255));
        p += n; x += n;
      } else if (low === 0x07) {                                 // fill
        let n = cmd >> 4;
        if (n === 0) n = d[p++];
        const c = d[p++];
        if (x + n <= w) for (let k = 0; k < n; k++) put(base, x + k, c);
        x += n;
      } else if (low === 0x0A) {                                 // player color fill
        let n = cmd >> 4;
        if (n === 0) n = d[p++];
        const c = Math.min(d[p++] + pc, 255);
        if (x + n <= w) for (let k = 0; k < n; k++) put(base, x + k, c);
        x += n;
      } else if (low === 0x0B) {                                 // shadow
        let n = cmd >> 4;
        if (n === 0) n = d[p++];
        if (x + n <= w) for (let k = 0; k < n; k++) {
          const q = base + (x + k) * 4;
          if (img[q + 3] === 0) { img[q] = img[q + 1] = img[q + 2] = 0; img[q + 3] = SHADOW_ALPHA; }
          else { img[q] = (img[q] * 100 / 255) | 0; img[q + 1] = (img[q + 1] * 100 / 255) | 0; img[q + 2] = (img[q + 2] * 100 / 255) | 0; }
        }
        x += n;
      } else if (low === 0x0E) {
        if (cmd === 0x4E || cmd === 0x5E) {
          if (x < w) { const q = base + x * 4; const c = cmd === 0x4E ? pal[Math.min(pc + 4, 255)] : [0, 0, 0];
            img[q] = c[0]; img[q + 1] = c[1]; img[q + 2] = c[2]; img[q + 3] = 255; }
          x += 1;
        } else if (cmd === 0x6E || cmd === 0x7E) {
          const n = d[p++];
          if (x + n <= w) { const c = cmd === 0x6E ? pal[Math.min(pc + 4, 255)] : [0, 0, 0];
            for (let k = 0; k < n; k++) { const q = base + (x + k) * 4; img[q] = c[0]; img[q + 1] = c[1]; img[q + 2] = c[2]; img[q + 3] = 255; } }
          x += n;
        }
      } else break;
    }
  }
  return { w: W, h: H, hx, hy, px: img };
}

// ---- ảnh RGB 4 byte / điểm ---------------------------------------------------------------------------------
export class RGB {
  constructor(w, h) { this.w = w; this.h = h; this.px = new Uint8Array(w * h * 4); }
}

// Image.paste(RGBA src, (x, y), mask=src) lên ảnh RGB, có cắt biên (mapcap/render_full.paste)
export function paste(dst, src, x, y) {
  const W = dst.w, H = dst.h;
  const x0 = Math.max(x, 0), y0 = Math.max(y, 0), x1 = Math.min(x + src.w, W), y1 = Math.min(y + src.h, H);
  if (x1 <= x0 || y1 <= y0) return;
  const D = dst.px, S = src.px;
  for (let yy = y0; yy < y1; yy++) {
    let o = (yy * W + x0) * 4, s = ((yy - y) * src.w + (x0 - x)) * 4;
    for (let xx = x0; xx < x1; xx++, o += 4, s += 4) {
      const a = S[s + 3];
      if (a === 255) { D[o] = S[s]; D[o + 1] = S[s + 1]; D[o + 2] = S[s + 2]; }
      else if (a !== 0) {
        for (let c = 0; c < 3; c++) {
          const t = D[o + c] * (255 - a) + S[s + c] * a + 128;
          D[o + c] = ((t >> 8) + t) >> 8;
        }
      }
    }
  }
}

// ---- Image.resize(BOX) của Pillow --------------------------------------------------------------------------
const PREC = 22;
function coeffs(inSize, in0, in1, outSize) {
  const scale = (in1 - in0) / outSize;
  const filterscale = Math.max(scale, 1.0);
  const support = 0.5 * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const kk = new Int32Array(outSize * ksize);
  const k = new Float64Array(ksize);
  const ss = 1.0 / filterscale;
  for (let xx = 0; xx < outSize; xx++) {
    const center = in0 + (xx + 0.5) * scale;
    let ww = 0.0;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    for (let x = 0; x < xmax; x++) {
      const t = (x + xmin - center + 0.5) * ss;
      const w = t > -0.5 && t <= 0.5 ? 1.0 : 0.0;
      k[x] = w; ww += w;
    }
    for (let x = 0; x < ksize; x++) {
      let v = x < xmax ? (ww !== 0.0 ? k[x] / ww : k[x]) : 0;
      kk[xx * ksize + x] = v < 0 ? Math.trunc(-0.5 + v * (1 << PREC)) : Math.trunc(0.5 + v * (1 << PREC));
    }
    bounds[xx * 2] = xmin; bounds[xx * 2 + 1] = xmax;
  }
  return { ksize, bounds, kk };
}
const clip8 = v => { v >>= PREC; return v < 0 ? 0 : v > 255 ? 255 : v; };

export function resizeBox(src, ow, oh) {
  const H = coeffs(src.w, 0, src.w, ow), V = coeffs(src.h, 0, src.h, oh);
  const yFirst = V.bounds[0], yLast = V.bounds[oh * 2 - 2] + V.bounds[oh * 2 - 1];
  // ngang: chỉ các hàng nguồn dùng tới
  const th = yLast - yFirst;
  const tmp = new RGB(ow, th);
  const S = src.px, T = tmp.px, half = 1 << (PREC - 1);
  for (let yy = 0; yy < th; yy++) {
    const row = (yy + yFirst) * src.w * 4;
    for (let xx = 0; xx < ow; xx++) {
      const xmin = H.bounds[xx * 2], xmax = H.bounds[xx * 2 + 1], ko = xx * H.ksize;
      let s0 = half, s1 = half, s2 = half;
      for (let x = 0; x < xmax; x++) {
        const q = row + (x + xmin) * 4, kv = H.kk[ko + x];
        s0 += S[q] * kv; s1 += S[q + 1] * kv; s2 += S[q + 2] * kv;
      }
      const o = (yy * ow + xx) * 4;
      T[o] = clip8(s0); T[o + 1] = clip8(s1); T[o + 2] = clip8(s2);
    }
  }
  const out = new RGB(ow, oh), O = out.px;
  for (let yy = 0; yy < oh; yy++) {
    const ymin = V.bounds[yy * 2] - yFirst, ymax = V.bounds[yy * 2 + 1], ko = yy * V.ksize;
    for (let xx = 0; xx < ow; xx++) {
      let s0 = half, s1 = half, s2 = half;
      for (let y = 0; y < ymax; y++) {
        const q = ((y + ymin) * ow + xx) * 4, kv = V.kk[ko + y];
        s0 += T[q] * kv; s1 += T[q + 1] * kv; s2 += T[q + 2] * kv;
      }
      const o = (yy * ow + xx) * 4;
      O[o] = clip8(s0); O[o + 1] = clip8(s1); O[o + 2] = clip8(s2);
    }
  }
  return out;
}

// out.paste(img, (0, y)) không mặt nạ: chép, cắt biên
function pasteOpaque(dst, src, x, y) {
  const x0 = Math.max(x, 0), y0 = Math.max(y, 0), x1 = Math.min(x + src.w, dst.w), y1 = Math.min(y + src.h, dst.h);
  if (x1 <= x0 || y1 <= y0) return;
  for (let yy = y0; yy < y1; yy++) {
    const s = ((yy - y) * src.w + (x0 - x)) * 4, o = (yy * dst.w + x0) * 4;
    dst.px.set(src.px.subarray(s, s + (x1 - x0) * 4), o);
  }
}

// thứ tự vẽ ô: (y - x) rồi (x + y) tăng dần (np.lexsort((x + y, y - x)))
export function depthOrder(w, h) {
  const order = new Int32Array(w * h);
  for (let k = 0; k < w * h; k++) order[k] = k;
  const key = new Float64Array(w * h);
  for (let k = 0; k < w * h; k++) { const y = (k / w) | 0, x = k - y * w; key[k] = (y - x) * 1e6 + (x + y); }
  order.sort((a, b) => key[a] - key[b]);
  return order;
}

// ---- địa hình ------------------------------------------------------------------------------------------------
// W: thế giới (replay/world.World), gd: gói dữ liệu game, store: {frame(slp, idx) -> RGBA ảnh hoặc null}
function terrainSource(gd, tid) {
  let t = gd.terrains[tid];
  for (let i = 0; i < 4; i++) {
    if (t.slp >= 0) return t;
    const nxt = t.toDraw >= 0 ? t.toDraw : t.repl;
    if (nxt < 0 || nxt === t.id) break;
    t = gd.terrains[nxt];
  }
  return t.slp >= 0 ? t : null;
}

function tileOps(W) {
  const hdr = W.hdr, gd = W.gd, w = W.map_w, h = W.map_h;
  const terr = hdr.terrain, shp = hdr.shape, tdx = hdr.tile_dx, tdy = hdr.tile_dy, tb = hdr.tile_border;
  const ops = [];
  for (const k of depthOrder(w, h)) {
    const y = (k / w) | 0, x = k - y * w;
    const tsrc = terrainSource(gd, terr[k]);
    if (!tsrc) continue;
    const shape = shp[k];
    const eg = shape < 17 ? tsrc.elev[shape] : tsrc.elev[0];
    let fidx;
    if (shape === 0 || eg[0] <= 0) {
      let rows = tsrc.dims[0], cols = tsrc.dims[1];
      if (!(rows > 0 && cols > 0)) { rows = 1; cols = 1; }
      fidx = Math.min((y % rows) * cols + (x % cols), Math.max(tsrc.elev[0][0], 1) - 1);
    } else fidx = eg[2];
    const fr = W.store.frame(tsrc.slp, fidx);
    if (!fr) continue;
    let px, py;
    if (tdx) { px = tdx[k]; py = tdy[k] + W.Y0 - TILE_H / 2; }
    else { px = (x + y) * (TILE_W / 2); py = (y - x) * (TILE_H / 2) - W.elev[k] * ELEV_H + W.Y0 - TILE_H / 2; }
    ops.push([fr, px - fr.hx, py - fr.hy]);
    if (tb) {
      const b = tb[k];
      if (b) {
        const bo = borderOp(W, b & 0xF, b >> 4, shape, px, py);
        if (bo) ops.push(bo);
      }
    }
  }
  return ops;
}

function borderOp(W, borderId, config, shape, px, py) {
  if (borderId in BORDER_SUBSTITUTE) {
    borderId = BORDER_SUBSTITUTE[borderId];
    if (borderId === null) return null;
  }
  const gd = W.gd;
  if (!(borderId >= 0 && borderId < gd.borders.length)) return null;
  const bd = gd.borders[borderId];
  if (!bd[0] || bd[1] < 0 || config > 11) return null;
  let f = bd[2][Math.min(shape, 18)][config];
  if (f[0] <= 0) {
    f = bd[2][0][config];
    if (f[0] <= 0) return null;
  }
  const fr = W.store.frame(bd[1], f[2]);
  if (!fr) return null;
  return [fr, px - fr.hx, py - fr.hy];
}

// -> RGB tex_w x tex_h ở tỉ lệ W.ts
export function buildTerrain(W, progress) {
  const ops = tileOps(W);
  const FW = W.full_w, FH = W.full_h, ts = W.ts;
  const out = new RGB(W.tex_w, W.tex_h);
  for (let b0 = 0; b0 < FH; b0 += BAND) {
    const b1 = Math.min(FH, b0 + BAND);
    let img = new RGB(FW, b1 - b0);
    for (const [im, x, y] of ops) {
      if (y + im.h > b0 && y < b1) paste(img, im, x, y - b0);
    }
    if (ts !== 1.0) {
      const th = pyRoundInt(b1 * ts) - pyRoundInt(b0 * ts);
      img = resizeBox(img, W.tex_w, Math.max(1, th));
    }
    pasteOpaque(out, img, 0, pyRoundInt(b0 * ts));
    if (progress) progress(b1 / FH);
  }
  return out;
}

// bản đồ chỉ số ô theo điểm ảnh ở tỉ lệ W.ts (replay/world.World.build_index)
export function buildIndex(W) {
  const hdr = W.hdr, w = W.map_w, h = W.map_h;
  const Wt = W.tex_w, Ht = W.tex_h, s = W.ts;
  const hw = TILE_W * s / 2, hh = TILE_H * s / 2;
  const sw = Math.ceil(TILE_W * s) + 2;
  const out = w * h;
  const idx = new Uint16Array(Wt * Ht).fill(out);
  const dh = Math.ceil(TILE_H * s) + 2;
  const cx = (sw - 1) / 2, cy = (Math.ceil(TILE_H * s) + 1) / 2;
  const diamond = new Uint8Array(dh * sw);
  for (let yy = 0; yy < dh; yy++) for (let xx = 0; xx < sw; xx++)
    diamond[yy * sw + xx] = (Math.abs(xx - cx) / (hw + 0.6) + Math.abs(yy - cy) / (hh + 0.6)) <= 1.0 ? 1 : 0;
  const tdx = hdr.tile_dx, tdy = hdr.tile_dy;
  const stamps = new Map();
  const mid = dh >> 1;
  for (const k of depthOrder(w, h)) {
    const y = (k / w) | 0, x = k - y * w;
    const elev = W.elev[k];
    let px, py;
    if (tdx) { px = tdx[k]; py = tdy[k] + W.Y0 - TILE_H / 2; }
    else { px = (x + y) * (TILE_W / 2); py = (y - x) * (TILE_H / 2) - elev * ELEV_H + W.Y0 - TILE_H / 2; }
    const vx = pyRoundInt(px * s) - 1, vy = pyRoundInt(py * s) - 1;
    const skirt = pyRoundInt(elev * ELEV_H * s) + (elev ? pyRoundInt(ELEV_H * s) : 0);
    const x0 = Math.max(vx, 0), y0 = Math.max(vy, 0);
    const x1 = Math.min(vx + sw, Wt), y1 = Math.min(vy + dh + skirt, Ht);
    if (x1 <= x0 || y1 <= y0) continue;
    let st = stamps.get(skirt);
    if (!st) {
      if (skirt) {
        st = new Uint8Array((dh + skirt) * sw);
        st.set(diamond, 0);
        for (let r = mid; r < Math.min(mid + skirt + 1, dh + skirt); r++)
          for (let c = 0; c < sw; c++) st[r * sw + c] |= diamond[mid * sw + c];
        for (let r = dh; r < dh + skirt; r++) for (let c = 0; c < sw; c++) st[r * sw + c] = diamond[mid * sw + c];
      } else st = diamond;
      stamps.set(skirt, st);
    }
    for (let yy = y0; yy < y1; yy++) {
      const sr = (yy - vy) * sw - vx, o = yy * Wt;
      for (let xx = x0; xx < x1; xx++) if (st[sr + xx]) idx[o + xx] = k;
    }
  }
  // lấp khe 1-3 px bằng ô kề: mỗi hướng lấy giá trị trước khi gán (như phép gán mảng của numpy)
  for (let pass = 0; pass < 3; pass++) {
    const holes = new Uint8Array(Wt * Ht);
    let any = false;
    for (let i = 0; i < idx.length; i++) if (idx[i] === out) { holes[i] = 1; any = true; }
    if (!any) break;
    for (const [sy, sx] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const fillI = [], fillV = [];
      for (let yy = Math.max(sy, 0); yy < Ht + Math.min(sy, 0); yy++) {
        for (let xx = Math.max(sx, 0); xx < Wt + Math.min(sx, 0); xx++) {
          const di = yy * Wt + xx;
          if (!holes[di]) continue;
          const v = idx[(yy - sy) * Wt + (xx - sx)];
          if (v !== out) { fillI.push(di); fillV.push(v); }
        }
      }
      for (let i = 0; i < fillI.length; i++) { idx[fillI[i]] = fillV[i]; holes[fillI[i]] = 0; }
    }
  }
  return idx;
}
