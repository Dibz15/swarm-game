// GLSL ES 3.00 shaders. All passes share u_cam = (cx, cy, sx, sy):
// clip = (world - c) * s. u_px = world units per device pixel.

export const BG_VS = `#version 300 es
layout(location=0) in vec2 a_q;
void main(){ gl_Position = vec4(a_q, 0., 1.); }`;

export const BG_FS = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform vec3 u_view; // cx, cy, world units per pixel
uniform vec2 u_map;
uniform float u_time;
out vec4 o;
float gridLine(vec2 w, float step, float px){
  vec2 g = abs(fract(w / step - 0.5) - 0.5) * step / px;
  return 1.0 - min(min(g.x, g.y), 1.0);
}
void main(){
  vec2 fc = gl_FragCoord.xy - u_res * 0.5;
  vec2 w = u_view.xy + vec2(fc.x, -fc.y) * u_view.z;
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
  gl_Position = vec4((wp - u_cam.xy) * u_cam.zw, 0., 1.);
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
  if (shape > 2.5) {
    d = max(abs(r.y) * 1.8 + r.x, -r.x / 0.8);
  } else if (shape > 1.5) {
    d = abs(r.x) / 1.3 + abs(r.y) / 0.5;
  } else if (shape > 0.5) {
    inner = sq < 0.5 ? 0.22 : 1.0;
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
  gl_Position = vec4((wp - u_cam.xy) * u_cam.zw, 0., 1.);
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
uniform float u_px;
out vec2 v_p;
out vec4 v_par;
out vec4 v_c1;
out vec4 v_c2;
out float v_px;
const float EXT = 1.35;
void main(){
  vec2 wp = a_pr.xy + a_q * a_pr.z * EXT;
  v_p = a_q * EXT;
  v_par = a_par;
  v_c1 = a_c1;
  v_c2 = a_c2;
  v_px = u_px / a_pr.z;
  gl_Position = vec4((wp - u_cam.xy) * u_cam.zw, 0., 1.);
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
    float n = shape == 1 ? 6.0 : shape == 2 ? 4.0 : shape == 3 ? 3.0 : shape == 4 ? 4.0 : 8.0;
    if (shape == 4) p = mat2(0.7071, -0.7071, 0.7071, 0.7071) * p * vec2(1.0, 1.35);
    float rad = shape == 3 ? 0.42 : shape == 4 ? 0.5 : 0.6;
    float d = ngon(p, n, rad);
    float outline = 1.0 - smoothstep(0.03, 0.03 + aa, abs(d));
    float fill = d < 0.0 ? 0.13 + v_par.w * 0.45 : 0.0;
    float glow = exp(-max(d, 0.0) * 10.0) * 0.28 * step(0.0, d);
    float core = ngon(p, n, rad * 0.36);
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
