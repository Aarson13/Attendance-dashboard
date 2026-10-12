/* copy-tracker.mjs — the tracker (app.html + its plain CSS/JS) deliberately has no build step, so the
 * home page's postbuild step copies those files into dist/ next to the built landing page. Serving
 * dist/ then gives the whole site: the home page at / and the tracker at /app.html.
 *
 * Run: node scripts/copy-tracker.mjs   (npm run build does it for you)
 */
import { cp, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const FILES = ['app.html', 'styles.css', 'sw.js', 'manifest.webmanifest', 'icon.svg', '_headers'];
const DIRS = ['js', 'data', 'samples'];

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(dist))) {
  console.error('dist/ not found — run `npm run build` (vite build) first.');
  process.exit(1);
}

let copied = 0;
for (const file of FILES) {
  await cp(path.join(root, file), path.join(dist, file));
  copied++;
}
for (const dir of DIRS) {
  await cp(path.join(root, dir), path.join(dist, dir), { recursive: true });
  copied++;
}

console.log(`copied the tracker into dist/ (${FILES.length} files, ${DIRS.join(', ')}) — the site is ready to serve`);
