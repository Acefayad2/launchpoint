(() => {
  const intro = document.getElementById('launch-intro');
  if (!intro) return;

  const finish = () => {
    if (intro.isConnected) intro.remove();
  };

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    finish();
    return;
  }

  document.getElementById('launch-intro-skip')?.addEventListener('click', finish);
  intro.addEventListener('animationend', (event) => {
    if (event.target === intro) finish();
  });
  window.setTimeout(finish, 3600);
})();
