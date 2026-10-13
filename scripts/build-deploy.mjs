/* build-deploy.mjs — turn dist/ into the folder the Cloudflare Sites deployment uploads.
 *
 * The Sites manifest describes a prebuilt Worker (worker/worker.js, copied beside the manifest so
 * every path inside it is relative to the manifest itself) plus a static assets directory. Nothing
 * here is committed: deploy/ is build output, exactly like dist/.
 *
 *   npm run build:deploy     # vite build + tracker copy + this
 *   deploy/manifest.json     # what the deployment reads
 */
import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const out = path.join(root, 'deploy');
const publicDir = path.join(out, 'public');

if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/ has no index.html — run `npm run build` first.');
  process.exit(1);
}

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

await rm(out, { recursive: true, force: true });
await mkdir(publicDir, { recursive: true });
await cp(dist, publicDir, { recursive: true });
await cp(path.join(root, 'worker', 'worker.js'), path.join(out, 'worker.js'));
await cp(path.join(root, 'worker', 'api.js'), path.join(out, 'api.js'));

const manifest = {
  entrypoint: 'index.js',
  // Kept in step with wrangler.jsonc — bump both together.
  compatibilityDate: '2026-09-01',
  // Both modules have to be listed: index.js imports './api.js' by name, and an unlisted import
  // fails the upload with a validation error rather than a build error.
  modules: [
    { name: 'index.js', type: 'esm', path: './worker.js' },
    { name: 'api.js', type: 'esm', path: './api.js' },
  ],
  assetsDirectory: './public',
  // Unmatched paths (a bookmarked /app, say) fall back to the landing page instead of 404ing.
  spa: true,
};

await writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const count = (await cpStats(publicDir)) ?? 0;
console.log(`deploy/ ready for ${pkg.name} — ${count} asset entries, manifest + worker copied.`);

/** A cheap file count, so the log says something verifiable about what is about to be uploaded. */
async function cpStats(dir) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { recursive: true });
  return entries.length;
}
