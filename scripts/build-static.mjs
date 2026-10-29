import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Publish only browser assets; backend functions are bundled separately by Netlify.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of await readdir(root, { withFileTypes: true })) {
  const publicDirectory = entry.isDirectory() && ['assets', 'css', 'js'].includes(entry.name);
  const publicFile = entry.isFile() && (/\.html$/.test(entry.name)
    || ['robots.txt', 'sitemap.xml', 'favicon.ico', 'manifest.webmanifest', '_headers', '_redirects'].includes(entry.name));
  if (publicDirectory || publicFile) await cp(path.join(root, entry.name), path.join(output, entry.name), { recursive: true });
}
console.log('Built public website in dist; server code and private working files excluded.');
