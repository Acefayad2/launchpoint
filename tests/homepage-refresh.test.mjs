import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const tags = html.match(/<[a-z][^>]*>/gi) || [];
const sha256 = value => createHash('sha256').update(value).digest('hex');

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)]
    .slice(1).map(([, name, double, single, bare]) => [name, double ?? single ?? bare ?? '']));
}

function byId(id) {
  const matches = tags.filter(tag => attributes(tag).id === id);
  assert.equal(matches.length, 1, `exactly one #${id} is present`);
  return attributes(matches[0]);
}

// Visual baselines are unchanged between 2c9e682 and 77c94e0. Freeze their
// presentation, not the intro lifecycle: timing and visibility are tested below
// and in launch-intro.test.mjs so reliability fixes remain intentional.
const frozenFiles = {
  'css/style.css': '1908797bfe7385ca7ca3d6658043fa7d955e69cf54a0a461a71de3818f6a4e63',
  'css/neural-theme.css': 'b8807cfa32324256b53aca170da516d68dbc4df1a0f9c2feaaf5f9c80e26ff08',
  'js/main.js': '68669586204ac288d22857031b4836db8fa766d5c3f1e266af00e1ca60bc2f03',
  'js/hero-webgl.js': '3db61a0db76b0049e0273933e9004d03afd93c1983e6bb1e488fd8c914411b7f',
  'assets/launchpoint-rocket.svg': 'e1aacdbc7627b21409fcad90bd5a462d643cae3e3c3a4e94b033e27b716834a0',
  'assets/template-hero-texture.png': 'f58ba468bf6d3a2c9627178a1837f0f899b37b5dd5e34a00a3e11671cc7a59dc',
  'assets/template-hero-depth.webp': '4dc433ce306f213c0db63b6ead769e11eb0646612d488ed799053c63904b942d',
};

test('homepage preserves the production hero and rocket intro visuals exactly', async () => {
  const blocks = [
    [/\<section class="hero hero-template"[\s\S]*?<\/section>/, '20cb4260beae6898a4f53737891a15a9dd5d342d8671f4fd00a41158f0251720', 'hero markup'],
    [/\<div class="launch-intro" id="launch-intro">[\s\S]*?<\/button>\s*<\/div>/, '592cb08cba0303be22e0782f943128a5870dc178498f0f4d7e3ec3a5567203b8', 'intro markup'],
  ];
  for (const [pattern, expected, label] of blocks) {
    const block = html.match(pattern)?.[0];
    assert.ok(block, `${label} exists`);
    assert.equal(sha256(block), expected, `${label} matches production baseline`);
  }
  for (const [path, expected] of Object.entries(frozenFiles)) {
    const file = await readFile(new URL(`../${path}`, import.meta.url));
    assert.equal(sha256(file), expected, `${path} matches production baseline`);
    if (path.endsWith('.css') || path.endsWith('.js')) {
      assert.ok(tags.some(tag => {
        const { src = '', href = '' } = attributes(tag);
        return (src || href).split('?')[0] === path;
      }), `${path} is still loaded by the homepage`);
    }
  }
  const intro = await readFile(new URL('../js/launch-intro.js', import.meta.url), 'utf8');
  const visualBlocks = [
    [/gl\.shaderSource\(vertex, `[\s\S]*?`\);/, '934750d4335fc0fca4362e4db254ee52cfc6f4e5891bfd2180c993f0fb0bd4c3', 'smoke vertex shader'],
    [/gl\.shaderSource\(fragment, `[\s\S]*?`\);/, '1bc99834229df198b99c7680be635382840606895fd33400d2875d49209185f7', 'smoke fragment shader'],
    [/const progress = Math\.min\(seconds[\s\S]*?ship\.style\.transform = [^\n]+/, '7ed5ce06351e8480980adc64bb6851e02873a306ddc02b5dce69beca811c8787', 'rocket flight curve'],
  ];
  for (const [pattern, expected, label] of visualBlocks) {
    const block = intro.match(pattern)?.[0];
    assert.ok(block, `${label} exists`);
    assert.equal(sha256(block), expected, `${label} matches the approved intro`);
  }
  assert.ok(tags.some(tag => attributes(tag).src?.split('?')[0] === 'js/launch-intro.js'), 'intro controller remains loaded');
});

test('head gate only covers eligible visits and exposes a controller-owned fail-open watchdog', async () => {
  const gate = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(gate, 'the pre-paint startup gate exists');
  for (const { reducedMotion, hash, eligible } of [
    { reducedMotion: false, hash: '', eligible: true },
    { reducedMotion: true, hash: '', eligible: false },
    { reducedMotion: false, hash: '#process', eligible: false },
    { reducedMotion: true, hash: '#contact', eligible: false },
  ]) {
    const classes = new Set();
    const timers = [];
    const window = {
      location: { hash },
      matchMedia: query => {
        assert.equal(query, '(prefers-reduced-motion: reduce)');
        return { matches: reducedMotion };
      },
      setTimeout: (callback, delay) => { timers.push({ callback, delay }); return 123; },
    };
    const document = { documentElement: { classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
    } } };
    runInNewContext(gate, { window, document });
    assert.equal(classes.has('launch-pending'), eligible);
    assert.equal(timers.length, eligible ? 1 : 0);
    assert.equal(window.launchIntroFallback, eligible ? 123 : undefined, 'controller can cancel this exact watchdog');
    if (eligible) {
      assert.equal(timers[0].delay, 5000, 'missing controller cannot hide the page indefinitely');
      timers[0].callback();
      assert.equal(classes.has('launch-pending'), false);
    }
  }
  const controller = await readFile(new URL('../js/launch-intro.js', import.meta.url), 'utf8');
  assert.match(controller, /window\.clearTimeout\(window\.launchIntroFallback\)/, 'controller cancels the head watchdog before managing playback');
  assert.doesNotMatch(controller, /!root\.classList\.contains\('launch-pending'\)/, 'an expired head watchdog does not suppress a still-eligible intro');
});

test('homepage preserves approved sections and the button-free service strip', async () => {
  const sectionStart = html.indexOf('  <div class="home-v2">');
  const sectionEnd = html.indexOf('</main>') + '</main>'.length;
  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart);
  assert.equal(sha256(html.slice(sectionStart, sectionEnd)), '09327acf0d3d1a79cf247bed6b16136ed617f2bcc8e4b2d374751c269cf9193b', 'all sections after the hero preserve the approved content and button-free strip');
  assert.equal(sha256(html.match(/<footer\b[\s\S]*?<\/footer>/)?.[0]), '21a4572ccb4a98727ac37ebabefc02c906b06d3ae8ac258cefc31e742c11f8ab', 'footer retains Studio access');
  const css = await readFile(new URL('../css/homepage-v2.css', import.meta.url), 'utf8');
  const sectionStyles = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\.nav[^{}]*\{[^}]*\}/gm, '').replace(/\s+/g, ' ').trim();
  assert.equal(sha256(sectionStyles), '196f1d20e110e9e137c97f81a9028a446c14c203143a7030a0b9ba19a325be93', 'section styles preserve the approved layout and button-free strip');
  const script = await readFile(new URL('../js/homepage-v2.js', import.meta.url));
  assert.equal(sha256(script), '5f563cb504d44cb8087b5fbda0eddb13d202a0bc87859c8b04e77ae5c22d48d5', 'revolving service animation remains independent of the removed control');
});

test('header is translucent white over both hero and light sections with readable controls', async () => {
  const css = await readFile(new URL('../css/homepage-v2.css', import.meta.url), 'utf8');
  const headerRule = css.match(/\.nav,\s*\.nav\.nav-on-light\s*\{([^}]+)\}/)?.[1];
  assert.ok(headerRule, 'the same header appearance applies before and after scrolling');
  assert.match(headerRule, /background:\s*rgb\(255 255 255\s*\/\s*88%\)/);
  assert.match(headerRule, /(?:^|;)\s*backdrop-filter:\s*blur\(24px\)\s+saturate\(140%\)/);
  assert.match(headerRule, /-webkit-backdrop-filter:\s*blur\(24px\)\s+saturate\(140%\)/, 'Safari receives the glass treatment');
  assert.match(css, /\.nav \.nav-links a\s*\{[^}]*color:\s*#2a2f33;/);
  assert.match(css, /\.nav \.nav-cta\s*\{[^}]*background:\s*#16181a;[^}]*color:\s*#fff;/);
  assert.match(css, /\.nav \.nav-toggle span\s*\{[^}]*background:\s*#111315;/);
  assert.match(css, /\.nav \.nav-mobile\s*\{[^}]*background:\s*rgb\(255 255 255\s*\/\s*97%\)/);
});

test('new homepage styling is isolated below the preserved hero and intro', async () => {
  const wrapper = tags.find(tag => attributes(tag).class?.split(/\s+/).includes('home-v2'));
  assert.ok(wrapper, 'redesigned sections have a scoped .home-v2 wrapper');
  const heroEnd = html.indexOf('</section>', html.indexOf('class="hero hero-template"'));
  assert.ok(html.indexOf(wrapper) > heroEnd, 'the hero is outside the redesign wrapper');
  const css = (await readFile(new URL('../css/homepage-v2.css', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /\.hero(?:[-\s.:#>\[,{]|$)|#hero-|\.launch-intro|\.launch-pending/,
    'new stylesheet does not override hero or intro selectors');
  assert.doesNotMatch(css, /(?:^|[{},])\s*(?::root|html|body)(?=[\s.:#>\[,{]|$)/m,
    'new stylesheet does not change inherited document styles');
});

test('quote form keeps its Netlify contract, field names, validation, and status semantics', () => {
  const form = byId('contactForm');
  assert.equal(form.method.toUpperCase(), 'POST');
  assert.equal(form.name, 'launchpoint-inquiries');
  assert.equal(form['data-netlify'], 'true');
  assert.equal(form['data-netlify-honeypot'], 'bot-field');
  const formMarkup = html.match(/<form\b[^>]*\bid="contactForm"[\s\S]*?<\/form>/)?.[0];
  assert.ok(formMarkup, 'the submission controls remain inside the quote form');
  const controls = (formMarkup.match(/<(?:input|select|textarea|button)\b[^>]*>/gi) || []).map(attributes);
  assert.ok(controls.some(item => item.name === 'form-name' && item.type === 'hidden' && item.value === form.name));
  assert.ok(controls.some(item => item.name === 'bot-field' && item.tabindex === '-1'));
  for (const id of ['firstName', 'lastName', 'email', 'business', 'industry', 'challenge']) {
    const field = byId(id);
    assert.equal(field.name, id);
    assert.ok(controls.some(item => item.id === id), `#${id} is a submitted form control`);
    assert.ok(tags.some(tag => tag.startsWith('<label') && attributes(tag).for === id), `#${id} has a label`);
    if (id !== 'challenge') assert.ok(Object.hasOwn(field, 'required'), `#${id} remains required`);
  }
  assert.equal(byId('email').type, 'email');
  const services = controls.filter(item => item.name === 'services');
  assert.deepEqual(services.map(item => item.value).sort(), ['Photography', 'Reviews', 'SEO & Ads', 'Social Media', 'Website']);
  assert.ok(services.every(item => item.type === 'checkbox'));
  assert.equal(controls.filter(item => item.type === 'submit').length, 1);
  assert.match(formMarkup, /<button\b[^>]*type="submit"[^>]*>\s*Get quote now\s*<\/button>/i);
  assert.equal(byId('formStatus').role, 'status');
  assert.equal(byId('formStatus')['aria-live'], 'polite');
});

test('navigation and in-page links keep unique destinations and accessible mobile controls', () => {
  for (const id of ['main-content', 'services', 'process', 'proof', 'quote', 'contact']) byId(id);
  const toggle = byId('navToggle');
  assert.equal(toggle['aria-controls'], 'navMobile');
  assert.equal(toggle['aria-expanded'], 'false');
  assert.ok(toggle['aria-label']);
  assert.ok(byId('navMobile').class.split(/\s+/).includes('nav-mobile'));
  assert.ok(tags.some(tag => attributes(tag).class?.split(/\s+/).includes('nav-logo')), 'intro skip can restore focus to the logo');
  for (const tag of tags.filter(tag => tag.startsWith('<a'))) {
    const { href = '' } = attributes(tag);
    if (href.startsWith('#') && href.length > 1) byId(href.slice(1));
  }
});

test('homepage remains quote-based without public pricing or fabricated metric counters', () => {
  const text = html.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  assert.doesNotMatch(text, /[$£€]\s*\d|\b\d[\d,.]*\s*(?:USD|GBP|EUR)\b/i, 'no fixed public prices are advertised');
  assert.doesNotMatch(text, /\b\d[\d,.]*\s*%\s*(?:growth|increase|more|satisfaction)|\b\d[\d,.]*\+?\s+(?:happy clients|businesses served|satisfied customers)\b/i,
    'no unsupported numeric performance or client-count claims');
  for (const tag of tags) {
    const attrs = attributes(tag);
    assert.notEqual(attrs.id, 'pricing', 'pricing section stays removed');
    assert.ok(!Object.hasOwn(attrs, 'data-target'), 'no animated metric target is reintroduced');
    assert.ok(!attrs.class?.split(/\s+/).some(name => /^pricing(?:-|$)|^proof-number$/.test(name)), 'no pricing cards or metric counters');
  }
});

test('homepage accent text and quote-band copy retain accessible contrast against white', async () => {
  const css = await readFile(new URL('../css/homepage-v2.css', import.meta.url), 'utf8');
  const colors = [
    ['accent', css.match(/--v2-accent:\s*(#[\da-f]{6})\s*;/i)?.[1]],
    ['quote band', css.match(/\.home-v2 \.v2-band\s*\{[^}]*\bbackground:\s*(#[\da-f]{6})\s*;/i)?.[1]],
  ];
  for (const [label, hex] of colors) {
    assert.ok(hex, `${label} has an explicit six-digit color`);
    const channels = hex.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255)
      .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
    const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    const contrast = 1.05 / (luminance + .05);
    assert.ok(contrast >= 4.5, `${label} ${hex} needs 4.5:1 contrast with white; measured ${contrast.toFixed(3)}:1`);
  }
});

test('homepage has one production canonical and real services in static HTML', () => {
  const canonicals = tags.filter(tag => tag.startsWith('<link') && attributes(tag).rel === 'canonical');
  assert.equal(canonicals.length, 1, 'only one canonical URL is advertised');
  assert.equal(attributes(canonicals[0]).href, 'https://mylaunch.dev/');
  const list = html.match(/<ul\b[^>]*class="v2-orbit-list"[^>]*>([\s\S]*?)<\/ul>/)?.[1];
  assert.ok(list, 'service text is present before JavaScript runs');
  assert.deepEqual([...list.matchAll(/<li>([^<]+)<\/li>/g)].map(match => match[1]), [
    'Website design', 'Local SEO', 'Google Ads', 'Review cards', 'Social media', 'Photography', 'Client dashboards',
  ]);
  assert.equal(byId('service-orbit').role, 'region');
  assert.equal(byId('service-orbit')['aria-label'], 'LaunchPoint services');
});

test('footer exposes the existing Studio sign-in without promoting it to search engines', () => {
  const footer = html.match(/<footer\b[\s\S]*?<\/footer>/)?.[0];
  assert.ok(footer);
  const links = (footer.match(/<a\b[^>]*>/g) || []).map(attributes)
    .filter(link => link.class?.split(/\s+/).includes('footer-studio'));
  assert.equal(links.length, 1);
  assert.equal(links[0].href, '/dashboard.html');
  assert.ok(links[0].rel.split(/\s+/).includes('nofollow'));
  assert.match(footer, />Studio \/ Dashboard\s*<span\b[^>]*aria-hidden="true"/);
});

test('service animation works without a button and still pauses offscreen or in a hidden page', async () => {
  assert.doesNotMatch(html, /v2-orbit-toggle|Pause service animation|Resume service animation/);
  assert.equal(byId('service-orbit').tabindex, '0', 'keyboard users can focus the strip to pause movement');
  byId('service-orbit-track');

  const classes = new Set();
  const listeners = {};
  const observers = [];
  const duplicateAttributes = {};
  const duplicate = { setAttribute: (name, value) => { duplicateAttributes[name] = value; } };
  const strip = {
    classList: {
      add: name => classes.add(name),
      toggle(name, force = !classes.has(name)) {
        force ? classes.add(name) : classes.delete(name);
        return force;
      },
    },
  };
  const track = {
    querySelector: () => ({ cloneNode: () => duplicate }),
    append: node => assert.equal(node, duplicate),
  };
  const document = {
    hidden: false,
    querySelector: () => null,
    getElementById: id => ({ 'service-orbit': strip, 'service-orbit-track': track })[id],
    addEventListener: (name, callback) => { listeners[name] = callback; },
  };
  class IntersectionObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(node) { assert.equal(node, strip); }
  }
  const script = await readFile(new URL('../js/homepage-v2.js', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /v2-orbit-toggle|is-paused/, 'no removed-button dependency or state remains');
  runInNewContext(script, { document, window: { IntersectionObserver }, IntersectionObserver });
  assert.equal(duplicateAttributes['aria-hidden'], 'true');
  assert.ok(classes.has('is-orbit-ready'), 'animation initializes without a pause button');
  assert.ok(!classes.has('is-page-hidden'));
  document.hidden = true;
  listeners.visibilitychange();
  assert.ok(classes.has('is-page-hidden'));
  document.hidden = false;
  listeners.visibilitychange();
  assert.ok(!classes.has('is-page-hidden'));
  assert.equal(observers.length, 1);
  observers[0].callback([{ isIntersecting: false }]);
  assert.ok(classes.has('is-offscreen'));
  observers[0].callback([{ isIntersecting: true }]);
  assert.ok(!classes.has('is-offscreen'));
});

test('service animation falls back to a readable static list for reduced motion', async () => {
  const css = await readFile(new URL('../css/homepage-v2.css', import.meta.url), 'utf8');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.v2-orbit-track\s*\{[^}]*animation:\s*none;[^}]*transform:\s*none;/);
  assert.match(reduced, /\.v2-orbit-list\s*\{[^}]*flex-wrap:\s*wrap;/);
  assert.match(reduced, /\.v2-orbit-window\s*\{[^}]*overflow:\s*visible;[^}]*mask-image:\s*none;/);
  assert.match(reduced, /\.v2-orbit-list\[aria-hidden="true"\]\s*\{\s*display:\s*none;/);
  assert.doesNotMatch(css, /v2-orbit-toggle|is-paused/);
  assert.match(css, /\.v2-orbit-window:hover \.v2-orbit-track,\s*\.home-v2 \.v2-strip:focus-within \.v2-orbit-track,\s*\.home-v2 \.v2-strip:is\(\.is-offscreen,\s*\.is-page-hidden\) \.v2-orbit-track\s*\{\s*animation-play-state:\s*paused;/);
  assert.match(css, /\.v2-strip:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--v2-accent\)/, 'keyboard focus remains visible');
});
