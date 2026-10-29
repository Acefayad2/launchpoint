// Keep the original header over the hero; use the reference's light header below it.
(() => {
  const hero = document.querySelector('.hero');
  const nav = document.getElementById('nav');
  if (!hero || !nav || !('IntersectionObserver' in window)) return;
  new IntersectionObserver(([entry]) => {
    nav.classList.toggle('nav-on-light', !entry.isIntersecting && entry.boundingClientRect.bottom < 72);
  }, { rootMargin: '-72px 0px 0px 0px' }).observe(hero);
})();
