/* LaunchPoint — Main JS */

// Nav scroll effect
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 20);
}, { passive: true });

// Mobile nav toggle
const navToggle = document.getElementById('navToggle');
const navMobile = document.getElementById('navMobile');
navToggle.addEventListener('click', () => {
  navMobile.classList.toggle('open');
});

document.querySelectorAll('.nav-mobile a').forEach(link => {
  link.addEventListener('click', () => navMobile.classList.remove('open'));
});

// Scroll reveal
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.12, rootMargin: '0px 0px -60px 0px' });

document.querySelectorAll('.solution-card, .testimonial, .step, .pricing-card, .stat-block, .compare-col').forEach((el, i) => {
  el.classList.add('reveal');
  if (i % 3 === 1) el.classList.add('reveal-delay-1');
  if (i % 3 === 2) el.classList.add('reveal-delay-2');
  revealObserver.observe(el);
});

// Animated counters
const counterObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      animateCounter(entry.target);
      counterObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.5 });

document.querySelectorAll('.stat-block').forEach(el => counterObserver.observe(el));

function animateCounter(block) {
  const countEl = block.querySelector('.count');
  if (!countEl) return;
  const target = parseFloat(block.dataset.count);
  const decimals = parseInt(block.dataset.decimal || '0');
  const duration = 1800;
  const start = performance.now();

  function update(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = target * eased;
    countEl.textContent = decimals > 0
      ? value.toFixed(decimals)
      : Math.floor(value).toLocaleString();
    if (progress < 1) requestAnimationFrame(update);
    else countEl.textContent = decimals > 0 ? target.toFixed(decimals) : target.toLocaleString();
  }

  requestAnimationFrame(update);
}

// Pricing toggle
const billingToggle = document.getElementById('billingToggle');
const monthlyLabel = document.getElementById('monthlyLabel');
const annualLabel = document.getElementById('annualLabel');
let isAnnual = false;

billingToggle.addEventListener('click', () => {
  isAnnual = !isAnnual;
  billingToggle.classList.toggle('on', isAnnual);
  monthlyLabel.classList.toggle('active', !isAnnual);
  annualLabel.classList.toggle('active', isAnnual);

  document.querySelectorAll('.price-amount').forEach(el => {
    const monthly = el.dataset.monthly;
    const annual = el.dataset.annual;
    const target = isAnnual ? annual : monthly;
    animatePrice(el, target);
  });
});

function animatePrice(el, targetStr) {
  const target = parseInt(targetStr.replace(/,/g, ''));
  const start = parseInt(el.textContent.replace(/[^0-9]/g, '')) || 0;
  const duration = 400;
  const startTime = performance.now();

  function update(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 2);
    const val = Math.round(start + (target - start) * eased);
    el.textContent = '$' + val.toLocaleString();
    if (progress < 1) requestAnimationFrame(update);
  }

  requestAnimationFrame(update);
}

// Contact form → Google Sheets via Apps Script
// Replace this URL after deploying your Apps Script (see google-apps-script.js)
const GOOGLE_SHEET_URL = 'PASTE_YOUR_APPS_SCRIPT_URL_HERE';

const form = document.getElementById('contactForm');
const formSuccess = document.getElementById('formSuccess');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = form.querySelector('button[type="submit"]');
  btn.textContent = 'Sending…';
  btn.disabled = true;

  const data = {
    firstName: form.querySelector('input[placeholder="John"]').value,
    lastName:  form.querySelector('input[placeholder="Smith"]').value,
    email:     form.querySelector('input[type="email"]').value,
    business:  form.querySelector('input[placeholder="Smith & Co."]').value,
    industry:  form.querySelector('select').value,
    challenge: form.querySelector('textarea').value,
    timestamp: new Date().toISOString(),
  };

  // Submit to Google Sheets (if configured)
  if (GOOGLE_SHEET_URL && GOOGLE_SHEET_URL !== 'PASTE_YOUR_APPS_SCRIPT_URL_HERE') {
    try {
      await fetch(GOOGLE_SHEET_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    } catch (err) {
      console.warn('Sheets submission error:', err);
    }
  }

  // Also submit to Netlify Forms
  try {
    const netlifyData = new FormData(form);
    await fetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(netlifyData).toString(),
    });
  } catch (err) {
    console.warn('Netlify Forms error:', err);
  }

  form.style.display = 'none';
  formSuccess.style.display = 'block';
});

// Scale bars animation
const scaleObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.querySelectorAll('.scale-bar').forEach((bar, i) => {
        const target = bar.style.width;
        bar.style.width = '0%';
        setTimeout(() => { bar.style.width = target; }, i * 150);
      });
      scaleObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.3 });

document.querySelectorAll('.scale-metrics').forEach(el => scaleObserver.observe(el));

// Smooth anchor scroll with offset
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', (e) => {
    const target = document.querySelector(anchor.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    const offset = 80;
    const top = target.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top, behavior: 'smooth' });
  });
});

// Dashboard bar hover micro-interaction
document.querySelectorAll('.chart-bar').forEach(bar => {
  bar.addEventListener('mouseenter', () => {
    bar.style.opacity = '0.85';
    bar.style.transform = 'scaleY(1.04)';
    bar.style.transformOrigin = 'bottom';
  });
  bar.addEventListener('mouseleave', () => {
    bar.style.opacity = '';
    bar.style.transform = '';
  });
});
