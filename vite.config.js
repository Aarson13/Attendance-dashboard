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
    // The tracker lives at /app.html in dev too — no copy step needed while developing.
    open: false,
  },
});
