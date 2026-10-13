import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The home page is a Vite + React app; the attendance tracker next to it (app.html + js/ + styles.css)
 * stays plain HTML/CSS/JS with no build step, and `scripts/copy-tracker.mjs` drops those files into
 * the same dist/ folder. `base: './'` keeps every asset URL relative, so the built site works from a
 * sub-path as happily as from the domain root.
 */
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
  },
  server: {
    port: 5173,
    // The tracker lives at /app.html in dev too — no copy step needed while developing. Its built-in
    // sync talks to /api on this origin, so in dev that is proxied to `npm run dev:api` (wrangler dev
    // on 8787, with a local D1) next door; with nothing listening there, sync reports a network error.
    proxy: { '/api': 'http://127.0.0.1:8787' },
    open: false,
  },
});
