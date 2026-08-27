/* =====================================================================
   native.build — background fluid
   A low-resolution Navier–Stokes solver (Stam-style: advect, vorticity
   confinement, Jacobi pressure projection) running in fragment shaders.

   Two dyes are injected from opposite edges — amber for Java, teal for
   native — and advected into each other. Where they mix, the additive
   blend goes pale: the alloy. Code panels are uploaded each frame as an
   obstacle mask, so the flow parts around them and slips through the gap
   between the two halves.
   ===================================================================== */
(() => {
  'use strict';

  const canvas = document.getElementById('fluid');
  if (!canvas) return;

  const gl = canvas.getContext('webgl2', {
    alpha: true, depth: false, stencil: false,
    antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false
  });

  // No WebGL2, or no float render targets → leave the CSS background alone.
  if (!gl || !(gl.getExtension('EXT_color_buffer_float') ||
               gl.getExtension('EXT_color_buffer_half_float'))) {
    canvas.style.display = 'none';
    document.body.classList.add('no-fluid');
    return;
  }

  const HALF = gl.HALF_FLOAT;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const CONFIG = {
    SIM_RES:        176,   // solver grid, long side
    DYE_RES:        352,   // dye grid, long side
    CANVAS_DIV:     3,     // backing store = viewport / this
    PRESSURE_ITERS: 18,
    VELOCITY_DISS:  0.18,
    DYE_DISS:       0.48,
    PRESSURE_DISS:  0.8,
    CURL:           reduced ? 6 : 13,
    SPLAT_RADIUS:   0.0055
  };

  const JAVA   = [1.00, 0.54, 0.22];
  const NATIVE = [0.20, 0.88, 0.76];

  /* ---------------------------------------------------------------- glsl */

  const VERT = `#version 300 es
  precision highp float;
  in vec2 aPosition;
  out vec2 vUv, vL, vR, vT, vB;
  uniform vec2 texelSize;
  void main () {
    vUv = aPosition * 0.5 + 0.5;
    vL = vUv - vec2(texelSize.x, 0.0);
    vR = vUv + vec2(texelSize.x, 0.0);
    vT = vUv + vec2(0.0, texelSize.y);
    vB = vUv - vec2(0.0, texelSize.y);
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }`;

  const HEAD = `#version 300 es
  precision highp float;
  precision highp sampler2D;
  in vec2 vUv, vL, vR, vT, vB;
  out vec4 fragColor;
  uniform sampler2D uObstacle;
  float solid (vec2 uv) { return step(0.5, texture(uObstacle, uv).r); }`;

  const ADVECT = HEAD + `
  uniform sampler2D uVelocity, uSource;
  uniform vec2 texelSize;
  uniform float dt, dissipation;
  void main () {
    if (solid(vUv) > 0.5) { fragColor = vec4(0.0); return; }
    vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * texelSize;
    fragColor = texture(uSource, coord) / (1.0 + dissipation * dt);
  }`;

  const DIVERGENCE = HEAD + `
  uniform sampler2D uVelocity;
  void main () {
    float L = texture(uVelocity, vL).x * (1.0 - solid(vL));
    float R = texture(uVelocity, vR).x * (1.0 - solid(vR));
    float T = texture(uVelocity, vT).y * (1.0 - solid(vT));
    float B = texture(uVelocity, vB).y * (1.0 - solid(vB));
    vec2 C = texture(uVelocity, vUv).xy;
    if (vL.x < 0.0) L = -C.x;
    if (vR.x > 1.0) R = -C.x;
    if (vT.y > 1.0) T = -C.y;
    if (vB.y < 0.0) B = -C.y;
    fragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
  }`;

  const CURL = HEAD + `
  uniform sampler2D uVelocity;
  void main () {
    float L = texture(uVelocity, vL).y;
    float R = texture(uVelocity, vR).y;
    float T = texture(uVelocity, vT).x;
    float B = texture(uVelocity, vB).x;
    fragColor = vec4(0.5 * ((R - L) - (T - B)), 0.0, 0.0, 1.0);
  }`;

  const VORTICITY = HEAD + `
  uniform sampler2D uVelocity, uCurl;
  uniform float curl, dt;
  void main () {
    if (solid(vUv) > 0.5) { fragColor = vec4(0.0); return; }
    float L = texture(uCurl, vL).x;
    float R = texture(uCurl, vR).x;
    float T = texture(uCurl, vT).x;
    float B = texture(uCurl, vB).x;
    float C = texture(uCurl, vUv).x;
    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    force /= length(force) + 0.0001;
    force *= curl * C;
    force.y *= -1.0;
    vec2 v = texture(uVelocity, vUv).xy + force * dt;
    fragColor = vec4(clamp(v, -900.0, 900.0), 0.0, 1.0);
  }`;

  const PRESSURE = HEAD + `
  uniform sampler2D uPressure, uDivergence;
  void main () {
    float C = texture(uPressure, vUv).x;
    float L = solid(vL) > 0.5 ? C : texture(uPressure, vL).x;
    float R = solid(vR) > 0.5 ? C : texture(uPressure, vR).x;
    float T = solid(vT) > 0.5 ? C : texture(uPressure, vT).x;
    float B = solid(vB) > 0.5 ? C : texture(uPressure, vB).x;
    float div = texture(uDivergence, vUv).x;
    fragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
  }`;

  const GRADIENT = HEAD + `
  uniform sampler2D uPressure, uVelocity;
  void main () {
    if (solid(vUv) > 0.5) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    float C = texture(uPressure, vUv).x;
    float L = solid(vL) > 0.5 ? C : texture(uPressure, vL).x;
    float R = solid(vR) > 0.5 ? C : texture(uPressure, vR).x;
    float T = solid(vT) > 0.5 ? C : texture(uPressure, vT).x;
    float B = solid(vB) > 0.5 ? C : texture(uPressure, vB).x;
    vec2 v = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
    fragColor = vec4(v, 0.0, 1.0);
  }`;

  const CLEAR = HEAD + `
  uniform sampler2D uTexture;
  uniform float value;
  void main () { fragColor = value * texture(uTexture, vUv); }`;

  const SPLAT = HEAD + `
  uniform sampler2D uTarget;
  uniform float aspectRatio, radius;
  uniform vec3 color;
  uniform vec2 point;
  void main () {
    if (solid(vUv) > 0.5) { fragColor = texture(uTarget, vUv); return; }
    vec2 p = vUv - point;
    p.x *= aspectRatio;
    vec3 splat = exp(-dot(p, p) / radius) * color;
    fragColor = vec4(texture(uTarget, vUv).xyz + splat, 1.0);
  }`;

  // Display pass: a soft 9-tap blur, gentle knee, and edge falloff so the
  // field never competes with the text sitting on top of it.
  const DISPLAY = HEAD + `
  uniform sampler2D uTexture;
  uniform vec2 texelSize;
  void main () {
    vec3 c = texture(uTexture, vUv).rgb * 0.28;
    c += texture(uTexture, vUv + vec2( texelSize.x,  texelSize.y)).rgb * 0.09;
    c += texture(uTexture, vUv + vec2(-texelSize.x,  texelSize.y)).rgb * 0.09;
    c += texture(uTexture, vUv + vec2( texelSize.x, -texelSize.y)).rgb * 0.09;
    c += texture(uTexture, vUv + vec2(-texelSize.x, -texelSize.y)).rgb * 0.09;
    c += texture(uTexture, vUv + vec2( texelSize.x * 2.0, 0.0)).rgb * 0.09;
    c += texture(uTexture, vUv + vec2(-texelSize.x * 2.0, 0.0)).rgb * 0.09;
    c += texture(uTexture, vUv + vec2(0.0,  texelSize.y * 2.0)).rgb * 0.09;
    c += texture(uTexture, vUv + vec2(0.0, -texelSize.y * 2.0)).rgb * 0.09;
    c = c / (c + vec3(0.92));                       // soft shoulder
    c = pow(c, vec3(1.18));                         // deepen the darks
    vec2 d = abs(vUv - 0.5) * 2.0;
    float edge = 1.0 - smoothstep(0.55, 1.25, max(d.x, d.y));
    fragColor = vec4(c * edge, 1.0);
  }`;

  /* -------------------------------------------------------------- plumbing */

  function compile (type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('[fluid] shader:', gl.getShaderInfoLog(s));
    }
    return s;
  }

  const vertShader = compile(gl.VERTEX_SHADER, VERT);

  function program (fragSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, vertShader);
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn('[fluid] link:', gl.getProgramInfoLog(p));
    }
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name;
      uniforms[name] = gl.getUniformLocation(p, name);
    }
    return { program: p, uniforms, bind () { gl.useProgram(p); } };
  }

  const progs = {
    advect:     program(ADVECT),
    divergence: program(DIVERGENCE),
    curl:       program(CURL),
    vorticity:  program(VORTICITY),
    pressure:   program(PRESSURE),
    gradient:   program(GRADIENT),
    clear:      program(CLEAR),
    splat:      program(SPLAT),
    display:    program(DISPLAY)
  };

  const quad = gl.createVertexArray();
  gl.bindVertexArray(quad);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  function blit (target) {
    if (target) {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    } else {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function createFBO (w, h, internal, format, type, filter) {
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    return {
      texture, fbo, width: w, height: h,
      texelSizeX: 1 / w, texelSizeY: 1 / h,
      attach (id) {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      }
    };
  }

  function createDouble (w, h, internal, format, type, filter) {
    let a = createFBO(w, h, internal, format, type, filter);
    let b = createFBO(w, h, internal, format, type, filter);
    return {
      width: w, height: h, texelSizeX: 1 / w, texelSizeY: 1 / h,
      get read () { return a; }, set read (v) { a = v; },
      get write () { return b; }, set write (v) { b = v; },
      swap () { const t = a; a = b; b = t; }
    };
  }

  function resolution (target) {
    const ar = Math.max(canvas.clientWidth, 1) / Math.max(canvas.clientHeight, 1);
    return ar > 1
      ? { w: target, h: Math.max(1, Math.round(target / ar)) }
      : { w: Math.max(1, Math.round(target * ar)), h: target };
  }

  let dye, velocity, divergence, curlFBO, pressure, obstacleTex;

  function initFramebuffers () {
    const sim = resolution(CONFIG.SIM_RES);
    const dyeRes = resolution(CONFIG.DYE_RES);
    dye        = createDouble(dyeRes.w, dyeRes.h, gl.RGBA16F, gl.RGBA, HALF, gl.LINEAR);
    velocity   = createDouble(sim.w, sim.h, gl.RG16F, gl.RG, HALF, gl.LINEAR);
    divergence = createFBO(sim.w, sim.h, gl.R16F, gl.RED, HALF, gl.NEAREST);
    curlFBO    = createFBO(sim.w, sim.h, gl.R16F, gl.RED, HALF, gl.NEAREST);
    pressure   = createDouble(sim.w, sim.h, gl.R16F, gl.RED, HALF, gl.NEAREST);
  }

  /* ------------------------------------------------------- obstacle mask */

  const maskCanvas = document.createElement('canvas');
  const mctx = maskCanvas.getContext('2d', { willReadFrequently: false });
  let obstacleEls = [];

  function initObstacleTexture () {
    obstacleTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, obstacleTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  function roundRect (ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
  }

  function updateObstacles () {
    const W = maskCanvas.width, H = maskCanvas.height;
    const vw = window.innerWidth, vh = window.innerHeight;
    mctx.clearRect(0, 0, W, H);
    mctx.fillStyle = '#fff';
    for (const el of obstacleEls) {
      const r = el.getBoundingClientRect();
      if (r.bottom < -60 || r.top > vh + 60 || r.width === 0) continue;
      roundRect(mctx,
        (r.left / vw) * W, (r.top / vh) * H,
        (r.width / vw) * W, (r.height / vh) * H, 2.5);
      mctx.fill();
    }
    gl.bindTexture(gl.TEXTURE_2D, obstacleTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);   // DOM y-down → uv y-up
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  /* -------------------------------------------------------------- sizing */

  function resize () {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.max(2, Math.round(vw / CONFIG.CANVAS_DIV));
    const h = Math.max(2, Math.round(vh / CONFIG.CANVAS_DIV));
    if (canvas.width === w && canvas.height === h) return false;
    canvas.width = w; canvas.height = h;
    const sim = resolution(CONFIG.SIM_RES);
    maskCanvas.width = sim.w; maskCanvas.height = sim.h;
    return true;
  }

  /* --------------------------------------------------------------- splat */

  function splat (x, y, dx, dy, color) {
    progs.splat.bind();
    gl.uniform1i(progs.splat.uniforms.uObstacle, obstacleTex ? bindObstacle(3) : 3);
    gl.uniform1i(progs.splat.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(progs.splat.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(progs.splat.uniforms.point, x, y);
    gl.uniform3f(progs.splat.uniforms.color, dx, dy, 0.0);
    gl.uniform1f(progs.splat.uniforms.radius, CONFIG.SPLAT_RADIUS);
    blit(velocity.write);
    velocity.swap();

    gl.uniform1i(progs.splat.uniforms.uTarget, dye.read.attach(0));
    gl.uniform3f(progs.splat.uniforms.color, color[0], color[1], color[2]);
    blit(dye.write);
    dye.swap();
  }

  function bindObstacle (unit) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, obstacleTex);
    return unit;
  }

  /* ----------------------------------------------------------- agitation */

  let scrollVel = 0;
  let lastScrollY = window.scrollY;
  const pointer = { x: 0.5, y: 0.5, dx: 0, dy: 0, active: false };

  if (!reduced) {
    window.addEventListener('scroll', () => {
      const y = window.scrollY;
      scrollVel += (y - lastScrollY);
      lastScrollY = y;
    }, { passive: true });

    window.addEventListener('pointermove', (e) => {
      const nx = e.clientX / window.innerWidth;
      const ny = 1 - e.clientY / window.innerHeight;
      pointer.dx = (nx - pointer.x) * 900;
      pointer.dy = (ny - pointer.y) * 900;
      pointer.x = nx; pointer.y = ny;
      pointer.active = true;
    }, { passive: true });
  }

  // Steady supply from both edges: Java pushes in from the left, native from
  // the right. They meet in the middle — which is where the page's content is.
  function emit (t) {
    const drift = reduced ? 0.35 : 1;
    for (let i = 0; i < 3; i++) {
      const phase = t * 0.00022 + i * 2.1;
      const yJ = 0.22 + 0.28 * i + 0.1 * Math.sin(phase);
      const yN = 0.18 + 0.3  * i + 0.1 * Math.cos(phase * 1.3);
      const push = (42 + 18 * Math.sin(phase * 0.7)) * drift;

      splat(0.015, yJ,  push, 5 * Math.sin(phase * 1.7),
        [JAVA[0] * 0.17, JAVA[1] * 0.17, JAVA[2] * 0.17]);
      splat(0.985, yN, -push, 5 * Math.cos(phase * 1.4),
        [NATIVE[0] * 0.105, NATIVE[1] * 0.105, NATIVE[2] * 0.105]);
    }
  }

  function agitate () {
    if (Math.abs(scrollVel) > 0.4) {
      const v = Math.max(-70, Math.min(70, -scrollVel * 1.6));
      for (let i = 0; i < 4; i++) {
        const y = 0.12 + 0.25 * i;
        const s = 0.10 + 0.02 * i;
        splat(s,       y, 34, v, [JAVA[0] * 0.12,   JAVA[1] * 0.12,   JAVA[2] * 0.12]);
        splat(1 - s,   y, -34, v, [NATIVE[0] * 0.08, NATIVE[1] * 0.08, NATIVE[2] * 0.08]);
      }
      scrollVel *= 0.72;
      if (Math.abs(scrollVel) < 0.4) scrollVel = 0;
    }

    if (pointer.active && (Math.abs(pointer.dx) > 0.5 || Math.abs(pointer.dy) > 0.5)) {
      const warm = pointer.x < 0.5;
      const c = warm ? JAVA : NATIVE;
      splat(pointer.x, pointer.y, pointer.dx, pointer.dy,
        [c[0] * 0.06, c[1] * 0.06, c[2] * 0.06]);
      pointer.dx *= 0.82; pointer.dy *= 0.82;
    }
  }

  /* ----------------------------------------------------------------- step */

  function step (dt) {
    gl.disable(gl.BLEND);
    const O = bindObstacle(5);

    progs.curl.bind();
    gl.uniform2f(progs.curl.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(progs.curl.uniforms.uObstacle, O);
    gl.uniform1i(progs.curl.uniforms.uVelocity, velocity.read.attach(0));
    blit(curlFBO);

    progs.vorticity.bind();
    gl.uniform2f(progs.vorticity.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(progs.vorticity.uniforms.uObstacle, O);
    gl.uniform1i(progs.vorticity.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(progs.vorticity.uniforms.uCurl, curlFBO.attach(1));
    gl.uniform1f(progs.vorticity.uniforms.curl, CONFIG.CURL);
    gl.uniform1f(progs.vorticity.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();

    progs.divergence.bind();
    gl.uniform2f(progs.divergence.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(progs.divergence.uniforms.uObstacle, O);
    gl.uniform1i(progs.divergence.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    progs.clear.bind();
    gl.uniform2f(progs.clear.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(progs.clear.uniforms.uObstacle, O);
    gl.uniform1i(progs.clear.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(progs.clear.uniforms.value, CONFIG.PRESSURE_DISS);
    blit(pressure.write);
    pressure.swap();

    progs.pressure.bind();
    gl.uniform2f(progs.pressure.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(progs.pressure.uniforms.uObstacle, O);
    gl.uniform1i(progs.pressure.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < CONFIG.PRESSURE_ITERS; i++) {
      gl.uniform1i(progs.pressure.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write);
      pressure.swap();
    }

    progs.gradient.bind();
    gl.uniform2f(progs.gradient.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(progs.gradient.uniforms.uObstacle, O);
    gl.uniform1i(progs.gradient.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(progs.gradient.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();

    progs.advect.bind();
    gl.uniform2f(progs.advect.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(progs.advect.uniforms.uObstacle, O);
    gl.uniform1f(progs.advect.uniforms.dt, dt);
    gl.uniform1i(progs.advect.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(progs.advect.uniforms.uSource, velocity.read.attach(0));
    gl.uniform1f(progs.advect.uniforms.dissipation, CONFIG.VELOCITY_DISS);
    blit(velocity.write);
    velocity.swap();

    gl.uniform1i(progs.advect.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(progs.advect.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(progs.advect.uniforms.dissipation, CONFIG.DYE_DISS);
    blit(dye.write);
    dye.swap();
  }

  function render () {
    progs.display.bind();
    gl.uniform2f(progs.display.uniforms.texelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(progs.display.uniforms.uObstacle, bindObstacle(5));
    gl.uniform1i(progs.display.uniforms.uTexture, dye.read.attach(0));
    blit(null);
  }

  /* ------------------------------------------------------------- lifecycle */

  resize();
  initFramebuffers();
  initObstacleTexture();
  obstacleEls = Array.from(document.querySelectorAll('[data-obstacle]'));
  updateObstacles();

  let last = performance.now();
  let maskAccum = 0;
  let running = true;

  window.addEventListener('resize', () => {
    if (resize()) { initFramebuffers(); updateObstacles(); }
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    running = !document.hidden;
    if (running) { last = performance.now(); requestAnimationFrame(frame); }
  });

  function frame (now) {
    if (!running) return;
    const dt = Math.min((now - last) / 1000, 0.0333);
    last = now;

    maskAccum += dt;
    if (maskAccum > 0.08) { updateObstacles(); maskAccum = 0; }

    emit(now);
    agitate();
    step(dt);
    render();

    requestAnimationFrame(frame);
  }

  // Prime the field so the hero is already alive on first paint.
  for (let i = 0; i < 26; i++) { emit(i * 120); if (i % 2 === 0) step(0.016); }
  requestAnimationFrame(frame);
})();
