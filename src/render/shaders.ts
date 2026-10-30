// GLSL ES 3.00 shaders. All passes share u_cam = (cx, cy, sx, sy) and the
// camera's quarter turn u_rot = (cos, sin) (#98): clip = rot(world - c) * s.
// u_px = world units per device pixel.

export const BG_VS = `#version 300 es
layout(location=0) in vec2 a_q;
void main(){ gl_Position = vec4(a_q, 0., 1.); }`;

export const BG_FS = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform vec3 u_view; // cx, cy, world units per pixel
uniform vec2 u_rot;  // the camera's turn: cos, sin
uniform vec2 u_map;
uniform float u_time;
uniform sampler2D u_ter;
uniform float u_terOn;
uniform vec4 u_texel; // terrain texture: uv per world px, half-texel offset
out vec4 o;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float gridLine(vec2 w, float step, float px){
  vec2 g = abs(fract(w / step - 0.5) - 0.5) * step / px;
  return 1.0 - min(min(g.x, g.y), 1.0);
}
void main(){
  vec2 fc = gl_FragCoord.xy - u_res * 0.5;
  vec2 so = vec2(fc.x, -fc.y) * u_view.z;
  vec2 w = u_view.xy + vec2(u_rot.x * so.x + u_rot.y * so.y, -u_rot.y * so.x + u_rot.x * so.y);
  float px = u_view.z;
  vec2 dB = min(w, u_map - w);
  float db = min(dB.x, dB.y);
  float inside = step(0.0, db);
  vec3 base = mix(vec3(0.010, 0.010, 0.022), vec3(0.030, 0.034, 0.068), inside);
  // subtle radial lift toward the map center
  vec2 mc = (w / u_map) - 0.5;
  base += vec3(0.012, 0.010, 0.030) * (1.0 - dot(mc, mc) * 2.0) * inside;
  float minor = gridLine(w, 40.0, px) * smoothstep(3.0, 1.2, px);
  float major = gridLine(w, 200.0, px);
  vec3 col = base + vec3(0.05, 0.07, 0.13) * (minor * 0.45 + major * 0.7) * mix(0.25, 1.0, inside);
  if (u_terOn > 0.5 && inside > 0.0) {
    // Terrain baked to a texture: r = wall distance, g = nebula, b = rift distance.
    vec4 t = texture(u_ter, w * u_texel.xy + u_texel.zw);
    float wd = t.r * 64.0 - 24.0;
    float neb = t.g;
    float rd = t.b * 32.0 - 16.0;
    float n1 = vnoise(w * 0.011 + vec2(u_time * 0.025, 0.0));
    float n2 = vnoise(w * 0.029 - vec2(0.0, u_time * 0.04));
    // Nebula: drifting violet haze.
    col += vec3(0.15, 0.07, 0.28) * neb * (0.35 + 0.5 * n1 + 0.3 * n2);
    col += vec3(0.30, 0.20, 0.55) * neb * smoothstep(0.82, 0.95, n2) * 0.25;
    // Rift: a glowing red seam with embers flowing along it.
    float rin = 1.0 - smoothstep(-px, px, rd);
    float flow = vnoise(vec2(w.x * 0.05 + u_time * 1.2, w.y * 0.05 - u_time * 0.8));
    col = mix(col, vec3(0.10, 0.012, 0.025), rin * 0.85);
    col += vec3(0.85, 0.14, 0.10) * (rin * (0.12 + 0.45 * flow * flow) + exp(-abs(rd) / (px * 2.0 + 1.2)) * 0.55);
    // Walls: dark slate rock, hatched, with a beveled cool rim and a drop shadow.
    float win = 1.0 - smoothstep(-px, px, wd);
    col *= 1.0 - 0.45 * exp(-max(wd, 0.0) / 9.0) * (1.0 - win);
    float hatch = step(abs(fract((w.x + w.y) / 13.0) - 0.5), 0.07);
    // Deep rock (big cave masses) goes darker than the floor, with a firmer hatch.
    float deep = 1.0 - smoothstep(-24.0, -10.0, wd);
    vec3 rock = mix(vec3(0.030, 0.034, 0.055), vec3(0.008, 0.009, 0.016), deep)
      + vec3(0.045, 0.055, 0.09) * smoothstep(-12.0, 0.0, wd)
      + mix(vec3(0.010, 0.013, 0.024), vec3(0.020, 0.024, 0.042), deep) * hatch;
    rock *= 0.85 + 0.3 * vnoise(w * 0.05);
    col = mix(col, rock, win);
    col += vec3(0.28, 0.40, 0.72) * exp(-abs(wd) / (px * 1.3 + 0.6)) * 0.85;
  }
  // glowing map border
  float edge = exp(-abs(db) / (px * 2.5 + 2.0));
  col += vec3(0.18, 0.26, 0.5) * edge * 0.6;
  vec2 uv = gl_FragCoord.xy / u_res - 0.5;
  col *= 1.0 - dot(uv, uv) * 0.7;
  o = vec4(col, 1.0);
}`;

export const UNIT_VS = `#version 300 es
layout(location=0) in vec2 a_q;
layout(location=1) in vec3 a_i;   // x, y, size
layout(location=2) in vec2 a_s;   // shape (+10 = fortified), heading angle
layout(location=3) in vec4 a_c;
uniform vec4 u_cam;
uniform vec2 u_rot;
uniform float u_px;
out vec2 v_p;
out vec2 v_s;
out vec4 v_c;
const float G = 2.6;
void main(){
  float s = max(a_i.z, u_px * 2.4);
  vec2 wp = a_i.xy + a_q * s * 0.5 * G;
  v_p = a_q * G;
  v_s = a_s;
  v_c = a_c;
  vec2 cd = wp - u_cam.xy;
  gl_Position = vec4(vec2(u_rot.x * cd.x - u_rot.y * cd.y, u_rot.y * cd.x + u_rot.x * cd.y) * u_cam.zw, 0., 1.);
}`;

// Shapes: 0 Dot = filled square, 1 Tank = hollow square, 2 Lancer = long
// diamond along its heading, 3 Swift = arrowhead along its heading.
export const UNIT_FS = `#version 300 es
precision mediump float;
in vec2 v_p;
in vec2 v_s;
in vec4 v_c;
out vec4 o;
void main(){
  float fort = step(9.5, v_s.x);
  float shape = v_s.x - fort * 10.0;
  vec2 p = v_p;
  float ca = cos(v_s.y), sa = sin(v_s.y);
  vec2 r = vec2(ca * p.x + sa * p.y, -sa * p.x + ca * p.y);
  float sq = max(abs(p.x), abs(p.y));
  float d = sq;
  float inner = 1.0;
  if (shape > 3.5) {
    // Colossus: a spiked, slowly turning star with a dark heart.
    float L = length(p);
    d = L * (1.0 + 0.2 * cos(atan(p.y, p.x) * 7.0 + v_s.y));
    inner = L < 0.45 ? 0.3 : 1.0;
  } else if (shape > 2.5) {
    d = max(abs(r.y) * 1.8 + r.x, -r.x / 0.8);
  } else if (shape > 1.5) {
    d = abs(r.x) / 1.45 + abs(r.y) / 0.38;
  } else if (shape > 0.5) {
    inner = sq < 0.42 ? 0.22 : 1.0;
  }
  float core = 1.0 - smoothstep(0.82, 1.08, d);
  float glow = exp(-(max(d, 1.0) - 1.0) * 1.7) * 0.13 * (1.0 - core);
  float shield = fort * (smoothstep(1.32, 1.42, sq) - smoothstep(1.55, 1.68, sq)) * 0.9;
  vec3 c = v_c.rgb;
  // premultiplied: core is opaque, glow and shield are additive (alpha 0)
  o = vec4((c * (core * 1.05 * inner + glow) + mix(c, vec3(1.0), 0.6) * shield) * v_c.a, core * v_c.a);
}`;

export const BEAM_VS = `#version 300 es
layout(location=0) in vec2 a_q;
layout(location=1) in vec4 a_ab;  // x1 y1 x2 y2
layout(location=2) in float a_w;  // width in pixels
layout(location=3) in vec4 a_c;
uniform vec4 u_cam;
uniform vec2 u_rot;
uniform float u_px;
out float v_v;
out vec4 v_c;
void main(){
  vec2 a = a_ab.xy, b = a_ab.zw;
  vec2 d = b - a;
  float L = max(length(d), 1e-4);
  vec2 nrm = vec2(-d.y, d.x) / L;
  float t = a_q.x * 0.5 + 0.5;
  float wdt = u_px * a_w;
  vec2 wp = mix(a, b, t) + nrm * a_q.y * wdt;
  v_v = a_q.y;
  v_c = a_c;
  vec2 cd = wp - u_cam.xy;
  gl_Position = vec4(vec2(u_rot.x * cd.x - u_rot.y * cd.y, u_rot.y * cd.x + u_rot.x * cd.y) * u_cam.zw, 0., 1.);
}`;

export const BEAM_FS = `#version 300 es
precision mediump float;
in float v_v;
in vec4 v_c;
out vec4 o;
void main(){
  float a = 1.0 - v_v * v_v;
  o = vec4(v_c.rgb * a * v_c.a, 0.0);
}`;

export const SHAPE_VS = `#version 300 es
layout(location=0) in vec2 a_q;
layout(location=1) in vec3 a_pr;   // x, y, r
layout(location=2) in vec4 a_par;  // shape, progress, rotation, extra
layout(location=3) in vec4 a_c1;
layout(location=4) in vec4 a_c2;
uniform vec4 u_cam;
uniform vec2 u_rot;
uniform float u_px;
out vec2 v_p;
out vec4 v_par;
out vec4 v_c1;
out vec4 v_c2;
out float v_px;
const float EXT = 1.35;
void main(){
  vec2 wp = a_pr.xy + a_q * a_pr.z * EXT;
  // Local coords as the screen shows them, so shapes and arcs stay upright on a turned view.
  vec2 q = a_q * EXT;
  v_p = vec2(u_rot.x * q.x - u_rot.y * q.y, u_rot.y * q.x + u_rot.x * q.y);
  v_par = a_par;
  v_c1 = a_c1;
  v_c2 = a_c2;
  v_px = u_px / a_pr.z;
  vec2 cd = wp - u_cam.xy;
  gl_Position = vec4(vec2(u_rot.x * cd.x - u_rot.y * cd.y, u_rot.y * cd.x + u_rot.x * cd.y) * u_cam.zw, 0., 1.);
}`;

export const SHAPE_FS = `#version 300 es
precision highp float;
in vec2 v_p;
in vec4 v_par;
in vec4 v_c1;
in vec4 v_c2;
in float v_px;
out vec4 o;
const float TAU = 6.2831853;
float ngon(vec2 p, float n, float rad){
  float a = atan(p.x, p.y);
  float b = TAU / n;
  return cos(floor(0.5 + a / b) * b - a) * length(p) - rad;
}
float ndot(vec2 a, vec2 b){ return a.x * b.x - a.y * b.y; }
float rhombus(vec2 p, vec2 b){
  p = abs(p);
  float h = clamp(ndot(b - 2.0 * p, b) / dot(b, b), -1.0, 1.0);
  float d = length(p - 0.5 * b * vec2(1.0 - h, 1.0 + h));
  return d * sign(p.x * b.y + p.y * b.x - b.x * b.y);
}
float arc(vec2 p, float prog){
  float f = fract(atan(p.x, -p.y) / TAU + 1.0); // 0 at screen-top, clockwise
  return step(f, prog);
}
void main(){
  int shape = int(v_par.x + 0.5);
  float L = length(v_p);
  float aa = v_px * 1.5;
  vec3 col = vec3(0.0);
  if (shape == 0) {
    // ring: extra = thickness (local units)
    float t = max(v_par.w, v_px * 1.5);
    float d = abs(L - 1.0) - t * 0.5;
    float ring = 1.0 - smoothstep(0.0, aa, d);
    float glow = exp(-max(d, 0.0) / (t * 2.0 + v_px * 3.0)) * 0.3;
    col = v_c1.rgb * (ring + glow) * v_c1.a * arc(v_p, v_par.y);
  } else if (shape == 7) {
    // soft filled disc: used for shockwave flash / selection halos
    float d = L - 1.0;
    float a = (1.0 - smoothstep(-0.4, 0.0, d)) * (0.4 + 0.6 * L);
    col = v_c1.rgb * a * v_c1.a;
  } else {
    float c = cos(v_par.z), s = sin(v_par.z);
    vec2 p = mat2(c, -s, s, c) * v_p;
    float n = shape == 1 ? 6.0 : shape == 2 ? 4.0 : shape == 3 ? 3.0 : 8.0;
    float rad = shape == 3 ? 0.42 : 0.6;
    // Spire (4) is a needle like the Spears it spawns.
    float d = shape == 4 ? rhombus(p, vec2(0.3, 0.82)) : ngon(p, n, rad);
    float outline = 1.0 - smoothstep(0.03, 0.03 + aa, abs(d));
    // Forge (2) wears a heavy double border like its Shields.
    if (shape == 2) outline = max(outline, 1.0 - smoothstep(0.025, 0.025 + aa, abs(d + 0.09)));
    float fill = d < 0.0 ? 0.13 + v_par.w * 0.45 : 0.0;
    float glow = exp(-max(d, 0.0) * 10.0) * 0.28 * step(0.0, d);
    float core = shape == 4 ? rhombus(p, vec2(0.11, 0.3)) : ngon(p, n, rad * 0.36);
    float coreF = (1.0 - smoothstep(0.0, aa, core)) * 0.55;
    if (shape == 5) {
      // bastion: cross through the core
      vec2 q = abs(p);
      coreF = max(coreF, (1.0 - smoothstep(0.035, 0.035 + aa, min(q.x, q.y))) * step(L, rad * 0.9) * 0.7);
    }
    col = v_c1.rgb * (outline + fill + glow + coreF) * v_c1.a;
    float rd = abs(L - 0.98) - 0.03;
    float ringBase = 1.0 - smoothstep(0.0, aa, rd);
    col += v_c1.rgb * ringBase * 0.1 * v_c1.a;
    col += v_c2.rgb * ringBase * arc(v_p, v_par.y) * v_c2.a;
  }
  o = vec4(col, 0.0);
}`;
