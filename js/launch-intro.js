(() => {
  const intro = document.getElementById('launch-intro');
  if (!intro) return;
  const root = document.documentElement;
  const skip = document.getElementById('launch-intro-skip');
  const canvas = intro.querySelector('canvas');
  const ship = intro.querySelector('.launch-intro-ship');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let finishTimer;
  let frameId;
  let release;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    window.clearTimeout(finishTimer);
    window.cancelAnimationFrame(frameId);
    release?.();
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', finish);
    window.removeEventListener('hashchange', finish);
    window.removeEventListener('pagehide', finish);
    document.removeEventListener('focusin', onFocus);
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('visibilitychange', onVisibility);
    motion.removeEventListener('change', onMotionChange);
    root.classList.remove('launch-pending');
    if (document.activeElement === skip) document.querySelector('.nav-logo')?.focus();
    if (intro.isConnected) intro.remove();
  };
  const onScroll = () => { if (window.scrollY > 20) finish(); };
  const onMotionChange = () => { if (motion.matches) finish(); };
  const onFocus = event => { if (!intro.contains(event.target)) finish(); };
  const onKeydown = event => { if (event.key === 'Escape') finish(); };
  const onVisibility = () => { if (document.hidden) finish(); };

  if (!root.classList.contains('launch-pending') || motion.matches || document.hidden || window.scrollY > 20 || window.location.hash) {
    finish();
    return;
  }

  skip?.addEventListener('click', finish);
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', finish, { once: true });
  window.addEventListener('hashchange', finish);
  window.addEventListener('pagehide', finish);
  document.addEventListener('focusin', onFocus);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('visibilitychange', onVisibility);
  motion.addEventListener('change', onMotionChange);

  finishTimer = window.setTimeout(finish, 800);
  intro.querySelector('img').decode().then(() => {
    if (finished) return;
    const gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
    if (!gl) return finish();
    const vertex = gl.createShader(gl.VERTEX_SHADER);
    const fragment = gl.createShader(gl.FRAGMENT_SHADER);
    const program = gl.createProgram();
    const buffer = gl.createBuffer();
    release = () => {
      canvas.removeEventListener('webglcontextlost', finish);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
    canvas.addEventListener('webglcontextlost', finish, { once: true });
    gl.shaderSource(vertex, `
      attribute vec2 position;
      varying vec2 uv;
      void main() {
        uv = position * .5 + .5;
        gl_Position = vec4(position, 0., 1.);
      }
    `);
    gl.shaderSource(fragment, `
      precision highp float;
      varying vec2 uv;
      uniform float time;
      uniform float aspect;
      uniform float nozzle;
      float hash(vec2 p) {
        vec3 q = fract(vec3(p.xyx) * .1031);
        q += dot(q, q.yzx + 33.33);
        return fract((q.x + q.y) * q.z);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3. - 2. * f);
        return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x),
                   mix(hash(i + vec2(0., 1.)), hash(i + 1.), f.x), f.y);
      }
      float fbm(vec2 p) {
        float n = 0.;
        float a = .55;
        for (int i = 0; i < 3; i++) {
          n += noise(p) * a;
          p = mat2(.8, -.6, .6, .8) * p * 2.07 + 9.2;
          a *= .48;
        }
        return n;
      }
      void main() {
        float clearing = smoothstep(.18, 2.65, time);
        float side = smoothstep(.32, .68, uv.x) * 2. - 1.;
        vec2 p = vec2((uv.x - .5) * aspect, uv.y) * 3.6;
        p -= vec2(side * clearing * 1.4, time * .19);
        vec2 curl = vec2(fbm(p * .7 + vec2(2.3, time * .08)),
                         fbm(p * .7 + vec2(8.1, -time * .06)));
        vec2 folds = p * 1.65 + (curl - .5) * .75;
        float volume = fbm(folds);
        float detail = fbm(folds * 2.7 + vec2(0., time * .22));
        float edge = abs(uv.x - .5);
        float wake = (1. - smoothstep(.015, .16 + clearing * .3, edge))
                   * (1. - smoothstep(nozzle - .12, nozzle + .12, uv.y))
                   * smoothstep(.25, 1.1, time);
        float density = volume * .92 + detail * .22 + .2
                      + edge * .15 - clearing * 1.16 - wake * .45;
        float alpha = smoothstep(.01, .58, density);
        alpha *= 1. - smoothstep(2.35, 2.8, time);
        if (alpha < .002) { gl_FragColor = vec4(0.); return; }
        float light = fbm(folds + vec2(-.16, .2));
        float shade = clamp(.18 + volume * .75 + (volume - light) * .45 + detail * .18, .2, .87);
        vec3 color = mix(vec3(.22, .245, .26), vec3(.68, .71, .73), shade);
        float glow = exp(-edge * 26.) * exp(-abs(uv.y - nozzle) * 8.);
        color += vec3(.12, .17, .20) * glow;
        gl_FragColor = vec4(color * alpha, alpha);
      }
    `);
    gl.compileShader(vertex);
    gl.compileShader(fragment);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return finish();
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const ratio = Math.min(1, 800 / viewportWidth, Math.sqrt(320000 / (viewportWidth * viewportHeight)));
    canvas.width = Math.round(viewportWidth * ratio);
    canvas.height = Math.round(viewportHeight * ratio);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform1f(gl.getUniformLocation(program, 'aspect'), viewportWidth / viewportHeight);
    const time = gl.getUniformLocation(program, 'time');
    const nozzle = gl.getUniformLocation(program, 'nozzle');
    const shipHeight = ship.offsetHeight;
    const travel = viewportHeight * .7 + shipHeight * 1.5;
    const started = performance.now();
    let lastDraw = -100;
    const draw = now => {
      if (finished) return;
      if (!root.classList.contains('launch-pending')) return finish();
      const seconds = (now - started) / 1000;
      if (seconds >= 2.85) return finish();
      const progress = Math.min(seconds / 2.4, 1);
      const y = -travel * (.12 * progress + .88 * progress * progress);
      ship.style.transform = `translate3d(-50%, ${y}px, 0)`;
      if (now - lastDraw >= 1000 / 30 - 1) {
        lastDraw = now;
        gl.uniform1f(time, seconds);
        gl.uniform1f(nozzle, 1 - (.44 * viewportHeight + shipHeight * .96 + y) / viewportHeight);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      frameId = window.requestAnimationFrame(draw);
    };
    draw(started);
    intro.classList.add('is-playing');
    window.clearTimeout(finishTimer);
    finishTimer = window.setTimeout(finish, 3100);
  }).catch(finish);
})();
