/* LaunchPoint — Main JS */

const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 20);
}, { passive: true });

const navToggle = document.getElementById('navToggle');
const navMobile = document.getElementById('navMobile');
navToggle.addEventListener('click', () => {
  navMobile.classList.toggle('open');
});
document.querySelectorAll('.nav-mobile a').forEach(link => {
  link.addEventListener('click', () => navMobile.classList.remove('open'));
});

// Scroll reveal
const revealEls = document.querySelectorAll(
  '.service-card, .service-feature, .testimonial, .process-step, .pricing-tier, .proof-stat'
);
const revealObs = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('reveal', 'visible');
      revealObs.unobserve(entry.target);
    }
  });
}, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
revealEls.forEach(el => {
  el.classList.add('reveal');
  revealObs.observe(el);
});

// Animated counters
const counterObs = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      animateCounter(entry.target);
      counterObs.unobserve(entry.target);
    }
  });
}, { threshold: 0.5 });

document.querySelectorAll('.proof-number').forEach(el => counterObs.observe(el));

function animateCounter(el) {
  const target = parseFloat(el.dataset.target);
  const isDecimal = String(target).includes('.');
  const duration = 1600;
  const start = performance.now();

  function update(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = target * eased;
    el.textContent = isDecimal ? value.toFixed(1) : Math.floor(value).toLocaleString();
    if (progress < 1) requestAnimationFrame(update);
    else el.textContent = isDecimal ? target.toFixed(1) : target.toLocaleString();
  }
  requestAnimationFrame(update);
}

// Contact form
const GOOGLE_SHEET_URL = 'https://script.google.com/macros/s/AKfycbyvhxQ-PIVGv-pa2CE_JNlg2-Gezf7lPR9PZp0IXbGzzCYjOhl6kkfX-fWIH21ie1iy/exec';

const form = document.getElementById('contactForm');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = form.querySelector('button[type="submit"]');
  const origText = btn.textContent;
  btn.textContent = 'Sending...';
  btn.disabled = true;

  const data = {
    firstName: document.getElementById('firstName').value,
    lastName: document.getElementById('lastName').value,
    email: document.getElementById('email').value,
    business: document.getElementById('business').value,
    industry: document.getElementById('industry').value,
    challenge: document.getElementById('challenge').value,
    timestamp: new Date().toISOString(),
  };

  if (GOOGLE_SHEET_URL) {
    try {
      await fetch(GOOGLE_SHEET_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    } catch (err) {
      console.warn('Sheets error:', err);
    }
  }

  try {
    const fd = new FormData(form);
    await fetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fd).toString(),
    });
  } catch (err) {
    console.warn('Netlify error:', err);
  }

  btn.textContent = 'Sent! We\'ll be in touch.';
  btn.style.background = 'oklch(0.55 0.15 145)';
  form.reset();
  setTimeout(() => {
    btn.textContent = origText;
    btn.style.background = '';
    btn.disabled = false;
  }, 4000);
});

// Smooth scroll with nav offset
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', (e) => {
    const id = anchor.getAttribute('href');
    if (id === '#') return;
    const target = document.querySelector(id);
    if (!target) return;
    e.preventDefault();
    const offset = 80;
    const top = target.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top, behavior: 'smooth' });
    if (navMobile.classList.contains('open')) navMobile.classList.remove('open');
  });
});
