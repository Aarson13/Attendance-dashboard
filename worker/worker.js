/* worker.js — the site's only Worker: the sync API first, the static site after it.
 *
 * Before Netlify this was a folder of files; it still is, and env.ASSETS serves exactly those files
 * (index.html, app.html, js/, assets/…). What the Worker adds is (a) /api/* — the D1-backed sync
 * described in api.js — and (b) the headers that used to travel in `_headers`, applied here so they
 * are sent no matter which asset layer answers. `env.ASSETS.fetch(request)` runs the same asset
 * matching (including the SPA fallback to index.html) that a plain static host would.
 */

import { handleApi } from './api.js';

// The one third-party origin in either policy is the host's own Cloudflare Insights beacon: the
// platform injects it into served pages to meter usage, so blocking it (as an earlier, stricter
// policy did) leaves the platform unable to account for the site and it suspends serving.
const TRACKER_CSP = "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://static.cloudflareinsights.com 'wasm-unsafe-eval'; worker-src 'self' blob: https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' data: blob: https://api.github.com https://cdn.jsdelivr.net https://tessdata.projectnaptha.com https://cloudflareinsights.com; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const LANDING_CSP = "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://cloudflareinsights.com; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; worker-src 'self'";

function securityHeaders(pathname, res) {
  const headers = new Headers(res.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Frame-Options', 'DENY');
  if (!headers.has('Content-Security-Policy') && /text\/html/.test(headers.get('Content-Type') || '')) {
    // `/app.html` answers a 307 to `/app` (the asset layer's clean-URL rule, which the tracker
    // already expects), so the tracker's policy has to cover both spellings — including the
    // redirect response itself.
    const tracker = pathname.endsWith('/app.html') || /\/app$/.test(pathname);
    headers.set('Content-Security-Policy', tracker ? TRACKER_CSP : LANDING_CSP);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env);
      } catch (err) {
        return new Response(JSON.stringify({ error: 'server', message: 'The sync service hit an unexpected error.' }), {
          status: 500,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
    }

    const asset = await env.ASSETS.fetch(request);
    return securityHeaders(url.pathname, asset);
  },
};
