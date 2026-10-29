// Launch experience: ignition sparks for the intro and background depth for the hero.
// Additive only: the approved intro controller and hero WebGL stay untouched.
(() => {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------- Intro ignition sparks ---------- */
  const intro = document.getElementById('launch-intro');
  if (intro && !motion.matches) {
    const ship = intro.querySelector('.launch-intro-ship');
    const canvas = document.createElement('canvas');
    canvas.className = 'launch-ignition';
    canvas.setAttribute('aria-hidden', 'true');
    intro.insertBefore(canvas, intro.querySelector('.launch-intro-ship'));
    const ctx = canvas.getContext('2d');
    const sparks = [];
    let frame;
    let startedAt = 0;
    let last = 0;

    const size = () => {
      canvas.width = Math.round(window.innerWidth * Math.min(window.devicePixelRatio || 1, 1.5));
      canvas.height = Math.round(window.innerHeight * Math.min(window.devicePixelRatio || 1, 1.5));
    };

    const emit = (x, y, count, heat) => {
      for (let i = 0; i < count; i++) {
        const angle = Math.PI / 2 + (Math.random() - .5) * 1.5;
        const speed = (2.2 + Math.random() * 6.5) * heat;
        sparks.push({
          x: x + (Math.random() - .5) * 10,
          y,
          vx: Math.cos(angle) * speed * (Math.random() < .5 ? -1 : 1) * .55,
          vy: Math.sin(angle) * speed,
          life: 1,
          decay: .014 + Math.random() * .03,
          r: .6 + Math.random() * 1.8,
          hot: Math.random() < .35,
        });
      }
    };

    const tick = now => {
      if (!intro.isConnected) return stop();
      const t = (now - startedAt) / 1000;
      const dt = Math.min(2, (now - last) / 16.67 || 1);
      last = now;
      const scale = canvas.width / window.innerWidth;
      const rect = ship.getBoundingClientRect();
      const nozzleX = (rect.left + rect.width / 2) * scale;
      const nozzleY = (rect.bottom - rect.height * .02) * scale;
      const heat = Math.max(0, 1 - t / 1.6);
      if (heat > 0 && nozzleY > 0) emit(nozzleX, nozzleY, Math.round(9 * heat + 1), .7 + heat * .6);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.vy += .16 * dt;
        s.vx *= .985;
        s.x += s.vx * dt * scale;
        s.y += s.vy * dt * scale;
        s.life -= s.decay * dt;
        if (s.life <= 0 || s.y > canvas.height + 20) { sparks.splice(i, 1); continue; }
        const alpha = s.life * s.life;
        ctx.fillStyle = s.hot ? `rgba(255, 244, 222, ${alpha})` : `rgba(255, ${120 + s.life * 80 | 0}, ${50 + s.life * 40 | 0}, ${alpha})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * scale * (.5 + s.life * .5), 0, Math.PI * 2);
        ctx.fill();
      }
      if (t < 3.2 || sparks.length) frame = requestAnimationFrame(tick);
    };

    const stop = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', size);
      observer.disconnect();
    };

    const begin = () => {
      if (frame) return;
      size();
      window.addEventListener('resize', size, { passive: true });
      startedAt = last = performance.now();
      frame = requestAnimationFrame(tick);
    };

    const observer = new MutationObserver(() => {
      if (!intro.isConnected) return stop();
      if (intro.classList.contains('is-playing')) begin();
    });
    observer.observe(intro, { attributes: true, attributeFilter: ['class'] });
    observer.observe(intro.parentNode, { childList: true });
  }

  /* ---------- Hero background depth ---------- */
  const hero = document.querySelector('.hero-template');
  const webgl = document.getElementById('hero-webgl');
  if (!hero || !webgl) return;

  const ns = 'http://www.w3.org/2000/svg';
  const depth = document.createElement('div');
  depth.className = 'hero-depth';
  depth.setAttribute('aria-hidden', 'true');
  depth.innerHTML = `
    <canvas class="hero-depth-stars"></canvas>
    <div class="hero-depth-orbits">
      <svg viewBox="-500 -500 1000 1000">
        <defs>
          <radialGradient id="hd-sat"><stop offset="0" stop-color="#fff"/><stop offset=".35" stop-color="#ffb08a"/><stop offset="1" stop-color="#ff6a3d" stop-opacity="0"/></radialGradient>
        </defs>
        <g transform="rotate(-14)">
          <ellipse rx="430" ry="104" fill="none" stroke="#ffffff" stroke-opacity=".13" stroke-width="1"/>
          <path id="hd-orbit-a" d="M-430 0a430 104 0 1 0 860 0a430 104 0 1 0-860 0" fill="none"/>
        </g>
        <g transform="rotate(22)">
          <ellipse rx="350" ry="250" fill="none" stroke="#ffffff" stroke-opacity=".07" stroke-width="1" stroke-dasharray="2 9"/>
          <path id="hd-orbit-b" d="M-350 0a350 250 0 1 0 700 0a350 250 0 1 0-700 0" fill="none"/>
        </g>
        <g transform="rotate(-38)">
          <ellipse rx="480" ry="40" fill="none" stroke="#ff8a5c" stroke-opacity=".12" stroke-width="1"/>
          <path id="hd-orbit-c" d="M-480 0a480 40 0 1 0 960 0a480 40 0 1 0-960 0" fill="none"/>
        </g>
      </svg>
    </div>
    <div class="hero-depth-horizon"></div>`;
  webgl.after(depth);

  const svg = depth.querySelector('svg');
  [['hd-orbit-a', 'rotate(-14)', 34, 7], ['hd-orbit-b', 'rotate(22)', 52, 4.5], ['hd-orbit-c', 'rotate(-38)', 26, 5]].forEach(([id, rot, dur, r]) => {
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('transform', rot);
    const sat = document.createElementNS(ns, 'circle');
    sat.setAttribute('r', r);
    sat.setAttribute('fill', 'url(#hd-sat)');
    const core = document.createElementNS(ns, 'circle');
    core.setAttribute('r', r / 3.5);
    core.setAttribute('fill', '#fff');
    [sat, core].forEach(node => {
      if (motion.matches) {
        const pt = svg.getElementById?.(id) || depth.querySelector(`#${id}`);
        const p = pt.getPointAtLength(pt.getTotalLength() * .3);
        node.setAttribute('cx', p.x);
        node.setAttribute('cy', p.y);
      } else {
        const anim = document.createElementNS(ns, 'animateMotion');
        anim.setAttribute('dur', `${dur}s`);
        anim.setAttribute('repeatCount', 'indefinite');
        anim.setAttribute('rotate', 'auto');
        const mpath = document.createElementNS(ns, 'mpath');
        mpath.setAttribute('href', `#${id}`);
        anim.appendChild(mpath);
        node.appendChild(anim);
      }
      g.appendChild(node);
    });
    svg.appendChild(g);
  });

  /* Starfield: three parallax layers, twinkle, and the occasional launch streak. */
  const canvas = depth.querySelector('.hero-depth-stars');
  const ctx = canvas.getContext('2d');
  let stars = [];
  let streaks = [];
  let w = 0;
  let h = 0;
  let dpr = 1;
  let frame;
  let visible = true;
  let px = 0;
  let py = 0;

  const build = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    w = hero.clientWidth;
    h = hero.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const count = Math.round(Math.min(260, (w * h) / 5200));
    stars = Array.from({ length: count }, () => {
      const layer = Math.random() < .7 ? 0 : Math.random() < .75 ? 1 : 2;
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        r: [.55, .9, 1.35][layer] * (.8 + Math.random() * .4),
        a: [.35, .55, .85][layer] * (.6 + Math.random() * .4),
        layer,
        phase: Math.random() * Math.PI * 2,
        speed: .4 + Math.random() * 1.4,
        warm: Math.random() < .12,
      };
    });
  };

  const draw = now => {
    const t = now / 1000;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      const drift = (t * (s.layer + 1) * 1.6) % w;
      const x = (s.x + drift + px * (s.layer + 1) * .6 + w) % w;
      const y = s.y + py * (s.layer + 1) * .6;
      const twinkle = motion.matches ? 1 : .65 + Math.sin(t * s.speed + s.phase) * .35;
      ctx.globalAlpha = s.a * twinkle;
      ctx.fillStyle = s.warm ? '#ffc7a8' : '#ffffff';
      ctx.beginPath();
      ctx.arc(x, y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!motion.matches) {
      if (Math.random() < .004 && streaks.length < 2) {
        streaks.push({ x: w * (.15 + Math.random() * .7), y: h * (.65 + Math.random() * .3), life: 1, len: 90 + Math.random() * 120, angle: -Math.PI / 2 + (Math.random() - .5) * .9 });
      }
      for (let i = streaks.length - 1; i >= 0; i--) {
        const s = streaks[i];
        s.x += Math.cos(s.angle) * 7;
        s.y += Math.sin(s.angle) * 7;
        s.life -= .012;
        if (s.life <= 0) { streaks.splice(i, 1); continue; }
        const tx = s.x - Math.cos(s.angle) * s.len;
        const ty = s.y - Math.sin(s.angle) * s.len;
        const grad = ctx.createLinearGradient(s.x, s.y, tx, ty);
        grad.addColorStop(0, `rgba(255, 238, 220, ${s.life})`);
        grad.addColorStop(.25, `rgba(255, 138, 92, ${s.life * .6})`);
        grad.addColorStop(1, 'rgba(232, 80, 42, 0)');
        ctx.globalAlpha = 1;
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(tx, ty);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  };

  let lastDraw = 0;
  const loop = now => {
    if (!visible || document.hidden) { frame = undefined; return; }
    if (now - lastDraw > 1000 / 30 - 1) { lastDraw = now; draw(now); }
    frame = requestAnimationFrame(loop);
  };
  const play = () => { if (!frame && !motion.matches) frame = requestAnimationFrame(loop); };

  build();
  draw(performance.now());
  requestAnimationFrame(() => depth.classList.add('is-ready'));
  play();

  new ResizeObserver(() => { build(); draw(performance.now()); }).observe(hero);
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) play(); }).observe(hero);
  document.addEventListener('visibilitychange', play);
  motion.addEventListener('change', () => { if (motion.matches) draw(performance.now()); else play(); });

  if (window.matchMedia('(pointer: fine)').matches && !motion.matches) {
    const orbits = depth.querySelector('.hero-depth-orbits');
    hero.addEventListener('pointermove', event => {
      const rect = hero.getBoundingClientRect();
      const nx = (event.clientX - rect.left) / rect.width - .5;
      const ny = (event.clientY - rect.top) / rect.height - .5;
      px = nx * -14;
      py = ny * -10;
      orbits.style.setProperty('--px', `${nx * -22}px`);
      orbits.style.setProperty('--py', `${ny * -16}px`);
    }, { passive: true });
  }
})();
