(() => {
  const intro = document.getElementById('launch-intro');
  if (!intro) return;
  const video = document.getElementById('launch-intro-video');
  let finishTimer;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    window.clearTimeout(finishTimer);
    video?.pause();
    if (intro.isConnected) intro.remove();
  };

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    finish();
    return;
  }

  document.getElementById('launch-intro-skip')?.addEventListener('click', finish);
  window.addEventListener('scroll', () => {
    if (window.scrollY > 20) finish();
  }, { passive: true });
  video?.addEventListener('playing', () => {
    intro.classList.add('is-playing');
    finishTimer = window.setTimeout(finish, 5350);
  });
  video?.addEventListener('error', finish);
  video?.play().catch(finish);
  window.setTimeout(() => {
    if (!intro.classList.contains('is-playing')) finish();
  }, 4000);
})();
