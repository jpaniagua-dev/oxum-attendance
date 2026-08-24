/*
 * Builds a single self-contained page from web/, for publishing as a preview.
 *
 * The kiosk itself is a normal static site with separate files. A preview has
 * to survive as one document with no same-origin siblings, so styles and script
 * are inlined and the service worker is switched off. There is deliberately no
 * second copy of the markup: the preview is the real app on demo data.
 *
 *   node tools/build-preview.mjs   →   dist/preview.html
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('.', import.meta.url)));
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

const html = read('web/index.html');
const css = read('web/app.css');
const js = read('web/app.js');

/** The publishing wrapper supplies doctype, head and body, so take the body only. */
const body = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'))
  .replace(/\s*<script src="config\.js"><\/script>/, '')
  .replace(/\s*<script src="app\.js"><\/script>/, '')
  .trim();

const fonts = html.match(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]+>/)[0];

const page = `<title>Présences Bachata Geneva</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${fonts}
<style>
${css}
</style>

${body}

<script>window.KIOSK_PREVIEW = true;</script>
<script>
${js}
</script>
`;

mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('../dist/preview.html', import.meta.url), page);
console.log(`dist/preview.html — ${(page.length / 1024).toFixed(1)} kB`);
