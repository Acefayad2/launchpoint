(() => {
  const intro = document.getElementById('launch-intro');
  if (!intro) return;
  const hero = document.querySelector('.hero');
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
    motion.removeEventListener('change', onMotionChange);
    hero?.classList.remove('is-launching');
    if (document.activeElement === skip) document.querySelector('.nav-logo')?.focus();
    if (intro.isConnected) intro.remove();
  };
  const onScroll = () => { if (window.scrollY > 20) finish(); };
  const onMotionChange = () => { if (motion.matches) finish(); };

  if (motion.matches || window.scrollY > 20 || window.location.hash) {
    finish();
    return;
  }

  skip?.addEventListener('click', finish);
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('hashchange', finish);
  motion.addEventListener('change', onMotionChange);

  // No loading screen: content stays usable even if the asset cannot load.
  finishTimer = window.setTimeout(finish, 800);
  intro.querySelector('img').decode().then(() => {
    if (finished) return;
    window.requestAnimationFrame(() => {
      if (finished) return;
      // Never conceal a title that someone has already had time to read.
      if (performance.now() < 350) hero?.classList.add('is-launching');
      intro.classList.add('is-playing');
      window.clearTimeout(finishTimer);
      finishTimer = window.setTimeout(finish, 3000);
    });
  }).catch(finish);
})();
