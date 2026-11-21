/**
 * trail.js — след курсора, проявляющий рельеф секции.
 *
 * Внутри тот же механизм, что в референсе:
 *   1) буфер следа на WebGL2: затухание по времени + штампы мягкой кисти
 *      (blending = MAX, поэтому мазок не набирает плотность);
 *   2) композит считает объём рельефа из градиента яркости текстуры,
 *      тонит его цветом секции и смешивает с фоном — не «картинка поверх»,
 *      а выдавленный рельеф.
 *
 * Контракт с разметкой (совместим с прежним):
 *   data-trail            включает эффект на секции
 *   data-trail-src        текстура рельефа
 *   data-trail-mount      слой внутри секции (по умолчанию сама секция)
 *   data-trail-opacity    плотность проявления, 0..1
 *   data-trail-filter     CSS-фильтр на canvas
 *   data-trail-blend      mix-blend-mode canvas (screen, soft-light…)
 *   data-trail-position   object-position кадра, "50% 48%"
 *   data-trail-width      множитель радиуса кисти, 0.6..1.8
 *   data-trail-height     высота пятна: 1 — круг, >1 — вытянуто (0.5..2.5)
 *   data-trail-strength   насколько рельеф перекрывает фон, 0..1 (0.55)
 *   data-trail-tint       "r,g,b" — во что тонируется рельеф
 *   data-trail-mono       "true" — только яркость, цвет из фона
 *   data-trail-zoom       масштаб текстуры (1 = cover)
 *   data-trail-offset     "x,y" — сдвиг текстуры в долях кадра
 */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var finePointer = window.matchMedia('(pointer: fine)');
  if (reduceMotion.matches || !finePointer.matches) return;
  if (!window.WebGL2RenderingContext) return;

  var HOLD = 2200;
  var LIFETIME = 0.85;
  var FLOOR = 0.004;
  var SMOOTHER = 0.14;
  /* Радиус кисти в CSS-пикселях. Один и тот же во всех секциях: размер не
     должен зависеть ни от высоты секции, ни от высоты окна.
     data-trail-width остаётся множителем для намеренных акцентов.
     Для hero кисть крупнее: 92 * 1.5 * 1.3 ≈ 179. */
  var BRUSH = 179;
  var QUALITY = 0.5;
  var DPR_MAX = 2;

  var VERT = '#version 300 es\n' +
    'layout(location = 0) in vec2 aPos;\n' +
    'out vec2 vUv;\n' +
    'void main() { vUv = aPos * .5 + .5; gl_Position = vec4(aPos, 0., 1.); }';

  var VERT_BRUSH = '#version 300 es\n' +
    'layout(location = 0) in vec2 aPos;\n' +
    'uniform vec2 uCenter;\n' +
    'uniform vec2 uRes;\n' +
    'uniform vec2 uRadius;\n' +
    'out vec2 vLocal;\n' +
    'void main() {\n' +
    '  vLocal = aPos;\n' +
    '  vec2 px = uCenter + aPos * uRadius;\n' +
    '  gl_Position = vec4(px / uRes * 2. - 1., 0., 1.);\n' +
    '}';

  var FRAG_FADE = '#version 300 es\n' +
    'precision highp float;\n' +
    'uniform sampler2D uPrev;\n' +
    'uniform float uDecay;\n' +
    'uniform float uFloor;\n' +
    'in vec2 vUv;\n' +
    'out vec4 o;\n' +
    'void main() {\n' +
    '  vec3 v = texture(uPrev, vUv).rgb * uDecay - uFloor;\n' +
    '  o = vec4(max(v, 0.), 1.);\n' +
    '}';

  var FRAG_BRUSH = '#version 300 es\n' +
    'precision highp float;\n' +
    'uniform float uEdge;\n' +
    'in vec2 vLocal;\n' +
    'out vec4 o;\n' +
    'void main() {\n' +
    '  float d = length(vLocal);\n' +
    '  float a = 1. - smoothstep(mix(.30, .86, uEdge), .99, d);\n' +
    '  o = vec4(vec3(a), 1.);\n' +
    '}';

  /* cover(): инверсия object-fit: cover + object-position.
     k — во сколько раз кадр больше бокса по оси, pos — доля обрезки,
     ушедшая влево/вверх. Комментарий держим в JS, а не в GLSL: набор
     символов шейдера лучше оставлять ASCII. */
  var FRAG_COMPOSITE = '#version 300 es\n' +
    'precision highp float;\n' +
    'uniform sampler2D uTrail;\n' +
    'uniform sampler2D uTex;\n' +
    'uniform vec2 uRes;\n' +
    'uniform vec2 uPos;\n' +
    'uniform vec2 uOffset;\n' +
    'uniform vec3 uBg;\n' +
    'uniform vec3 uTint;\n' +
    'uniform float uTexAR;\n' +
    'uniform float uZoom;\n' +
    'uniform float uStrength;\n' +
    'uniform float uMono;\n' +
    'uniform float uPivot;\n' +
    'uniform float uEmboss;\n' +
    'uniform float uSolid;\n' +
    'uniform vec3 uSolidColor;\n' +
    'in vec2 vUv;\n' +
    'out vec4 o;\n' +
    'vec2 cover(vec2 uv, float texAR, float scrAR, vec2 pos) {\n' +
    '  vec2 k = scrAR > texAR ? vec2(1., scrAR / texAR) : vec2(texAR / scrAR, 1.);\n' +
    '  return (uv - (1. - k) * pos) / k;\n' +
    '}\n' +
    'float lum(vec3 c) { return dot(c, vec3(.299, .587, .114)); }\n' +
    'void main() {\n' +
    '  vec2 uv = vec2(vUv.x, 1. - vUv.y);\n' +
    '  float mask = smoothstep(.05, .36, texture(uTrail, uv).r);\n' +
    '  if (mask < .002) { o = vec4(0.); return; }\n' +
  '  if (uSolid > .5) { o = vec4(uSolidColor * mask, mask); return; }\n' +
    '  vec2 ruv = cover(uv, uTexAR, uRes.x / uRes.y, uPos);\n' +
    '  ruv = (ruv - .5) * uZoom + .5 + uOffset;\n' +
    '  vec3 tex = texture(uTex, ruv).rgb;\n' +
    '  float c = lum(tex);\n' +
    '  float dx = clamp(lum(texture(uTex, ruv + vec2(2. / uRes.x, 0.)).rgb) - c, -.06, .06);\n' +
    '  float dy = clamp(lum(texture(uTex, ruv + vec2(0., 2. / uRes.y)).rgb) - c, -.06, .06);\n' +
    '  vec3 n = normalize(vec3(-dx * 15., -dy * 15., 1.));\n' +
    '  float dif = clamp(dot(n, normalize(vec3(-.35, .55, .9))), 0., 1.);\n' +
    '  vec3 colored = tex * uTint * mix(1., .30 + .48 * dif, uEmboss);\n' +
    '  vec3 mono = uBg * clamp(1. + (c - uPivot) * 3.2, .25, 2.2) * uTint * (.85 + .3 * dif);\n' +
    '  vec3 rgb = mix(colored, mono, uMono);\n' +
    '  rgb = mix(uBg, rgb, uStrength);\n' +
    '  float rim = smoothstep(0., .22, mask) - smoothstep(.22, .8, mask);\n' +
    '  rgb += rim * .04;\n' +
    '  o = vec4(rgb * mask, mask);\n' +
    '}';

  function parsePair(value, fallback) {
    var out = fallback.slice();
    if (!value) return out;
    var parts = String(value).trim().split(/[\s,]+/);
    for (var i = 0; i < 2 && i < parts.length; i++) {
      var k = parts[i].indexOf('%') > -1 ? parseFloat(parts[i]) / 100 : parseFloat(parts[i]);
      if (isFinite(k)) out[i] = k;
    }
    return out;
  }

  function parseColor(value) {
    if (!value) return null;
    var p = String(value).trim().split(/[\s,]+/).map(parseFloat);
    if (p.length < 3 || p.some(function (x) { return !isFinite(x); })) return null;
    var scale = Math.max(p[0], p[1], p[2]) > 1 ? 255 : 1;
    return [p[0] / scale, p[1] / scale, p[2] / scale];
  }

  /* фон секции: первый непрозрачный background-color вверх по дереву */
  function readBg(el) {
    var node = el;
    while (node && node.nodeType === 1) {
      var v = getComputedStyle(node).backgroundColor;
      var m = v && v.match(/rgba?\(([^)]+)\)/);
      if (m) {
        var p = m[1].split(',').map(function (x) { return parseFloat(x); });
        var a = p.length > 3 ? p[3] : 1;
        if (a > 0.05) return [p[0] / 255, p[1] / 255, p[2] / 255];
      }
      node = node.parentElement;
    }
    return [0.05, 0.09, 0.07];
  }

  function create(host) {
    var src = host.getAttribute('data-trail-src');

    var mountSel = host.getAttribute('data-trail-mount');
    var mount = mountSel ? host.querySelector(mountSel) : host;
    if (!mount) return null;

    var num = function (name, fallback) {
      var v = parseFloat(host.getAttribute(name));
      return isFinite(v) ? v : fallback;
    };

    var alpha = Math.max(0, Math.min(1, num('data-trail-opacity', 1)));
    var widthScale = Math.max(0.6, Math.min(1.8, num('data-trail-width', 1)));
    /* высота пятна: 1 — круг, >1 — вытянуто по вертикали */
    var heightScale = Math.max(0.5, Math.min(2.5, num('data-trail-height', 1)));
    var strength = Math.max(0, Math.min(1, num('data-trail-strength', 0.85)));
    var zoom = Math.max(0.5, Math.min(6, num('data-trail-zoom', 1)));
    var emboss = Math.max(0, Math.min(1, num('data-trail-emboss', 1)));
    var edge = Math.max(0, Math.min(1, num('data-trail-edge', 0.32)));
    var mono = host.getAttribute('data-trail-mono') === 'true' ? 1 : 0;
    var tint = parseColor(host.getAttribute('data-trail-tint')) || [0.70, 0.80, 0.62];
    var offset = parsePair(host.getAttribute('data-trail-offset'), [0, 0]);
    var pos = parsePair(host.getAttribute('data-trail-position'), [0.5, 0.5]);
    var bgColor = readBg(host);
    var solid = !src || host.getAttribute('data-trail-solid') === 'true';
    var dark = Math.max(0, Math.min(1, num('data-trail-dark', 0.68)));
    var solidColor = parseColor(host.getAttribute('data-trail-color')) ||
      [bgColor[0] * dark, bgColor[1] * dark, bgColor[2] * dark];
    var tintAttr = host.getAttribute('data-trail-filter');
    var blend = host.getAttribute('data-trail-blend');

    var layer = document.createElement('div');
    layer.className = 'trail';
    layer.setAttribute('aria-hidden', 'true');

    var canvas = document.createElement('canvas');
    canvas.className = 'trail__canvas';
    if (tintAttr) canvas.style.filter = tintAttr;
    if (blend) canvas.style.mixBlendMode = blend;
    if (host.getAttribute('data-trail-above') === 'true') layer.classList.add('trail--above');
    canvas.style.opacity = String(alpha);
    layer.appendChild(canvas);
    mount.appendChild(layer);

    var gl = null;
    var ctx = null;
    var built = false;
    var running = false;
    var raf = 0;

    var tw = 2, th = 2, W = 1, H = 1, dpr = 1, cssW = 1, cssH = 1, radius = 1;
    var sized = false;
    var A = null, B = null, tex = null, texAR = 1, pivot = 0.5;

    var pos_ = { x: 0, y: 0 };
    var aim = { x: 0, y: 0 };
    var prev = { x: 0, y: 0 };
    var hasPointer = false;
    var fresh = true;
    var lastMoveAt = 0;
    var lastStampAt = 0;
    var lastFrameAt = 0;
    var visible = true;

    function build() {
      gl = canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance'
      });
      if (!gl) { layer.remove(); return false; }

      function shader(type, source) {
        var s = gl.createShader(type);
        gl.shaderSource(s, source);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      }

      function program(vs, fs) {
        var p = gl.createProgram();
        gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
        gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        var u = {};
        var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
        for (var i = 0; i < n; i++) {
          var info = gl.getActiveUniform(p, i);
          u[info.name] = gl.getUniformLocation(p, info.name);
        }
        return { p: p, u: u };
      }

      var quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      ctx = {
        fade: program(VERT, FRAG_FADE),
        brush: program(VERT_BRUSH, FRAG_BRUSH),
        composite: program(VERT, FRAG_COMPOSITE)
      };

      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([120, 120, 120, 255]));

      built = true;
      return true;
    }

    function makeTarget() {
      var t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      var fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { t: t, fb: fb };
    }

    function dropTarget(t) {
      if (!t) return;
      gl.deleteTexture(t.t);
      gl.deleteFramebuffer(t.fb);
    }

    function averageLuma(img) {
      try {
        var c = document.createElement('canvas');
        c.width = c.height = 24;
        var g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, 24, 24);
        var d = g.getImageData(0, 0, 24, 24).data;
        var sum = 0;
        for (var i = 0; i < d.length; i += 4) {
          sum += (d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114) / 255;
        }
        var v = sum / (d.length / 4);
        return v > 0.02 ? v : 0.5;
      } catch (err) {
        return 0.5;
      }
    }

    var image = new Image();
    var ready = !src;
    image.onload = function () {
      if (!built) return;
      texAR = (image.naturalWidth || 1) / (image.naturalHeight || 1);
      pivot = averageLuma(image);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      ready = true;
      start();
    };
    image.onerror = function () { ready = false; };

    var loadStarted = false;
    function load() {
      if (loadStarted || !src) return;
      loadStarted = true;
      image.src = src;
    }

    function resize() {
      if (!built) return;
      var box = mount.getBoundingClientRect();
      if (!box.width || !box.height) return;

      var nextDpr = Math.min(window.devicePixelRatio || 1, DPR_MAX);
      /* страховка от длинных секций: держим канвас в бюджете пикселей,
         иначе каталог на 2600px просит десятки мегабайт */
      var budget = 2.4e6;
      if (box.width * box.height * nextDpr * nextDpr > budget * 2) {
        nextDpr = Math.max(0.5, Math.min(nextDpr, Math.sqrt((budget * 2) / (box.width * box.height))));
      }
      /* тот же бокс приходит и от ResizeObserver, и от resize окна */
      if (sized && box.width === cssW && box.height === cssH && nextDpr === dpr) return;

      dpr = nextDpr;
      cssW = box.width;
      cssH = box.height;
      W = Math.max(1, Math.round(cssW * dpr));
      H = Math.max(1, Math.round(cssH * dpr));
      canvas.width = W;
      canvas.height = H;

      tw = Math.max(2, Math.round(W * QUALITY));
      th = Math.max(2, Math.round(H * QUALITY));

      dropTarget(A);
      dropTarget(B);
      A = makeTarget();
      B = makeTarget();

      /* Кисть одного размера на всех страницах и во всех секциях: радиус
         задан в CSS-пикселях, а не в долях бокса или окна. */
      radius = BRUSH * widthScale * dpr * QUALITY;
      sized = true;

      if (!hasPointer) {
        pos_.x = aim.x = cssW * 0.5;
        pos_.y = aim.y = cssH * 0.45;
        prev.x = pos_.x;
        prev.y = pos_.y;
      }
    }

    function draw(now) {
      if (!A || !B) return;
      var dt = lastFrameAt ? Math.min(0.05, (now - lastFrameAt) / 1000) : 0.016;
      lastFrameAt = now;

      var k = 1 - Math.exp(-dt / SMOOTHER);
      prev.x = pos_.x;
      prev.y = pos_.y;
      pos_.x += (aim.x - pos_.x) * k;
      pos_.y += (aim.y - pos_.y) * k;

      var box = canvas.getBoundingClientRect();
      var dx = pos_.x - prev.x;
      var dy = pos_.y - prev.y;
      var dist = Math.hypot(dx, dy);

      gl.bindFramebuffer(gl.FRAMEBUFFER, B.fb);
      gl.viewport(0, 0, tw, th);
      gl.disable(gl.BLEND);
      gl.useProgram(ctx.fade.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, A.t);
      gl.uniform1i(ctx.fade.u.uPrev, 0);
      gl.uniform1f(ctx.fade.u.uDecay, Math.exp(-dt / LIFETIME));
      gl.uniform1f(ctx.fade.u.uFloor, FLOOR);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.enable(gl.BLEND);
      gl.blendEquation(gl.MAX);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(ctx.brush.p);
      gl.uniform2f(ctx.brush.u.uRes, tw, th);
      gl.uniform2f(ctx.brush.u.uRadius, radius, radius * heightScale);
      gl.uniform1f(ctx.brush.u.uEdge, edge);

      if (dist > 0.4 && dist < 800) {
        var steps = Math.max(1, Math.ceil(dist / 2));
        var ux = dx / dist;
        var uy = dy / dist;
        for (var i = 1; i <= steps; i++) {
          var d = (dist * i) / steps;
          gl.uniform2f(ctx.brush.u.uCenter,
            (prev.x + ux * d - box.left) * dpr * QUALITY,
            (prev.y + uy * d - box.top) * dpr * QUALITY);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
        lastStampAt = now;
      }
      gl.disable(gl.BLEND);

      var tmp = A; A = B; B = tmp;

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.disable(gl.BLEND);
      gl.useProgram(ctx.composite.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, A.t);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(ctx.composite.u.uTrail, 0);
      gl.uniform1i(ctx.composite.u.uTex, 1);
      gl.uniform2f(ctx.composite.u.uRes, W, H);
      gl.uniform2f(ctx.composite.u.uPos, pos[0], pos[1]);
      gl.uniform2f(ctx.composite.u.uOffset, offset[0], offset[1]);
      gl.uniform3f(ctx.composite.u.uBg, bgColor[0], bgColor[1], bgColor[2]);
      gl.uniform3f(ctx.composite.u.uTint, tint[0], tint[1], tint[2]);
      gl.uniform1f(ctx.composite.u.uTexAR, texAR);
      gl.uniform1f(ctx.composite.u.uZoom, zoom);
      gl.uniform1f(ctx.composite.u.uStrength, strength);
      gl.uniform1f(ctx.composite.u.uMono, mono);
      gl.uniform1f(ctx.composite.u.uEmboss, emboss);
      gl.uniform1f(ctx.composite.u.uSolid, solid ? 1 : 0);
      gl.uniform3f(ctx.composite.u.uSolidColor, solidColor[0], solidColor[1], solidColor[2]);
      gl.uniform1f(ctx.composite.u.uPivot, pivot);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function frame(now) {
      raf = 0;
      if (!built || !ready || !visible) return;
      draw(now);

      if (now - lastStampAt > HOLD) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, A.fb);
        gl.viewport(0, 0, tw, th);
        gl.disable(gl.BLEND);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        draw(now);
        running = false;
        lastFrameAt = 0;
        return;
      }
      raf = requestAnimationFrame(frame);
    }

    function start() {
      if (running || !built || !ready || !visible) return;
      running = true;
      lastFrameAt = 0;
      raf = requestAnimationFrame(frame);
    }

    function pause() {
      if (!raf) return;
      cancelAnimationFrame(raf);
      raf = 0;
      running = false;
      fresh = true;   /* после паузы курсор уже не там, где был */
    }

    function onPointer(e) {
      if (e.pointerType === 'touch') return;
      if (!built) { if (!build()) return; }
      load();
      if (!sized) resize();

      var now = performance.now();
      var away = now - lastMoveAt > 160;
      lastMoveAt = now;

      aim.x = e.clientX;
      aim.y = e.clientY;

      /* Первое движение после входа в секцию или после паузы — это не мазок,
         а постановка пера: иначе кисть «бежит» к курсору от старой точки. */
      if (!hasPointer || fresh || away) {
        hasPointer = true;
        fresh = false;
        pos_.x = prev.x = aim.x;
        pos_.y = prev.y = aim.y;
        lastStampAt = now;
        start();
        return;
      }

      lastStampAt = now;
      start();
    }

    host.addEventListener('pointermove', onPointer, { passive: true });
    /* ушли с секции или вернулись — перо поднимаем */
    host.addEventListener('pointerenter', function () { fresh = true; });
    host.addEventListener('pointerleave', function () { fresh = true; });
    window.addEventListener('resize', function () { if (built) resize(); });

    /* Секция меняет высоту и без resize окна — фильтр каталога, загрузка
       шрифтов, раскрытый список. Канвас обязан пересобраться под новый бокс,
       иначе маска растягивается и след уезжает от курсора. */
    if ('ResizeObserver' in window) {
      new ResizeObserver(function () { if (built) resize(); }).observe(mount);
    }

    document.addEventListener('visibilitychange', function () {
      visible = !document.hidden;
      if (!visible) pause();
      else start();
    });

    if ('IntersectionObserver' in window) {
      var boot = new IntersectionObserver(function (entries) {
        if (!entries[0].isIntersecting) return;
        boot.disconnect();
        load();
        build();
        resize();
      }, { rootMargin: '600px 0px' });
      boot.observe(host);

      var vis = new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (!visible) pause();
        else start();
      }, { rootMargin: '25% 0px' });
      vis.observe(host);
    } else {
      load();
      build();
      resize();
    }

    return {};
  }

  function boot() {
    var hosts = document.querySelectorAll('[data-trail]');
    for (var i = 0; i < hosts.length; i++) create(hosts[i]);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
