// kd_shade.js — Knights' Domain runtime shader (raw WebGL2, no three.js).
// Shared by the key-art renderer (art/scene) and the website background (knightsdomain/).
//
// Inputs (all RGBA8, nearest, no colour conversion, row 0 = top of the picture):
//   data  : Rain World data image (pixel-3d-shader-ta contract, DESIGN.md §2.1)
//   refl  : the same contract, rendered with the world mirrored in the floor plane (puddles)
//   fx    : R = light-shaft density, G = puddle mask, B = rain volume (Knights' Domain extension)
//   pal / pal2 : 32x16 palettes (DESIGN.md §2.2); uFade blends pal -> pal2
// The palette lookup itself is templates/webgl/rw_levelcolor.glsl, passed in unchanged.

const VS = `#version 300 es
in vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS = glsl => `#version 300 es
precision highp float;
precision highp int;
${glsl}
uniform sampler2D uRefl, uFx, uColor, uReflColor;   // uColor/uReflColor: game-style textured colour pass (round 3)
uniform vec2 uLowRes, uScreenRes, uOffset;
uniform float uTime, uShaft, uRainLayer, uVignette, uPuddle, uSplash, uSkyGlow, uGlass, uOutline, uFogBands;
uniform float uGame, uPalMix, uGrade, uLevels, uDitherNoise, uShimmer;
out vec4 outColor;

float bayer4(ivec2 p) {
  int i = (p.x & 3) + 4 * (p.y & 3);
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[i]) + 0.5) / 16.0;
}
float rainAt(vec2 p, float k) {          // from templates/three/rw_three.js, slanted, 3 layers
  float cw = 4. + k * 2.;
  vec2 q = vec2(p.x + p.y * .16, p.y);
  float cell = floor(q.x / cw), h = rwHash(vec2(cell, k * 13.7 + 1.));
  if (h > .1 + .8 * uRain) return 0.;
  float fx = q.x - cell * cw - floor(fract(h * 5.7) * (cw - 2.));
  if (fx < 0. || fx >= 1.) return 0.;
  float speed = (300. - k * 60.) * (.8 + .4 * fract(h * 7.3));
  float len = 9. - k * 2., per = len * (4. + fract(h * 3.1) * 6.);
  float s = mod(q.y - uTime * speed + h * 1000., per);
  if (s > len) return 0.;
  return (s / len) * (.65 - k * .12);
}
// stained glass = decals 9..12, drawn emissive (lit from behind), slightly fogged by depth
bool glassColor(RWPixel px, out vec3 c) {
  if (!px.decal) return false;
  int idx = 256 - int(px.b + .5);
  if (idx < 9 || idx > 12) return false;
  c = texelFetch(uDecalTex, ivec2(idx, 0), 0).rgb * (.6 + .7 * uGlass);
  c = mix(c, rwFogColor(), float(px.depth) / 60.);
  return true;
}
vec3 surface(RWPixel px, vec2 p) {
  vec3 c; if (glassColor(px, c)) return c;
  return rwShade(px, p, false);
}
int depthAt(ivec2 q) {
  q = clamp(q, ivec2(0), ivec2(uLowRes) - 1);
  RWPixel n = rwDecodeTexel(texelFetch(uData, q, 0) * 255.);
  return n.sky ? 30 : n.depth;
}
void main() {
  vec2 fc = vec2(gl_FragCoord.x, uScreenRes.y - gl_FragCoord.y) + uOffset;   // y down
  ivec2 ip = ivec2(floor(fc * uLowRes / uScreenRes));
  ip = clamp(ip, ivec2(0), ivec2(uLowRes) - 1);
  vec2 p = vec2(ip);
  vec4 raw = texelFetch(uData, ip, 0) * 255.;
  RWPixel px = rwDecodeTexel(raw);
  vec4 fx = texelFetch(uFx, ip, 0);
  vec3 fogC = rwFogColor();
  float sceneD = px.sky ? 30. : float(px.depth);
  vec3 col;
  vec3 game = texelFetch(uColor, ip, 0).rgb;
  if (px.sky) {
    col = rwSky(p, uLowRes);
    float cl = rwFbm(p * vec2(.018, .05) + vec2(uTime * .04, 0.));
    col = mix(col, fogC * .9, smoothstep(.42, .78, cl) * (.4 + .4 * uRain));
    // windows the light comes through glow with the beam that starts there
    col = mix(col, mix(rwPal(0, 2), vec3(1.), .25), clamp(fx.r * uSkyGlow, 0., 1.));
    if (uGame > .5) col = mix(game, col, uPalMix);
  } else {
    col = surface(px, p);
    // game style: the textured, lit colour pass carries the materials; the palette lookup (lit/shade x face x
    // depth column) is blended in as the grade, so aerial perspective and the light/shade mood still come from it
    if (uGame > .5) col = mix(game, col * (.55 + .9 * dot(game, vec3(.3, .55, .15))), uPalMix);
    // Rain World style silhouette outline: pixels on the near side of a depth step get the deep shade tone
    if (uOutline > 0. && px.depth < 20) {
      int dm = max(max(depthAt(ip + ivec2(1, 0)), depthAt(ip - ivec2(1, 0))), max(depthAt(ip + ivec2(0, 1)), depthAt(ip - ivec2(0, 1))));
      if (dm - px.depth >= 3) col = mix(col, rwPal(px.depth, 7) * .5, uOutline);
    }
    // layered depth fog: stepped bands every 4 sheets, so the nave recedes in planes
    col = mix(col, fogC, uFogBands * pow(floor(sceneD / 4.) / 7., 1.3));
    col = mix(col, fogC, uRain * .22 * pow(sceneD / 29., 1.4));
  }

  // puddles: the mirrored data image, rippled by whole pixels
  if (fx.g > .5 && uPuddle > 0.) {
    float n = rwNoise(vec2(p.x * .3, p.y * 1.7 - uTime * 1.6));
    int ox = int(floor((n - .5) * 2.6 + .5));
    ivec2 rp = clamp(ip + ivec2(ox, 0), ivec2(0), ivec2(uLowRes) - 1);
    RWPixel r = rwDecodeTexel(texelFetch(uRefl, rp, 0) * 255.);
    vec3 rc = r.sky ? mix(rwSkyColor(), fogC, .4) : surface(r, vec2(rp));
    if (uGame > .5) rc = mix(texelFetch(uReflColor, rp, 0).rgb, rc, uPalMix * .6);
    float k = uPuddle * (.55 + .2 * n);
    col = mix(col, rc * vec3(.86, .94, 1.0), k);
    // splashes: one-frame sparkles + short-lived rings, quantised to whole pixels
    float tt = floor(uTime * 10.);
    float h = rwHash(p + vec2(tt * 3.1, tt * 7.7));
    if (h > 1. - .012 * uSplash) col = mix(col, rwPal(4, 2), .55);
  }

  // light shafts: posterised + ordered dither, coloured by the palette's lit highlight
  float s = fx.r * uShaft;
  s = floor(s * 7. + bayer4(ip)) / 7.;
  vec3 shaftC = mix(rwPal(3, 2), rwPal(10, 2), .5);
  col = mix(col, shaftC, clamp(s * .5, 0., .78)) + shaftC * s * .14;

  // rain streaks, masked by the rain volume (falls through the broken roof) and the sky
  if (uRainLayer > 0. && uRain > .01) {
    vec3 rainC = mix(fogC, vec3(.9, .95, 1.), .4);
    float mask = px.sky ? 1. : clamp(.18 + fx.b * 1.4, 0., 1.);
    float RD[3] = float[3](2., 8., 16.);
    for (int k = 0; k < 3; k++) if (sceneD > RD[k]) col = mix(col, rainC, rainAt(p, float(k)) * min(1., uRain * 1.5) * mask * uRainLayer);
  }
  vec2 uv = p / uLowRes - .5; col *= 1. - dot(uv, uv) * uVignette;
  // warm green-olive grade, then the game's colour quantisation with ordered + noise dither (grainy pixels)
  if (uGrade > 0.) { col = mix(col, col * vec3(1.05, 1.08, .84), uGrade); col = mix(col, smoothstep(0., 1., col), uGrade * .35); }
  if (uLevels > 0.) {
    float n = bayer4(ip) + (rwHash(p + floor(uTime * uShimmer) * vec2(13.1, 7.7)) - .5) * uDitherNoise;
    col = floor(clamp(col, 0., 1.) * uLevels + n) / uLevels;
  }
  outColor = vec4(clamp(col, 0., 1.), 1.0);
}`;

export class KDShade {
  constructor(canvas, levelColorGLSL, opt = {}) {
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: !!opt.preserve, premultipliedAlpha: false, alpha: false, powerPreference: 'low-power' });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl; this.canvas = canvas;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS(levelColorGLSL)));
    gl.bindAttribLocation(pr, 0, 'aPos'); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    this.pr = pr; gl.useProgram(pr);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.loc = {}; this.tex = {};
    const names = ['uData', 'uPal', 'uPal2', 'uDecalTex', 'uRefl', 'uFx', 'uColor', 'uReflColor'];
    names.forEach((n, i) => { gl.uniform1i(gl.getUniformLocation(pr, n), i); });
    this.units = Object.fromEntries(names.map((n, i) => [n, i]));
    this.u = { uRain: .6, uFade: 0, uFog: 0, uGrime: .6, uTime: 0, uShaft: 1, uRainLayer: 1, uVignette: .45, uPuddle: 1, uSplash: 1, uSkyGlow: 2.5, uGlass: 1, uOutline: .7, uFogBands: .45, uGame: 0, uPalMix: .25, uGrade: 0, uLevels: 0, uDitherNoise: 0, uShimmer: 0,
      uEffA: [.31, .48, .23], uEffB: [.78, .63, .31], uOffset: [0, 0] };
    this.lowRes = [1, 1];
  }
  // src: { w, h, data: Uint8Array (row 0 = top) } or an ImageBitmap decoded with colorSpaceConversion:'none'
  setTexture(name, src) {
    const gl = this.gl; let t = this.tex[name];
    if (!t) { t = this.tex[name] = gl.createTexture(); }
    gl.activeTexture(gl.TEXTURE0 + this.units[name]); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (src.data) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, src.w, src.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, src.data);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (name === 'uData') this.lowRes = [src.w ?? src.width, src.h ?? src.height];
  }
  render(over = {}) {
    const gl = this.gl, u = Object.assign(this.u, over), pr = this.pr;
    gl.useProgram(pr);
    for (const [k, v] of Object.entries(u)) {
      const l = gl.getUniformLocation(pr, k); if (!l) continue;
      Array.isArray(v) ? (v.length === 2 ? gl.uniform2fv(l, v) : gl.uniform3fv(l, v)) : gl.uniform1f(l, v);
    }
    gl.uniform2fv(gl.getUniformLocation(pr, 'uLowRes'), this.lowRes);
    gl.uniform2fv(gl.getUniformLocation(pr, 'uScreenRes'), [this.canvas.width, this.canvas.height]);
    for (const [n, i] of Object.entries(this.units)) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, this.tex[n] || null); }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
