import react from '@vitejs/plugin-react';
import wyw from '@wyw-in-js/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), wyw()],
});
