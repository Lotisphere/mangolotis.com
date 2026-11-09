// Knights' Domain page background: a baked game-style render of the cathedral (color.png) plus the
// pixel-3d-shader-ta data map (data.png) and effect maps, graded live by a 32x16 palette lookup, then
// quantised and dithered, with rain, breathing light shafts, rippling puddles and a dither shimmer.
// No 3D models or game textures are loaded: only rendered images.
import { KDShade } from './kd_shade.js';

const canvas = document.getElementById('bg');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const small = matchMedia('(max-width: 820px), (pointer: coarse)').matches;

async function bitmap(url) {
  const blob = await (await fetch(url)).blob();
  return createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
}

async function start() {
  if (small || !canvas || typeof createImageBitmap !== 'function') return;
  const glsl = await (await fetch('js/rw_levelcolor.glsl')).text();
  const names = { uData: 'data', uRefl: 'refl', uFx: 'fx', uPal: 'pal_night', uPal2: 'pal_dusk', uDecalTex: 'decal', uColor: 'color', uReflColor: 'reflcolor' };
  const maps = await Promise.all(Object.values(names).map(n => bitmap(`bg/${n}.png`)));
  canvas.width = maps[0].width; canvas.height = maps[0].height;           // render at the data map's own resolution
  const sh = new KDShade(canvas, glsl);
  Object.keys(names).forEach((u, i) => sh.setTexture(u, maps[i]));
  sh.u.uEffA = [0.31, 0.48, 0.2]; sh.u.uEffB = [0.78, 0.63, 0.31];

  const FRAME = 1000 / 30;                                                  // 30 fps is plenty for pixel art
  let last = 0, t0 = performance.now(), running = true;
  const draw = now => {
    const t = (now - t0) / 1000;
    sh.render({
      uTime: reduce ? 3.2 : t,
      uRain: 0.55,
      uFade: 0.22 + 0.22 * Math.sin(t * 0.11),                             // olive rain <-> a little brighter
      uShaft: 0.9 + 0.16 * Math.sin(t * 0.45) + 0.06 * Math.sin(t * 1.3),   // light shafts breathe
      uRainLayer: reduce ? 0 : 1, uPuddle: 1, uSplash: reduce ? 0 : 1, uVignette: 0.55, uGrime: 0.75,
      uFog: 0.25, uOutline: 0.35, uFogBands: 0.22,
      uGame: 1, uPalMix: 0.16, uGrade: 0.4, uLevels: 15, uDitherNoise: 0.8, uShimmer: reduce ? 0 : 8,   // grainy dither shimmers
      uGlass: 0.85 + 0.15 * Math.sin(t * 0.45 + 0.6),                       // stained glass glows with the shafts
    });
  };
  const loop = now => {
    if (!running) return;
    if (now - last >= FRAME) { last = now; draw(now); }
    requestAnimationFrame(loop);
  };
  draw(performance.now());
  document.body.classList.add('gl-on');
  if (!reduce) requestAnimationFrame(loop);
  document.addEventListener('visibilitychange', () => {
    running = !document.hidden && !reduce;
    if (running) requestAnimationFrame(loop);
  });
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); running = false; document.body.classList.remove('gl-on'); });
}

start().catch(e => { console.warn('background shader off:', e); document.body.classList.remove('gl-on'); });
