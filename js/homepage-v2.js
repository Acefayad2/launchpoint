// Keep the original header over the hero; use the reference's light header below it.
(() => {
  const hero = document.querySelector('.hero');
  const nav = document.getElementById('nav');
  if (!hero || !nav || !('IntersectionObserver' in window)) return;
  new IntersectionObserver(([entry]) => {
    nav.classList.toggle('nav-on-light', !entry.isIntersecting && entry.boundingClientRect.bottom < 72);
  }, { rootMargin: '-72px 0px 0px 0px' }).observe(hero);
})();

(() => {
  const strip = document.getElementById('service-orbit');
  const track = document.getElementById('service-orbit-track');
  const list = track?.querySelector('.v2-orbit-list');
  if (!strip || !track || !list) return;

  const duplicate = list.cloneNode(true);
  duplicate.setAttribute('aria-hidden', 'true');
  track.append(duplicate);
  strip.classList.add('is-orbit-ready');

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      strip.classList.toggle('is-offscreen', !entry.isIntersecting);
    }).observe(strip);
  }
  const syncVisibility = () => strip.classList.toggle('is-page-hidden', document.hidden);
  document.addEventListener('visibilitychange', syncVisibility);
  syncVisibility();
})();
