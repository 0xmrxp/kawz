import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://lobre.lat',
  output: 'static',
  vite: {
    plugins: [tailwindcss()],
  },
});
