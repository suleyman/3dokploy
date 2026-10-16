import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // In dev the relay (server/index.ts, port 3000) runs next to Vite; in production it also serves
    // the app. 127.0.0.1, not localhost: another app may hold [::1] on the same port.
    proxy: Object.fromEntries(
      ['/relay', '/config'].map((p) => [p, { target: `http://127.0.0.1:${process.env.PORT ?? 3000}`, changeOrigin: true }]),
    ),
  },
});
