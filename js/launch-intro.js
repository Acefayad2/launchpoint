(() => {
  const intro = document.getElementById('launch-intro');
  if (!intro) return;
  const root = document.documentElement;
  const skip = document.getElementById('launch-intro-skip');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let finishTimer;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    window.clearTimeout(finishTimer);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('hashchange', finish);
    window.removeEventListener('pagehide', finish);
    document.removeEventListener('focusin', onFocus);
    document.removeEventListener('keydown', onKeydown);
    motion.removeEventListener('change', onMotionChange);
    root.classList.remove('launch-pending');
    if (document.activeElement === skip) document.querySelector('.nav-logo')?.focus();
    if (intro.isConnected) intro.remove();
  };
  const onScroll = () => { if (window.scrollY > 20) finish(); };
  const onMotionChange = () => { if (motion.matches) finish(); };
  const onFocus = event => { if (!intro.contains(event.target)) finish(); };
  const onKeydown = event => { if (event.key === 'Escape') finish(); };

  if (!root.classList.contains('launch-pending') || motion.matches || window.scrollY > 20 || window.location.hash) {
    finish();
    return;
  }

  skip?.addEventListener('click', finish);
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('hashchange', finish);
  window.addEventListener('pagehide', finish);
  document.addEventListener('focusin', onFocus);
  document.addEventListener('keydown', onKeydown);
  motion.addEventListener('change', onMotionChange);

  finishTimer = window.setTimeout(finish, 800);
  intro.querySelector('img').decode().then(() => {
    if (finished) return;
    window.requestAnimationFrame(() => {
      if (finished) return;
      if (!root.classList.contains('launch-pending')) return finish();
      intro.classList.add('is-playing');
      window.clearTimeout(finishTimer);
      finishTimer = window.setTimeout(finish, 2850);
    });
  }).catch(finish);
})();
