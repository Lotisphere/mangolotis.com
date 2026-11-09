// rw_levelcolor.glsl — runtime decode + palette shading for the Rain World data image.
// GLSL ES 3.00 chunk. The host prepends "#version 300 es" + precision (three.js with
// glslVersion: THREE.GLSL3 does that for you) and then calls rwDecode / rwShade.
// Contract: docs/DESIGN.md §2.1 (data image) and §2.2 (palette).
// Reconstruction of the game's LevelColor shader from community docs (RWLevelKey.md):
// the palette lookup is exact, the effect / decal / grime / fog blends are approximations.

uniform sampler2D uData;       // data image, RGBA8, nearest, linear (not sRGB), row 0 = top
uniform sampler2D uPal;        // palette 32x16 (rows 0-7 dry, 8-15 rain)
uniform sampler2D uPal2;       // fade-to palette (bind uPal again when unused)
uniform sampler2D uDecalTex;   // 256x1, x = decal index
uniform float uRain;           // 0..1 dry -> rain half of the palette
uniform float uFade;           // 0..1 uPal -> uPal2
uniform float uFog;            // 0..1 extra room fog
uniform float uGrime;          // 0..1 grime strength on edge pixels
uniform vec3  uEffA, uEffB;    // effect colours A / B (linear 0..1)

struct RWPixel {
  bool sky, lit, edge, decal, dark;
  int face;     // 0 underside (red), 1 front (green), 2 highlight (blue)
  int depth;    // 0..29 (data value is 1..30)
  int eff;      // 0 none, 1 A, 2 B, 3 C
  float b;      // blue channel 0..255
};

// --- small noise helpers (prefixed to avoid clashes with host code)
float rwHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float rwNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(rwHash(i), rwHash(i + vec2(1, 0)), f.x), mix(rwHash(i + vec2(0, 1)), rwHash(i + 1.), f.x), f.y); }
float rwFbm(vec2 p) { float s = 0., a = .5; for (int i = 0; i < 4; i++) { s += a * rwNoise(p); p *= 2.03; a *= .5; } return s; }

RWPixel rwDecodeTexel(vec4 t) {          // t = texel * 255
  RWPixel px;
  px.sky = t.r > 254.5 && t.g > 254.5;
  float r = t.r;
  px.lit = r > 90.5; if (px.lit) r -= 90.;
  px.face = int(clamp(floor((r - 1.) / 30.), 0., 2.));
  px.depth = int(mod(r - 1., 30.) + .5);
  int g = int(t.g + .5);
  px.dark = g >= 16;  if (px.dark) g -= 16;
  px.decal = g >= 8;  if (px.decal) g -= 8;
  px.edge = g >= 4;   if (px.edge) g -= 4;
  px.eff = g & 3;
  px.b = t.b;
  return px;
}
RWPixel rwDecode(ivec2 ip) { return rwDecodeTexel(texelFetch(uData, ip, 0) * 255.); }

vec3 rwPal1(sampler2D pal, int col, int row) {
  return mix(texelFetch(pal, ivec2(col, row), 0).rgb, texelFetch(pal, ivec2(col, row + 8), 0).rgb, uRain);
}
vec3 rwPal(int col, int row) { return mix(rwPal1(uPal, col, row), rwPal1(uPal2, col, row), uFade); }
vec3 rwSkyColor() { return rwPal(0, 0); }
vec3 rwFogColor() { return rwPal(1, 0); }

// Shade one non-sky pixel. dynShadow = a runtime object occludes the sun here (RWLevelKey
// red #5: only for depth >= 5 and lit pixels; the caller decides).
vec3 rwShade(RWPixel px, vec2 fragPx, bool dynShadow) {
  vec3 fogC = rwFogColor();
  bool L = px.lit && !dynShadow;
  float d = float(px.depth);
  int row = (L ? 2 : 5) + (2 - px.face);
  int col = (px.dark && L) ? 0 : px.depth;           // "platform colouring": darkest tone of the row
  vec3 c = rwPal(col, row);

  if (px.eff == 1 || px.eff == 2) {                  // effect colour, weaker in shade
    vec3 ec = px.eff == 1 ? uEffA : uEffB;
    if (!L) ec *= .5;
    ec = mix(ec, fogC, pow(d / 30., 1.2) * .7);
    c = mix(c, ec, px.b / 255.);
  } else if (px.eff == 3) {                          // "C": white (swarm rooms in the game)
    c = mix(c, vec3(1.), px.b / 255.);
  } else if (px.decal) {                             // decal / prop colour (RWLevelKey appendix)
    int idx = 256 - int(px.b + .5);
    vec3 dc = texelFetch(uDecalTex, ivec2(clamp(idx, 0, 255), 0), 0).rgb;
    float light = L ? 1. : 0.;
    if (px.face == 2) dc = mix(dc, vec3(1.), .2 - light * .1);
    dc = mix(dc, fogC, d / 60.);
    vec3 faded = mix(c, dc, .7), multiplied = c * dc * 1.5;
    float groggy = mix(.9, .3 + .4 * light, clamp((d - 3.5) * .3, 0., 1.));
    c = mix(faded, multiplied, groggy);
  }

  if (px.edge && uGrime > 0.) {                      // grime: palette row 1, offset by depth
    float n = rwFbm(fragPx * .25);
    c = mix(c, rwPal(int(mod(d * 2. + n * 12., 32.)), 1), uGrime * .55 * smoothstep(.3, .7, n));
  }

  if (uFog > 0.) {                                   // RWLevelKey red #7: full from depth 10, ramp before
    float w = clamp((d + 1.) / 10., 0., 1.);
    if (px.dark && px.depth < 10) w *= .5;
    c = mix(c, fogC, uFog * w * (.35 + .65 * d / 29.));
  }
  return c;
}

vec3 rwSky(vec2 fragPx, vec2 res) {
  return mix(rwSkyColor(), rwFogColor(), smoothstep(0., 1., fragPx.y / res.y));
}

// Debug views. 1 raw data, 2 depth, 3 lit mask, 4 face, 5 G/B flags, 6 palette.
vec3 rwDebug(int view, RWPixel px, vec4 raw255, vec2 fragPx, vec2 res) {
  float d = float(px.depth);
  if (view == 1) return raw255.rgb / 255.;
  if (view == 2) return vec3(px.sky ? 0. : 1. - d / 30.);
  if (view == 3) return px.sky ? vec3(0) : (px.lit ? vec3(1., .94, .78) : vec3(.14, .18, .32)) * (1. - d / 45.);
  if (view == 4) { vec3 c = px.face == 0 ? vec3(1, 0, 0) : px.face == 1 ? vec3(0, 1, 0) : vec3(0, 0, 1); return px.sky ? vec3(0) : c * (1. - d / 45.); }
  if (view == 5) {
    if (px.sky) return vec3(.07);
    vec3 c = vec3(.16);
    if (px.eff == 1) c = vec3(1, 0, 1) * (.25 + .75 * px.b / 255.);
    if (px.eff == 2) c = vec3(0, 1, 1) * (.25 + .75 * px.b / 255.);
    if (px.decal) c = vec3(1., .5, .1);
    if (px.dark) c = vec3(.5);
    if (px.edge) c = vec3(1., .85, 0.);
    return c;
  }
  if (view == 6) return texelFetch(uPal, ivec2(fragPx.x / res.x * 32., fragPx.y / res.y * 16.), 0).rgb;
  return vec3(1, 0, 1);
}
