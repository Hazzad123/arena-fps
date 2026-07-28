import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: 'client',
  publicDir: false,
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // shared/ lives outside the vite root, so it has to be explicitly allowed
    fs: { allow: [root] },
    proxy: {
      '/ws': { target: 'ws://localhost:3000', ws: true },
      '/api': { target: 'http://localhost:3000' },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
