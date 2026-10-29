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
  const fragmentSource = `
    precision mediump float;
    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform sampler2D uDepth;
    uniform vec2 uResolution;
    uniform vec2 uPointer;
    uniform float uProgress;
    void main() {
      float size = min(uResolution.x * 0.9, uResolution.y * 0.88);
      vec2 uv = (vUv * uResolution - uResolution * 0.5) / size + 0.5;
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      float depth = texture2D(uDepth, uv).r;
      vec2 displaced = clamp(uv + depth * uPointer * 0.011, 0.0, 1.0);
      vec3 base = texture2D(uTexture, displaced).rgb;
      float scan = 1.0 - smoothstep(0.0, 0.035, abs(depth - uProgress));
      vec2 grid = fract(uv * 120.0) - 0.5;
      float dotShape = 1.0 - smoothstep(0.17, 0.32, length(grid));
      float grain = fract(sin(dot(floor(uv * 120.0), vec2(12.9898, 78.233))) * 43758.5453);
      float silhouette = smoothstep(0.04, 0.16, dot(base, vec3(0.3333)));
      vec3 redScan = vec3(0.9, 0.09, 0.04) * scan * (0.18 + dotShape * grain * 2.2) * silhouette;
      gl_FragColor = vec4(base + redScan, 1.0);
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
  const progress = gl.getUniformLocation(program, 'uProgress');
  let pointerX = 0;
  let pointerY = 0;
  let active = false;
  let scheduled = false;

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(canvas.clientWidth * ratio);
    canvas.height = Math.round(canvas.clientHeight * ratio);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(resolution, canvas.width, canvas.height);
  }
  function frame(time) {
    scheduled = false;
    if (!active || document.hidden) return;
    gl.uniform2f(pointer, pointerX, pointerY);
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

  Promise.all([
    loadImage('assets/template-hero-texture.png'),
    loadImage('assets/template-hero-depth.webp')
  ]).then(([image, depth]) => {
    texture(image, 0, 'uTexture');
    texture(depth, 1, 'uDepth');
    resize();
    window.addEventListener('resize', resize, { passive: true });
    canvas.parentElement.addEventListener('pointermove', (event) => {
      pointerX = event.clientX / window.innerWidth * 2 - 1;
      pointerY = 1 - event.clientY / window.innerHeight * 2;
    }, { passive: true });
    document.addEventListener('visibilitychange', schedule);
    const observer = new IntersectionObserver((entries) => {
      active = entries[0].isIntersecting;
      schedule();
    });
    observer.observe(canvas);
  }).catch(() => { /* The still image remains visible if a texture cannot load. */ });
})();
