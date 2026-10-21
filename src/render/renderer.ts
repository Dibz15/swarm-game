import type { Camera } from './camera';
import { BEAM_FS, BEAM_VS, BG_FS, BG_VS, SHAPE_FS, SHAPE_VS, UNIT_FS, UNIT_VS } from './shaders';

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link failed: ' + gl.getProgramInfoLog(p));
  return p;
}

/**
 * Growable interleaved instance buffer. Layout per instance: `floats` f32
 * values followed by `colors` RGBA8 colors.
 */
export class InstanceBuffer {
  readonly stride: number;
  cap: number;
  data: ArrayBuffer;
  f32: Float32Array;
  u8: Uint8Array;
  count = 0;

  constructor(readonly floats: number, readonly colors: number, cap: number) {
    this.stride = floats * 4 + colors * 4;
    this.cap = cap;
    this.data = new ArrayBuffer(this.stride * cap);
    this.f32 = new Float32Array(this.data);
    this.u8 = new Uint8Array(this.data);
  }

  /** Returns the f32 index of a new instance (grows as needed). */
  alloc(): number {
    if (this.count >= this.cap) {
      const old = this.u8;
      this.cap *= 2;
      this.data = new ArrayBuffer(this.stride * this.cap);
      this.f32 = new Float32Array(this.data);
      this.u8 = new Uint8Array(this.data);
      this.u8.set(old);
    }
    return (this.count++ * this.stride) >> 2;
  }

  color(fi: number, slot: number, r: number, g: number, b: number, a: number): void {
    const o = fi * 4 + this.floats * 4 + slot * 4;
    this.u8[o] = r;
    this.u8[o + 1] = g;
    this.u8[o + 2] = b;
    this.u8[o + 3] = a;
  }
}

interface Pass {
  prog: WebGLProgram;
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  buf: InstanceBuffer;
  uCam: WebGLUniformLocation | null;
  uPx: WebGLUniformLocation | null;
  gpuCap: number;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  width = 1;
  height = 1;
  dpr = 1;

  readonly units: InstanceBuffer;
  readonly beams: InstanceBuffer;
  readonly shapes: InstanceBuffer;
  /** shapes drawn above units (fx rings, selection) */
  readonly overlay: InstanceBuffer;

  private quad: WebGLBuffer;
  private bg: { prog: WebGLProgram; vao: WebGLVertexArrayObject; uRes: WebGLUniformLocation | null; uView: WebGLUniformLocation | null; uMap: WebGLUniformLocation | null; uTime: WebGLUniformLocation | null };
  private unitPass: Pass;
  private beamPass: Pass;
  private shapePass: Pass;
  private overlayPass: Pass;
  private camU = new Float32Array(4);

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;

    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const bgProg = program(gl, BG_VS, BG_FS);
    const bgVao = gl.createVertexArray()!;
    gl.bindVertexArray(bgVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.bg = {
      prog: bgProg,
      vao: bgVao,
      uRes: gl.getUniformLocation(bgProg, 'u_res'),
      uView: gl.getUniformLocation(bgProg, 'u_view'),
      uMap: gl.getUniformLocation(bgProg, 'u_map'),
      uTime: gl.getUniformLocation(bgProg, 'u_time'),
    };

    this.units = new InstanceBuffer(5, 1, 16384);
    this.beams = new InstanceBuffer(5, 1, 8192);
    this.shapes = new InstanceBuffer(7, 2, 256);
    this.overlay = new InstanceBuffer(7, 2, 256);
    this.unitPass = this.makePass(UNIT_VS, UNIT_FS, this.units, [3, 2]);
    this.beamPass = this.makePass(BEAM_VS, BEAM_FS, this.beams, [4, 1]);
    this.shapePass = this.makePass(SHAPE_VS, SHAPE_FS, this.shapes, [3, 4]);
    this.overlayPass = this.makePass(SHAPE_VS, SHAPE_FS, this.overlay, [3, 4]);
    gl.bindVertexArray(null);
  }

  /** floatGroups: sizes of the float attributes (locations 1..), then one location per color. */
  private makePass(vs: string, fs: string, buf: InstanceBuffer, floatGroups: number[]): Pass {
    const gl = this.gl;
    const prog = program(gl, vs, fs);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    let loc = 1, off = 0;
    for (const n of floatGroups) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, buf.stride, off);
      gl.vertexAttribDivisor(loc, 1);
      loc++;
      off += n * 4;
    }
    for (let c = 0; c < buf.colors; c++) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.UNSIGNED_BYTE, true, buf.stride, off);
      gl.vertexAttribDivisor(loc, 1);
      loc++;
      off += 4;
    }
    return { prog, vao, vbo, buf, uCam: gl.getUniformLocation(prog, 'u_cam'), uPx: gl.getUniformLocation(prog, 'u_px'), gpuCap: 0 };
  }

  resize(): boolean {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (w === this.width && h === this.height && dpr === this.dpr) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    return true;
  }

  beginFrame(): void {
    this.units.count = 0;
    this.beams.count = 0;
    this.shapes.count = 0;
    this.overlay.count = 0;
  }

  draw(cam: Camera, time: number): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    const camU = cam.uniform(this.camU);
    const px = 1 / cam.zoom;

    gl.disable(gl.BLEND);
    gl.useProgram(this.bg.prog);
    gl.bindVertexArray(this.bg.vao);
    gl.uniform2f(this.bg.uRes, this.width, this.height);
    gl.uniform3f(this.bg.uView, camU[0], camU[1], px);
    gl.uniform2f(this.bg.uMap, cam.mapW, cam.mapH);
    gl.uniform1f(this.bg.uTime, time);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.drawPass(this.shapePass, camU, px);
    this.drawPass(this.beamPass, camU, px);
    this.drawPass(this.unitPass, camU, px);
    this.drawPass(this.overlayPass, camU, px);
    gl.bindVertexArray(null);
  }

  private drawPass(p: Pass, camU: Float32Array, px: number): void {
    const gl = this.gl;
    const b = p.buf;
    if (b.count === 0) return;
    gl.useProgram(p.prog);
    gl.bindVertexArray(p.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, p.vbo);
    const bytes = b.count * b.stride;
    if (b.cap > p.gpuCap) {
      gl.bufferData(gl.ARRAY_BUFFER, b.cap * b.stride, gl.DYNAMIC_DRAW);
      p.gpuCap = b.cap;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.u8, 0, bytes);
    gl.uniform4fv(p.uCam, camU);
    gl.uniform1f(p.uPx, px);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.count);
  }

  // ---- instance helpers -------------------------------------------------

  /** shape: 0 square, 1 hollow square, 2 long diamond, 3 arrowhead; +10 draws a shield */
  unit(x: number, y: number, size: number, r: number, g: number, b: number, a = 255, shape = 0, angle = 0): void {
    const u = this.units;
    const i = u.alloc();
    u.f32[i] = x;
    u.f32[i + 1] = y;
    u.f32[i + 2] = size;
    u.f32[i + 3] = shape;
    u.f32[i + 4] = angle;
    u.color(i, 0, r, g, b, a);
  }

  beam(x1: number, y1: number, x2: number, y2: number, r: number, g: number, b: number, a: number, width = 1.8): void {
    const u = this.beams;
    const i = u.alloc();
    u.f32[i] = x1;
    u.f32[i + 1] = y1;
    u.f32[i + 2] = x2;
    u.f32[i + 3] = y2;
    u.f32[i + 4] = width;
    u.color(i, 0, r, g, b, a);
  }

  /** shape: 0 ring, 1 hex, 2 square, 3 triangle, 4 diamond, 5 octagon, 7 disc */
  shape(
    over: boolean,
    x: number, y: number, rad: number,
    shape: number, progress: number, rot: number, extra: number,
    c1: readonly number[], a1: number,
    c2: readonly number[] = c1, a2 = 0,
  ): void {
    const u = over ? this.overlay : this.shapes;
    const i = u.alloc();
    const f = u.f32;
    f[i] = x;
    f[i + 1] = y;
    f[i + 2] = rad;
    f[i + 3] = shape;
    f[i + 4] = progress;
    f[i + 5] = rot;
    f[i + 6] = extra;
    u.color(i, 0, c1[0], c1[1], c1[2], a1);
    u.color(i, 1, c2[0], c2[1], c2[2], a2);
  }
}
