(() => {
  const canvas = document.getElementById('hero-webgl');
  if (!canvas || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' });
  if (!gl) return;

  const vertexSource = `
    attribute vec2 position;
    varying vec2 vUv;
    void main() {
      vUv = position * 0.5 + 0.5;
      gl_Position = vec4(position, 0.0, 1.0);
    }
  `;
  // The blob is a still render plus its depth map. Interaction is derived from the depth:
  // parallax tilt, a lens under the cursor, a cursor-driven light raking the ridges,
  // a scanner line that locks to the hovered depth, and click ripples through the rings.
  const fragmentSource = `
    precision mediump float;
    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform sampler2D uDepth;
    uniform vec2 uResolution;
    uniform vec2 uPointer;
    uniform vec2 uMouse;
    uniform float uHover;
    uniform float uProgress;
    uniform vec3 uRipple;
    float depthAt(vec2 p) { return texture2D(uDepth, clamp(p, 0.0, 1.0)).r; }
    void main() {
      float size = min(uResolution.x * 0.9, uResolution.y * 0.88);
      vec2 uv = (vUv * uResolution - uResolution * 0.5) / size + 0.5;
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      vec2 toMouse = uv - uMouse;
      float mouseDist = length(toMouse);
      float near = exp(-mouseDist * mouseDist * 16.0) * uHover;

      vec2 p = uMouse + toMouse * (1.0 - 0.16 * near);

      float wave = 0.0;
      if (uRipple.z >= 0.0) {
        vec2 toRipple = uv - uRipple.xy;
        float rippleDist = length(toRipple);
        float front = uRipple.z * 0.62;
        wave = exp(-pow((rippleDist - front) * 18.0, 2.0)) * (1.0 - smoothstep(0.6, 1.7, uRipple.z));
        p += normalize(toRipple + 1e-5) * wave * 0.018;
      }

      float depth = depthAt(p);
      vec2 displaced = clamp(p + depth * uPointer * 0.032, 0.0, 1.0);
      vec3 base = texture2D(uTexture, displaced).rgb;
      float silhouette = smoothstep(0.04, 0.16, dot(base, vec3(0.3333)));

      float e = 1.0 / 420.0;
      float dx = depthAt(displaced + vec2(e, 0.0)) - depthAt(displaced - vec2(e, 0.0));
      float dy = depthAt(displaced + vec2(0.0, e)) - depthAt(displaced - vec2(0.0, e));
      vec3 normal = normalize(vec3(-dx * 9.0, -dy * 9.0, 1.0));
      vec3 lightDir = normalize(vec3(uMouse - displaced, 0.32));
      float diffuse = max(dot(normal, lightDir), 0.0);
      float spec = pow(max(dot(reflect(-lightDir, normal), vec3(0.0, 0.0, 1.0)), 0.0), 22.0);
      float reach = exp(-mouseDist * mouseDist * 5.5) * uHover;
      vec3 light = (vec3(1.0, 0.42, 0.18) * spec * 1.35 + vec3(1.0, 0.86, 0.78) * diffuse * 0.16) * reach * silhouette;

      float target = mix(uProgress, depthAt(uMouse), uHover * 0.85);
      float scan = 1.0 - smoothstep(0.0, 0.035, abs(depth - target));
      vec2 grid = fract(uv * 120.0) - 0.5;
      float dotShape = 1.0 - smoothstep(0.17, 0.32, length(grid));
      float grain = fract(sin(dot(floor(uv * 120.0), vec2(12.9898, 78.233))) * 43758.5453);
      vec3 redScan = vec3(0.9, 0.09, 0.04) * scan * (0.18 + dotShape * grain * 2.2) * silhouette;
      vec3 rippleGlow = vec3(1.0, 0.38, 0.14) * wave * silhouette * (0.35 + dotShape * 0.9);

      gl_FragColor = vec4(base * (1.0 - near * 0.08) + light + redScan + rippleGlow, 1.0);
    }
  `;

  function makeShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return null;
    return shader;
  }
  const vertex = makeShader(gl.VERTEX_SHADER, vertexSource);
  const fragment = makeShader(gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return;
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
  gl.useProgram(program);

  const vertices = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const resolution = gl.getUniformLocation(program, 'uResolution');
  const pointer = gl.getUniformLocation(program, 'uPointer');
  const mouse = gl.getUniformLocation(program, 'uMouse');
  const hover = gl.getUniformLocation(program, 'uHover');
  const progress = gl.getUniformLocation(program, 'uProgress');
  const ripple = gl.getUniformLocation(program, 'uRipple');
  const hero = canvas.parentElement;
  const target = { x: 0, y: 0, u: .5, v: .5, hover: 0 };
  const eased = { x: 0, y: 0, u: .5, v: .5, hover: 0 };
  const rippleAt = { u: .5, v: .5, start: -1 };
  let active = false;
  let scheduled = false;
  let lastTime = 0;
  let touchRelease;

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(canvas.clientWidth * ratio);
    canvas.height = Math.round(canvas.clientHeight * ratio);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(resolution, canvas.width, canvas.height);
  }
  // Same mapping as the shader: canvas pixels -> square texture space.
  function toTexture(event) {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * canvas.width;
    const y = (rect.bottom - event.clientY) / rect.height * canvas.height;
    const size = Math.min(canvas.width * .9, canvas.height * .88);
    return { u: (x - canvas.width / 2) / size + .5, v: (y - canvas.height / 2) / size + .5 };
  }
  function frame(time) {
    scheduled = false;
    if (!active || document.hidden) return;
    const dt = Math.min(64, time - (lastTime || time)) / 16.67;
    lastTime = time;
    const follow = 1 - Math.pow(.86, dt);
    const fade = 1 - Math.pow(.92, dt);
    eased.x += (target.x - eased.x) * follow;
    eased.y += (target.y - eased.y) * follow;
    eased.u += (target.u - eased.u) * follow * 1.4;
    eased.v += (target.v - eased.v) * follow * 1.4;
    eased.hover += (target.hover - eased.hover) * fade;
    const age = rippleAt.start < 0 ? -1 : (time - rippleAt.start) / 1000;
    if (age > 1.8) rippleAt.start = -1;
    gl.uniform2f(pointer, eased.x, eased.y);
    gl.uniform2f(mouse, eased.u, eased.v);
    gl.uniform1f(hover, eased.hover);
    gl.uniform3f(ripple, rippleAt.u, rippleAt.v, rippleAt.start < 0 ? -1 : age);
    gl.uniform1f(progress, Math.sin(time * 0.0005) * 0.5 + 0.5);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    canvas.classList.add('is-ready');
    schedule();
  }
  function schedule() {
    if (!scheduled && active && !document.hidden) {
      scheduled = true;
      requestAnimationFrame(frame);
    }
  }
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }
  function texture(image, unit, name) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    const value = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, value);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program, name), unit);
  }

  function track(event) {
    target.x = event.clientX / window.innerWidth * 2 - 1;
    target.y = 1 - event.clientY / window.innerHeight * 2;
    const point = toTexture(event);
    target.u = point.u;
    target.v = point.v;
    target.hover = 1;
    hero.classList.add('is-exploring');
  }

  Promise.all([
    loadImage('assets/template-hero-texture.png'),
    loadImage('assets/template-hero-depth.webp')
  ]).then(([image, depth]) => {
    texture(image, 0, 'uTexture');
    texture(depth, 1, 'uDepth');
    resize();
    window.addEventListener('resize', resize, { passive: true });
    hero.addEventListener('pointermove', track, { passive: true });
    hero.addEventListener('pointerdown', (event) => {
      if (event.target.closest('a, button')) return;
      track(event);
      const point = toTexture(event);
      rippleAt.u = point.u;
      rippleAt.v = point.v;
      rippleAt.start = performance.now();
      clearTimeout(touchRelease);
    }, { passive: true });
    hero.addEventListener('pointerup', (event) => {
      if (event.pointerType !== 'mouse') touchRelease = setTimeout(() => { target.hover = 0; }, 900);
    }, { passive: true });
    hero.addEventListener('pointerleave', () => {
      target.hover = 0;
      target.x = 0;
      target.y = 0;
    }, { passive: true });
    document.addEventListener('visibilitychange', schedule);
    const observer = new IntersectionObserver((entries) => {
      active = entries[0].isIntersecting;
      schedule();
    });
    observer.observe(canvas);
  }).catch(() => { /* The still image remains visible if a texture cannot load. */ });
})();
