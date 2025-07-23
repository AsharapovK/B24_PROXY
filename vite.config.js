import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vuetify from "vite-plugin-vuetify";

export default defineConfig({
  plugins: [vue(), vuetify()],
  server: {
    host: '0.0.0.0',
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7777",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
