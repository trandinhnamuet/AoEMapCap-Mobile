// Vẽ bằng WebGL2: địa hình (ô ảnh JPEG) + sương mù theo pixel (bản đồ chỉ số ô), sprite instanced từ atlas
// (2 byte / pixel: chỉ số màu + loại), bảng màu và màu quân trong shader. Toạ độ thế giới = pixel gốc của game.

const VS_TERRAIN = `#version 300 es
in vec2 a_corner;
uniform vec4 u_rect;       // x, y, w, h (thế giới)
uniform vec4 u_cam;        // tâm x, y, zoom, 0
uniform vec2 u_view;       // cỡ khung vẽ (pixel)
out vec2 v_uv; out vec2 v_world;
void main() {
  vec2 w = u_rect.xy + a_corner * u_rect.zw;
  v_uv = a_corner; v_world = w;
  vec2 c = (w - u_cam.xy) * u_cam.z * 2.0 / u_view;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`;

const FOG_FN = `
uniform highp usampler2D u_index;
uniform sampler2D u_fog;
uniform float u_iscale; uniform int u_mapw; uniform int u_out;
float fogAt(vec2 w) {
  ivec2 sz = textureSize(u_index, 0);
  ivec2 p = clamp(ivec2(floor(w * u_iscale)), ivec2(0), sz - 1);
  int id = int(texelFetch(u_index, p, 0).r);
  if (id >= u_out) return 0.0;
  return texelFetch(u_fog, ivec2(id % u_mapw, id / u_mapw), 0).r;
}`;

const FS_TERRAIN = `#version 300 es
precision highp float; precision highp int;
in vec2 v_uv; in vec2 v_world;
uniform sampler2D u_tex;
${FOG_FN}
out vec4 o;
void main() { o = vec4(texture(u_tex, v_uv).rgb * fogAt(v_world), 1.0); }`;

const VS_SPRITE = `#version 300 es
in vec4 a_rect;            // x0, y0, w, h (thế giới, nguyên)
in vec4 a_atlas;           // x, y, lớp, lật
in vec2 a_style;           // màu quân, độ sáng (-1 = sương mù theo pixel)
uniform vec4 u_cam; uniform vec2 u_view;
out vec2 v_local; out vec2 v_world;
flat out vec4 v_atlas; flat out vec2 v_style; flat out vec2 v_size;
void main() {
  int vid = gl_VertexID;
  vec2 c = vec2((vid == 1 || vid == 2 || vid == 4) ? 1.0 : 0.0, (vid == 2 || vid == 4 || vid == 5) ? 1.0 : 0.0);
  vec2 w = a_rect.xy + c * a_rect.zw;
  v_local = c * a_rect.zw; v_world = w;
  v_atlas = a_atlas; v_style = a_style; v_size = a_rect.zw;
  vec2 p = (w - u_cam.xy) * u_cam.z * 2.0 / u_view;
  gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
}`;

const FS_SPRITE = `#version 300 es
precision highp float; precision highp int;
in vec2 v_local; in vec2 v_world;
flat in vec4 v_atlas; flat in vec2 v_style; flat in vec2 v_size;
uniform highp sampler2DArray u_atlas;
uniform sampler2D u_pal;
${FOG_FN}
out vec4 o;
void main() {
  int w = int(v_size.x), h = int(v_size.y);
  int ix = clamp(int(floor(v_local.x)), 0, w - 1), iy = clamp(int(floor(v_local.y)), 0, h - 1);
  if (v_atlas.w > 0.5) ix = w - 1 - ix;
  vec2 t = texelFetch(u_atlas, ivec3(int(v_atlas.x) + ix, int(v_atlas.y) + iy, int(v_atlas.z)), 0).rg;
  int idx = int(t.r * 255.0 + 0.5), type = int(t.g * 255.0 + 0.5);
  if (type == 0) discard;
  float b = v_style.y < 0.0 ? fogAt(v_world) : v_style.y;
  if (type == 3) { o = vec4(0.0, 0.0, 0.0, 110.0 / 255.0); return; }
  if (type == 4) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  if (type == 2) idx = min(16 * (int(v_style.x) + 1) + idx, 255);
  o = vec4(texelFetch(u_pal, ivec2(idx, 0), 0).rgb * b, 1.0);
}`;

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("shader: " + gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
  return { p, u };
}

// Atlas: texture mảng RG8, xếp kệ; đầy thì xoá hết (generation tăng, các lô dựng lại).
export class Atlas {
  constructor(gl, size, layers) {
    this.gl = gl; this.size = size; this.layers = layers;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RG8, size, size, layers);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.generation = 0;
    this.clear();
  }

  clear() {
    this.map = new Map();
    this.layer = 0; this.x = 0; this.y = 0; this.rowH = 0;
    this.generation++;
  }

  // vị trí {x, y, layer, w, h} của ảnh đã giải mã img ({w, h, px}); null nếu atlas đầy
  add(key, img) {
    const pad = 1;
    const w = img.w, h = img.h;
    if (w + pad > this.size || h + pad > this.size) { this.map.set(key, null); return null; }
    if (this.x + w + pad > this.size) { this.x = 0; this.y += this.rowH; this.rowH = 0; }
    if (this.y + h + pad > this.size) {
      this.layer++; this.x = 0; this.y = 0; this.rowH = 0;
      if (this.layer >= this.layers) return undefined;
    }
    const e = { x: this.x, y: this.y, layer: this.layer, w, h };
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, e.x, e.y, e.layer, w, h, 1, gl.RG, gl.UNSIGNED_BYTE, img.px);
    this.x += w + pad;
    this.rowH = Math.max(this.rowH, h + pad);
    this.map.set(key, e);
    return e;
  }
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: true,
                                             preserveDrawingBuffer: true });
    if (!gl) throw new Error("Trình duyệt không hỗ trợ WebGL2");
    this.gl = gl; this.canvas = canvas;
    this.terrainProg = compile(gl, VS_TERRAIN, FS_TERRAIN);
    this.spriteProg = compile(gl, VS_SPRITE, FS_SPRITE);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);
    this.terrainVao = gl.createVertexArray();
    gl.bindVertexArray(this.terrainVao);
    const loc = gl.getAttribLocation(this.terrainProg.p, "a_corner");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.batches = { statics: this._batch(), units: this._batch() };
    this.tiles = [];
    const maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
    this.atlas = new Atlas(gl, 2048, Math.min(6, maxLayers));
  }

  _batch() {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const P = this.spriteProg.p;
    const attrs = [["a_rect", 4, 0], ["a_atlas", 4, 16], ["a_style", 2, 32]];
    for (const [name, size, off] of attrs) {
      const l = gl.getAttribLocation(P, name);
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, size, gl.FLOAT, false, 40, off);
      gl.vertexAttribDivisor(l, 1);
    }
    gl.bindVertexArray(null);
    return { vao, buf, count: 0 };
  }

  setBatch(name, data, count) {
    const gl = this.gl, b = this.batches[name];
    gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * 10), gl.DYNAMIC_DRAW);
    b.count = count;
  }

  async setTerrain(meta, sectionBlob) {
    const gl = this.gl;
    const ts = meta.terrain.scale;
    for (const t of meta.terrain.tiles) {
      const bmp = await createImageBitmap(sectionBlob(t.section));
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE, bmp);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      bmp.close && bmp.close();
      this.tiles.push({ tex, rect: [t.x / ts, t.y / ts, t.w / ts, t.h / ts] });
    }
  }

  setIndex(meta, index) {
    const gl = this.gl;
    this.indexTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.indexTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, meta.index.w, meta.index.h, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, index);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    this.iscale = meta.index.scale;
    this.mapW = meta.map_w; this.mapH = meta.map_h;
    this.fogTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fogTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.mapW, this.mapH, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
  }

  setFog(fog) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.fogTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.mapW, this.mapH, gl.RED, gl.UNSIGNED_BYTE, fog);
  }

  setPalette(pal) {
    const gl = this.gl;
    const d = new Uint8Array(256 * 4);
    pal.forEach((c, i) => { d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255; });
    this.palTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.palTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
  }

  _fogUniforms(u) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.indexTex); gl.uniform1i(u.u_index, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.fogTex); gl.uniform1i(u.u_fog, 2);
    gl.uniform1f(u.u_iscale, this.iscale);
    gl.uniform1i(u.u_mapw, this.mapW);
    gl.uniform1i(u.u_out, this.mapW * this.mapH);
  }

  draw(cam) {
    const gl = this.gl, c = this.canvas;
    gl.viewport(0, 0, c.width, c.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // địa hình
    let P = this.terrainProg;
    gl.useProgram(P.p);
    gl.uniform4f(P.u.u_cam, cam.x, cam.y, cam.zoom, 0);
    gl.uniform2f(P.u.u_view, c.width, c.height);
    this._fogUniforms(P.u);
    gl.bindVertexArray(this.terrainVao);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(P.u.u_tex, 0);
    for (const t of this.tiles) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.uniform4f(P.u.u_rect, ...t.rect);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    // sprite: vật thể tĩnh rồi unit
    P = this.spriteProg;
    gl.useProgram(P.p);
    gl.uniform4f(P.u.u_cam, cam.x, cam.y, cam.zoom, 0);
    gl.uniform2f(P.u.u_view, c.width, c.height);
    this._fogUniforms(P.u);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlas.tex); gl.uniform1i(P.u.u_atlas, 0);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.palTex); gl.uniform1i(P.u.u_pal, 3);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const name of ["statics", "units"]) {
      const b = this.batches[name];
      if (!b.count) continue;
      gl.bindVertexArray(b.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, b.count);
    }
    gl.bindVertexArray(null);
  }
}
