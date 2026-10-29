(() => {
  const intro = document.getElementById('launch-intro');
  if (!intro) return;
  let finishTimer;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    window.clearTimeout(finishTimer);
    if (intro.isConnected) intro.remove();
  };

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    finish();
    return;
  }

  document.getElementById('launch-intro-skip')?.addEventListener('click', finish);
  if (window.scrollY > 20 || window.location.hash) {
    finish();
    return;
  }
  window.requestAnimationFrame(() => {
    intro.classList.add('is-playing');
    finishTimer = window.setTimeout(finish, 3900);
  });
})();
