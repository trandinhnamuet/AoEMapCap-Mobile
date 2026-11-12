// Chạy bộ chuyển của điện thoại (web/js/rec/build.js) trên máy tính bằng Node để so với mapcap/webexport.py:
//   node tools/rec_build.mjs <file.aoerec> <sprites.pack> <gamedata.pack> <ra.aoeweb> [ảnh địa hình RGB thô] [info.json]
import { readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import { SpritePack } from "../web/js/sprites.js";
import { zlibSync } from "../web/js/vendor/fflate.js";
import { GameData, RecBuilder, packAoeweb, records } from "../web/js/rec/build.js";

const [rec, spr, gdp, out, rawOut, infoPath] = process.argv.slice(2);
const u8 = new Uint8Array(readFileSync(rec));
const pack = new SpritePack(new Uint8Array(readFileSync(spr)).buffer);
const gd = new GameData(new Uint8Array(readFileSync(gdp)).buffer);
const info = infoPath ? JSON.parse(readFileSync(infoPath, "utf8")) : null;
const t0 = performance.now();
const b = new RecBuilder(pack, gd, { info });
let first = true, tTerr = 0;
for (const r of records(u8)) {
  if (first) {
    if (r.tag !== "H") throw new Error("thiếu header");
    b.header(r.p);
    const t = performance.now();
    await b.terrain();
    tTerr = performance.now() - t;
    first = false;
    continue;
  }
  b.feed(r.tag, r.p);
}
const { meta, sections } = b.finish(basename(rec));
const buf = packAoeweb(meta, sections, zlibSync);
writeFileSync(out, buf);
if (rawOut) {
  const T = b.terrainRGB, rgb = new Uint8Array(T.w * T.h * 3);
  for (let i = 0, j = 0; i < T.w * T.h; i++, j += 3) { rgb[j] = T.px[i * 4]; rgb[j + 1] = T.px[i * 4 + 1]; rgb[j + 2] = T.px[i * 4 + 2]; }
  writeFileSync(rawOut, rgb);
}
console.log(JSON.stringify({ seconds: +((performance.now() - t0) / 1000).toFixed(1), terrain_s: +(tTerr / 1000).toFixed(1),
  frames: meta.frames, keys: meta.keys, pieces: meta.pieces, size: buf.length }));
