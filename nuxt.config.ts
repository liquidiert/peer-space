import { defineNuxtConfig } from 'nuxt/config';

// Nuxt 4 Configuration
export default defineNuxtConfig({
  compatibilityDate: '2026-01-01',
  future: {
    compatibilityVersion: 4,
  },
  devtools: { enabled: false },
  css: ['~/src/index.css'],
  modules: [],
});
