import react from '@vitejs/plugin-react';
import wyw from '@wyw-in-js/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: 'index.perf.html',
    },
  },
  plugins: [
    react(),
    wyw({
      debug: { dir: 'perf-debug', print: true },
      include: ['src/__perf__/**/*.{ts,tsx}'],
    }),
  ],
});

