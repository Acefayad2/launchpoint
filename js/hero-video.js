(() => {
  const video = document.getElementById('hero-video');
  if (!video) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const saveData = navigator.connection?.saveData;
  if (reducedMotion.matches || saveData) return;

  const start = () => {
    if (video.ended) return;
    if (!video.src) {
      video.src = video.dataset.src;
      video.load();
    }
    video.play().catch(() => {});
  };

  video.addEventListener('playing', () => video.classList.add('is-ready'));
  video.addEventListener('error', () => video.classList.remove('is-ready'));

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !document.hidden) start();
      else video.pause();
    }, { threshold: 0.1 });
    observer.observe(video);
  } else start();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) video.pause();
    else if (video.getBoundingClientRect().bottom > 0) start();
  });
})();
