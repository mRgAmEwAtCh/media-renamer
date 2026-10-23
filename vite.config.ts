import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const web = path.resolve(import.meta.dirname, 'web');

// The web UI: `npm run build` writes it to dist/web, which server.ts serves.
// `npm run dev` serves it with hot reload and forwards API calls to `npm start` on port 4173.
export default defineConfig({
  root: web,
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/web'),
    emptyOutDir: true,
    // The server reads the manifest to know which files the login page needs.
    manifest: true,
    rolldownOptions: {
      input: { index: path.join(web, 'index.html'), login: path.join(web, 'login.html') },
      // React is shared by both pages; give its chunk a recognisable name.
      output: { codeSplitting: { groups: [{ name: 'react', test: /node_modules/ }] } },
    },
  },
  server: {
    proxy: { '/api': 'http://127.0.0.1:4173' },
  },
});
