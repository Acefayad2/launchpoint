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

// Fixed SHA-256 values from production baseline 2c9e682. These guards need no
// Git executable and protect the hero, its inherited styles, and the intro.
const frozenFiles = {
  'css/style.css': '1908797bfe7385ca7ca3d6658043fa7d955e69cf54a0a461a71de3818f6a4e63',
  'css/neural-theme.css': 'b8807cfa32324256b53aca170da516d68dbc4df1a0f9c2feaaf5f9c80e26ff08',
  'js/main.js': '68669586204ac288d22857031b4836db8fa766d5c3f1e266af00e1ca60bc2f03',
  'js/hero-webgl.js': '3db61a0db76b0049e0273933e9004d03afd93c1983e6bb1e488fd8c914411b7f',
  'js/launch-intro.js': '0b780dabd715d2e80911a3431a808e1ba880284ec409ec9cd5b73e51129575e0',
  'assets/launchpoint-rocket.svg': 'e1aacdbc7627b21409fcad90bd5a462d643cae3e3c3a4e94b033e27b716834a0',
  'assets/template-hero-texture.png': 'f58ba468bf6d3a2c9627178a1837f0f899b37b5dd5e34a00a3e11671cc7a59dc',
  'assets/template-hero-depth.webp': '4dc433ce306f213c0db63b6ead769e11eb0646612d488ed799053c63904b942d',
};

test('homepage refresh preserves the production hero and rocket intro exactly', async () => {
  const blocks = [
    [/\<section class="hero hero-template"[\s\S]*?<\/section>/, '20cb4260beae6898a4f53737891a15a9dd5d342d8671f4fd00a41158f0251720', 'hero markup'],
    [/\<div class="launch-intro" id="launch-intro">[\s\S]*?<\/button>\s*<\/div>/, '592cb08cba0303be22e0782f943128a5870dc178498f0f4d7e3ec3a5567203b8', 'intro markup'],
    [/<script>[\s\S]*?<\/script>/, '2b9f4d3ee274eeff0ce8bb58e8c848b320e9ae73125808e62eada2cc2b27c511', 'intro startup gate'],
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

test('service animation has an accessible working pause control and hides its duplicate', async () => {
  const controlTag = tags.find(tag => attributes(tag).class?.split(/\s+/).includes('v2-orbit-toggle'));
  const control = attributes(controlTag);
  assert.ok(controlTag.startsWith('<button'));
  assert.equal(control.type, 'button');
  assert.equal(control['aria-controls'], 'service-orbit-track');
  assert.equal(control['aria-label'], 'Pause service animation');
  assert.ok(Object.hasOwn(control, 'hidden'), 'no inactive pause control is shown when JavaScript is unavailable');
  byId(control['aria-controls']);

  const classes = new Set();
  const listeners = {};
  const duplicateAttributes = {};
  const duplicate = { setAttribute: (name, value) => { duplicateAttributes[name] = value; } };
  const icon = { textContent: 'Ⅱ' };
  const button = {
    hidden: true,
    firstChild: { textContent: 'Pause ' },
    setAttribute: (name, value) => { control[name] = value; },
    querySelector: () => icon,
    addEventListener: (name, callback) => { listeners[name] = callback; },
  };
  const strip = {
    querySelector: () => button,
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
    addEventListener: () => {},
  };
  const script = await readFile(new URL('../js/homepage-v2.js', import.meta.url), 'utf8');
  runInNewContext(script, { document, window: {} });
  assert.equal(duplicateAttributes['aria-hidden'], 'true');
  assert.equal(button.hidden, false);
  listeners.click();
  assert.ok(classes.has('is-paused'));
  assert.equal(control['aria-label'], 'Resume service animation');
  assert.equal(button.firstChild.textContent, 'Play ');
  listeners.click();
  assert.ok(!classes.has('is-paused'));
  assert.equal(control['aria-label'], 'Pause service animation');
  assert.equal(button.firstChild.textContent, 'Pause ');
});

test('service animation falls back to a readable static list for reduced motion', async () => {
  const css = await readFile(new URL('../css/homepage-v2.css', import.meta.url), 'utf8');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.v2-orbit-track\s*\{[^}]*animation:\s*none;[^}]*transform:\s*none;/);
  assert.match(reduced, /\.v2-orbit-list\s*\{[^}]*flex-wrap:\s*wrap;/);
  assert.match(reduced, /\.v2-orbit-window\s*\{[^}]*overflow:\s*visible;[^}]*mask-image:\s*none;/);
  assert.match(reduced, /\.v2-orbit-list\[aria-hidden="true"\],\s*\.home-v2 \.v2-orbit-toggle\s*\{\s*display:\s*none;/);
  assert.match(css, /\.v2-strip:is\(\.is-paused,\s*\.is-offscreen,\s*\.is-page-hidden\) \.v2-orbit-track\s*\{\s*animation-play-state:\s*paused;/);
});
