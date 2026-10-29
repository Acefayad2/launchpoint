import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';

test('production publish directory contains browser files only', async () => {
  await import('../scripts/build-static.mjs');
  const entries = await readdir(new URL('../dist/', import.meta.url));
  for (const file of ['index.html', 'dashboard.html', 'client.html', 'assets', 'css', 'js']) assert.ok(entries.includes(file));
  for (const file of ['netlify', 'supabase', 'tests', 'output', 'scripts', '.env', 'package.json', 'google-apps-script.js']) assert.ok(!entries.includes(file), `${file} must not be publicly deployed`);
  assert.equal(await readFile(new URL('../dist/dashboard.html', import.meta.url), 'utf8'), await readFile(new URL('../dashboard.html', import.meta.url), 'utf8'));
  await access(new URL('../dist/js/supabase-config.js', import.meta.url));
  const config = await readFile(new URL('../netlify.toml', import.meta.url), 'utf8');
  assert.match(config, /publish = "dist"/);
  assert.match(config, /command = "npm run build"/);
  for (const route of ['/admin-setup', '/admin-setup.html', '/dashboard', '/dashboard.html']) {
    const header = config.split('[[headers]]').find(block => block.includes(`for = "${route}"`));
    assert.ok(header, `Security headers must cover ${route}`);
    assert.match(header, /Cache-Control = "no-store"/);
    assert.match(header, /Referrer-Policy = "no-referrer"/);
    assert.match(header, /X-Robots-Tag = "noindex, nofollow"/);
  }
});
