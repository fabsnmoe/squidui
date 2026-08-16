import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dev server proxies /api to the API container, so the browser talks to a
 * single origin in development exactly as it does in production behind nginx.
 * That keeps CORS out of the picture entirely.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // A control plane is not latency critical; a couple of well cached chunks
    // beat aggressive splitting.
    chunkSizeWarningLimit: 900,
  },
});
