import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vuetify from "vite-plugin-vuetify";

export default defineConfig({
  plugins: [vue(), vuetify()],
  server: {
    host: '0.0.0.0',
    proxy: {
      "/api": {
        target: "http://45.131.183.17:7777",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
