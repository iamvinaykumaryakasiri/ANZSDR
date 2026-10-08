import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The console is a static bundle (web/dist) that talks to /api/console on the
// same origin. In dev, /api is proxied to the Fastify server. src/web/start.ts
// listens on PORT (default 8080), so that is the default target. The
// `fixture` mode points at the dev-only fixture server instead
// (`npm run fixture`, then `npm run dev:fixture`).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_API_TARGET || 'http://localhost:8080';
  return {
    plugins: [react(), tailwindcss()],
    build: {
      outDir: 'dist',
      sourcemap: false,
      target: 'es2022'
    },
    server: {
      port: 5173,
      proxy: {
        '/api': { target, changeOrigin: false }
      }
    },
    preview: {
      port: 4173,
      proxy: {
        '/api': { target, changeOrigin: false }
      }
    }
  };
});
